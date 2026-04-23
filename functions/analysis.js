// ═══ Gumax — Skin Analysis Endpoint (stack híbrida) ═══
// POST /api/analysis { name, depth, uid? }
//   depth: "basic"   (free após login)
//            - Skinport + Steam Market → score + spread + tendência própria
//          "full"    (2 créditos)
//            - Tudo de basic + breakdown por plataforma + recomendação híbrida
//            - Gumax Shield (refund se cair ≤5% em 48h)
//            - Se Pricempire estiver disponível, enriquece com dados BUFF/DMarket
//          "history" (2 créditos)
//            - Curva histórica (snapshots próprios dos últimos 30d + fallback Pricempire)
//
// Fontes de dados:
//   • Skinport API (gratuita, bulk) → preço base e volume
//   • Steam Community Market (priceoverview, cache 24h) → lowest/median/volume Steam
//   • Firestore price_snapshots (nosso) → histórico próprio
//   • Pricempire (opcional, se PRICEMPIRE_API_KEY setado) → enriquecimento no tier full
//
// Race-condition: créditos são debitados APÓS fetch bem-sucedido. Se upstream
// falhar, o usuário não é cobrado. Cache por skin evita cobrar duplicado.

const admin = require('firebase-admin');
const { consume } = require('./credits');
const { getSkinportItem } = require('./skinport');
const { getSteamPrice } = require('./steam-market');
const { getHistoryForSkin, classifyInternalTrend } = require('./price-history');

// Custos (mantenha sincronizado com o que a UI mostra)
const COSTS = {
  basic: 0,
  full: 2,
  history: 2,
  alert: 3,
};

// Gumax Shield: refund se cair ≤5% em 48h
const SHIELD_MAX_DROP_PCT = 5;
const SHIELD_WINDOW_MS = 48 * 60 * 60 * 1000;

// Cache TTL do resultado final da análise (reduz cobrança duplicada + latência)
const CACHE_TTL_MS = 15 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

function rd(v, places = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, places);
  return Math.round(v * m) / m;
}

async function verifyIdToken(headers) {
  const auth = headers?.authorization || headers?.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7);
  try { return await admin.auth().verifyIdToken(token); }
  catch { return null; }
}

// ── Exchange rate USD→BRL + CNY→BRL ───────────────────────────────────────
async function fetchUsdBrl() {
  if (global._usdRateCache && Date.now() - global._usdRateCache.ts < 60 * 60 * 1000) {
    return global._usdRateCache.value;
  }
  try {
    const resp = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 5000 });
    const data = await resp.json();
    const rate = data.rates?.BRL || 5.1;
    global._usdRateCache = { value: rate, ts: Date.now() };
    return rate;
  } catch { return global._usdRateCache?.value || 5.1; }
}

async function fetchCnyBrl() {
  if (global._cnyRateCache && Date.now() - global._cnyRateCache.ts < 60 * 60 * 1000) {
    return global._cnyRateCache.value;
  }
  try {
    const resp = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', { timeout: 5000 });
    const data = await resp.json();
    const rate = data.rates?.BRL || 0.68;
    global._cnyRateCache = { value: rate, ts: Date.now() };
    return rate;
  } catch { return global._cnyRateCache?.value || 0.68; }
}

// ── Pricempire opcional (só se chave estiver configurada) ─────────────────
async function fetchPricempireDetail(skinName) {
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch(
      `https://api.pricempire.com/v4/cs2/item/${encodeURIComponent(skinName)}`,
      { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'Gumax-Backend/1.0' }, timeout: 10000 }
    );
    if (resp.status === 429) {
      console.log('[Analysis] Pricempire rate limit hit');
      return null;
    }
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.log('[Analysis] Pricempire error:', e.message);
    return null;
  }
}

async function fetchPricempireHistory(skinName) {
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch(
      `https://api.pricempire.com/v4/cs2/item/${encodeURIComponent(skinName)}/history?days=30`,
      { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'Gumax-Backend/1.0' }, timeout: 12000 }
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// ── Score computation a partir da stack híbrida ────────────────────────────
// Entra: { skinportUSD, steamBRL, pricempireCNY?, usdRate, cnyRate }
// Converte tudo pra BRL e calcula score/spread.
function computeScore(prices) {
  // prices: { [platform]: valueBRL }
  const entries = Object.entries(prices).filter(([, v]) => v != null && v > 0);
  if (entries.length < 2) return null;

  const values = entries.map(([, v]) => v);
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;

  if (lowest === 0 || highest === lowest) {
    return { score: 50, spread: 0, lowest, highest, avg, cheapestPlatform: entries.find(([, v]) => v === lowest)?.[0] };
  }

  const spread = ((highest - lowest) / highest) * 100;
  const rawScore = Math.min(100, Math.max(0, 100 - ((lowest / avg) - 0.5) * 100));

  return {
    score: Math.round(rawScore),
    spread: rd(spread, 1),
    lowest: rd(lowest),
    highest: rd(highest),
    avg: rd(avg),
    cheapestPlatform: entries.find(([, v]) => v === lowest)?.[0] || null,
    breakdown: Object.fromEntries(entries.map(([k, v]) => [k, rd(v)])),
  };
}

// ── Recomendação híbrida (algoritmo + override admin) ─────────────────────
function autoRecommendation(scoreData, trend) {
  if (!scoreData) return { verdict: 'ESPERAR', confidence: 30, reasons: ['Dados insuficientes'] };
  const reasons = [];
  let points = 0;

  if (scoreData.score >= 70) { points += 50; reasons.push(`Preço ${scoreData.score}/100 (bom)`); }
  else if (scoreData.score >= 50) { points += 25; reasons.push(`Preço ${scoreData.score}/100 (justo)`); }
  else { points -= 25; reasons.push(`Preço ${scoreData.score}/100 (caro)`); }

  if (scoreData.spread >= 15) { points += 20; reasons.push(`Arbitragem de ${scoreData.spread}% entre plataformas`); }
  else if (scoreData.spread >= 8) { points += 10; }

  if (trend?.direction === 'up') { points += 30; reasons.push(`Tendência de alta (+${trend.pctChange7d}%)`); }
  else if (trend?.direction === 'down') { points -= 30; reasons.push(`Tendência de queda (${trend.pctChange7d}%)`); }
  else if (trend?.direction === 'stable') { points += 5; reasons.push('Preço estável'); }

  let verdict = 'ESPERAR';
  if (points >= 60) verdict = 'COMPRAR';
  else if (points <= 0) verdict = 'EVITAR';

  return {
    verdict,
    confidence: Math.max(0, Math.min(100, 50 + points / 2)),
    reasons,
  };
}

async function getAdminOpportunity(skinName) {
  try {
    const db = admin.firestore();
    const doc = await db.collection('opportunities').doc(skinName).get();
    if (!doc.exists) return null;
    const d = doc.data();
    if (!d.active) return null;
    if (d.expiresAt && new Date(d.expiresAt) < new Date()) return null;
    return {
      badge: d.badge || 'Oportunidade do dia',
      note: d.note || '',
      verdictOverride: d.verdictOverride || null,
      highlightedAt: d.highlightedAt || null,
    };
  } catch { return null; }
}

// ── Gumax Shield ──────────────────────────────────────────────────────────
async function trackShield(uid, skinName, lowestBRL, tier) {
  if (tier !== 'full' || !lowestBRL) return null;
  try {
    const db = admin.firestore();
    const ref = db.collection('shield_tracking').doc();
    const expiresAt = new Date(Date.now() + SHIELD_WINDOW_MS).toISOString();
    await ref.set({
      id: ref.id,
      uid,
      skin: skinName,
      priceAtAnalysisBRL: lowestBRL,
      creditsToRefund: COSTS.full,
      createdAt: new Date().toISOString(),
      expiresAt,
      checked: false,
      refunded: false,
    });
    return { trackingId: ref.id, expiresAt, maxDropPct: SHIELD_MAX_DROP_PCT };
  } catch (e) {
    console.log('[Analysis] shield track error:', e.message);
    return null;
  }
}

// Cron: verifica shields expirados e faz refund se aplicável.
// Usa Skinport (grátis) como fonte de preço de verificação.
async function processShieldRefunds() {
  const db = admin.firestore();
  const { award } = require('./credits');
  const now = new Date();
  const snap = await db.collection('shield_tracking')
    .where('checked', '==', false)
    .where('expiresAt', '<=', now.toISOString())
    .limit(100)
    .get();

  let refunded = 0;

  for (const doc of snap.docs) {
    const t = doc.data();
    try {
      const usdRate = await fetchUsdBrl();
      const item = await getSkinportItem(t.skin);
      if (!item || item.min_price == null) {
        await doc.ref.update({ checked: true, error: 'not_found_skinport' });
        continue;
      }
      const currentLowestBRL = item.min_price * usdRate;
      const dropPct = ((t.priceAtAnalysisBRL - currentLowestBRL) / t.priceAtAnalysisBRL) * 100;

      if (dropPct > 0 && dropPct <= SHIELD_MAX_DROP_PCT) {
        await award(t.uid, t.creditsToRefund, `shield_refund:${t.skin}`, {
          trackingId: doc.id, dropPct: rd(dropPct, 2), bucket: 'purchased',
        });
        await doc.ref.update({
          checked: true, refunded: true,
          checkedAt: new Date().toISOString(),
          priceAtCheckBRL: rd(currentLowestBRL),
          dropPct: rd(dropPct, 2),
        });
        refunded++;
      } else {
        await doc.ref.update({
          checked: true, refunded: false,
          checkedAt: new Date().toISOString(),
          priceAtCheckBRL: rd(currentLowestBRL),
          dropPct: rd(dropPct, 2),
        });
      }
    } catch (e) {
      console.log('[Shield] err for', doc.id, e.message);
    }
  }

  return { processed: snap.size, refunded };
}

// ── Cache de análise ──────────────────────────────────────────────────────
async function getCached(skinName, tier) {
  try {
    const db = admin.firestore();
    const doc = await db.collection('analysis_cache').doc(`${skinName}::${tier}`).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (Date.now() - new Date(data.cachedAt).getTime() > CACHE_TTL_MS) return null;
    return data.response;
  } catch { return null; }
}

async function setCached(skinName, tier, response) {
  try {
    const db = admin.firestore();
    await db.collection('analysis_cache').doc(`${skinName}::${tier}`).set({
      response,
      cachedAt: new Date().toISOString(),
    }, { merge: false });
  } catch (e) {
    console.log('[Analysis] cache write error:', e.message);
  }
}

function scoreLabel(s) {
  if (s == null) return 'n/a';
  if (s >= 80) return 'Ótimo';
  if (s >= 65) return 'Bom';
  if (s >= 50) return 'Justo';
  if (s >= 35) return 'Caro';
  return 'Muito caro';
}

// ── Handler principal ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { name, depth } = body;
  if (!name) return json(400, { error: 'name is required' });
  const tier = depth || 'basic';
  if (!(tier in COSTS)) return json(400, { error: `Invalid depth. Use one of: ${Object.keys(COSTS).join(', ')}` });

  // Auth obrigatório em todos os tiers (basic é grátis mas precisa estar logado)
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return json(401, { error: 'Unauthorized — login required for analysis' });
  const uid = decoded.uid;

  // Cache por (skinName, tier). Se bater cache, não cobramos de novo.
  const cached = await getCached(name, tier);
  if (cached) {
    return json(200, { ...cached, fromCache: true });
  }

  // ── Fetch de dados base (grátis, sempre) ────────────────────────────────
  const [skinportItem, usdRate] = await Promise.all([
    getSkinportItem(name),
    fetchUsdBrl(),
  ]);

  if (!skinportItem) {
    return json(404, { error: 'Skin not found on Skinport', name });
  }

  const skinportBRL = skinportItem.min_price != null ? skinportItem.min_price * usdRate : null;

  // Steam Market — cacheado 24h. Gratuito mas pode rate-limit.
  const steam = await getSteamPrice(name);
  const steamBRL = steam?.lowest_price_brl || null;

  // ── Cobrar créditos AGORA (se tier pago) ──────────────────────────────
  const cost = COSTS[tier];
  if (cost > 0) {
    const result = await consume(uid, cost, `analysis:${tier}:${name}`, { skin: name, tier });
    if (!result.ok) {
      return json(402, { error: 'insufficient_credits', balance: result.balance, needed: cost, tier });
    }
  }

  // ── Montar breakdown de preços em BRL ─────────────────────────────────
  const pricesBRL = {};
  if (skinportBRL != null) pricesBRL.skinport = skinportBRL;
  if (steamBRL != null) pricesBRL.steam = steamBRL;

  // Pricempire (opcional, só no tier full)
  let pricempire = null;
  if (tier === 'full') {
    pricempire = await fetchPricempireDetail(name);
    if (pricempire) {
      const cnyRate = await fetchCnyBrl();
      const plats = ['buff', 'youpin', 'c5game', 'csfloat', 'csmoney', 'dmarket', 'waxpeer'];
      for (const p of plats) {
        const v = parseFloat(pricempire[p]) || 0;
        if (v > 0) pricesBRL[p] = v * cnyRate;
      }
    }
  }

  const scoreData = computeScore(pricesBRL);

  // ── Tendência: próprio (Firestore snapshots) ou Pricempire ─────────────
  let trend = null;
  // Tenta histórico próprio primeiro
  try {
    const ownHistory = await getHistoryForSkin(name, 14);
    trend = classifyInternalTrend(ownHistory);
  } catch (e) { /* sem histórico ainda */ }

  // Fallback pra Pricempire se tier full/history e sem dados próprios
  if (!trend && (tier === 'full' || tier === 'history')) {
    const pmHistory = await fetchPricempireHistory(name);
    if (pmHistory) trend = classifyPricempireTrend(pmHistory);
  }

  // ── Resposta base ──────────────────────────────────────────────────────
  const response = {
    name,
    tier,
    creditsSpent: cost,
    rarity: pricempire?.rarity || skinportItem.rarity || 'Common',
    type: pricempire?.type || 'Weapon Skin',
    icon: pricempire?.icon || null,
    exchangeRate: { usdBrl: rd(usdRate, 3) },
    sources: {
      skinport: skinportBRL != null,
      steam: steamBRL != null,
      pricempire: !!pricempire,
      ownHistory: trend?.source === 'internal_skinport',
    },
    score: scoreData ? {
      value: scoreData.score,
      label: scoreLabel(scoreData.score),
      spread: scoreData.spread,
    } : null,
    trend: trend || null,
  };

  // ── Tier BASIC: só score + tendência ──────────────────────────────────
  // (já incluídos no base)

  // ── Tier FULL: breakdown detalhado + recomendação + shield ────────────
  if (tier === 'full') {
    response.breakdown = {
      brl: scoreData?.breakdown || {},
      cheapestPlatform: scoreData?.cheapestPlatform || null,
      volume: { steam: steam?.volume || 0, skinport: skinportItem.quantity || 0 },
    };

    if (pricempire) {
      response.stickers = pricempire.stickers || [];
      response.paintSeed = pricempire.paintSeed || null;
      response.float = pricempire.float || null;
    }

    const autoRec = autoRecommendation(scoreData, trend);
    const adminOpp = await getAdminOpportunity(name);
    response.recommendation = {
      verdict: adminOpp?.verdictOverride || autoRec.verdict,
      confidence: autoRec.confidence,
      reasons: autoRec.reasons,
      source: adminOpp?.verdictOverride ? 'admin' : 'auto',
      opportunity: adminOpp ? {
        badge: adminOpp.badge,
        note: adminOpp.note,
        highlightedAt: adminOpp.highlightedAt,
      } : null,
    };

    const shield = await trackShield(uid, name, scoreData?.lowest || null, tier);
    if (shield) {
      response.shield = {
        active: true,
        maxDropPct: shield.maxDropPct,
        windowHours: 48,
        refundCredits: COSTS.full,
        expiresAt: shield.expiresAt,
      };
    }
  }

  // ── Tier HISTORY: curva ────────────────────────────────────────────────
  if (tier === 'history') {
    const points = await getHistoryForSkin(name, 30);
    response.history = {
      source: points.length ? 'internal_skinport' : (trend ? 'pricempire' : 'none'),
      days: 30,
      points: points.map(p => ({ date: p.date, price_brl: rd(p.price_usd * usdRate) })),
    };
  }

  await setCached(name, tier, response);
  return json(200, response);
};

function classifyPricempireTrend(historyPoints) {
  if (!Array.isArray(historyPoints) || historyPoints.length < 3) return null;
  const prices = historyPoints.map(p => p.price_cny || p.price || 0).filter(p => p > 0);
  if (prices.length < 3) return null;
  const recent = prices.slice(-7);
  const older = prices.slice(0, 7);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const pctChange = ((recentAvg - olderAvg) / olderAvg) * 100;
  let direction = 'stable';
  if (pctChange > 4) direction = 'up';
  else if (pctChange < -4) direction = 'down';
  return {
    direction,
    pctChange7d: rd(pctChange, 1),
    recentAvg: rd(recentAvg),
    olderAvg: rd(olderAvg),
    points: prices.length,
    source: 'pricempire',
  };
}

exports.COSTS = COSTS;
exports.processShieldRefunds = processShieldRefunds;
exports.autoRecommendation = autoRecommendation;
