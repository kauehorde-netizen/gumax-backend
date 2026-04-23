// ═══ Gumax — Skin Analysis Endpoint ═══
// POST /api/analysis { name, depth, uid? }
//   depth: "basic"  (free, score + trend)
//          "full"   (2 credits, breakdown by platform + price range + volume)
//          "history" (2 credits, 7/30/90d price history if available)
//
// Integrates with Pricempire (already used in skin-detail.js) and debits
// credits via the shared consume() from credits.js.
//
// Consumption is applied AFTER a successful data fetch (so user is not
// charged on upstream failure). If the analysis hits the cache we still
// charge for paid tiers — the value is the insight, not the upstream call.

const admin = require('firebase-admin');
const { consume } = require('./credits');

// Cost table (keeps in one place — change here to adjust pricing globally)
const COSTS = {
  basic: 0,
  full: 2,
  history: 2,
  alert: 3,  // used by /api/price-alerts when setting up a new alert
};

// Gumax Shield: se a skin cair até 5% em 48h após a análise "full",
// o usuário recebe os créditos gastos de volta.
const SHIELD_MAX_DROP_PCT = 5;
const SHIELD_WINDOW_MS = 48 * 60 * 60 * 1000;

// Analysis cache TTL (15 min — matches Pricempire refresh cadence in catalog.js)
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

// ---- Pricempire fetch helpers (re-implemented here to keep modules independent) ----
async function fetchPricempireDetail(skinName, apiKey) {
  try {
    const resp = await fetch(
      `https://api.pricempire.com/v4/cs2/item/${encodeURIComponent(skinName)}`,
      { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'Gumax-Backend/1.0' }, timeout: 10000 }
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.log('[Analysis] Pricempire detail error:', e.message);
    return null;
  }
}

async function fetchPricempireHistory(skinName, apiKey) {
  // NOTE: Pricempire's v4 history endpoint; if not available for your plan,
  // this returns null and the frontend shows "trend unavailable".
  try {
    const resp = await fetch(
      `https://api.pricempire.com/v4/cs2/item/${encodeURIComponent(skinName)}/history?days=30`,
      { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'Gumax-Backend/1.0' }, timeout: 12000 }
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.log('[Analysis] Pricempire history error:', e.message);
    return null;
  }
}

async function fetchExchangeRate() {
  if (global._rateCache && global._rateCache.ts && Date.now() - global._rateCache.ts < 60 * 60 * 1000) {
    return global._rateCache.value;
  }
  try {
    const resp = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', { timeout: 5000 });
    const data = await resp.json();
    const rate = data.rates?.BRL || 0.68;
    global._rateCache = { value: rate, ts: Date.now() };
    return rate;
  } catch {
    return global._rateCache?.value || 0.68;
  }
}

// ---- Score computation ----
function computeScore(pricesCNY) {
  // Score 0-100: how good the lowest price is vs the market average.
  // 100 = skin is priced at or below best market price (rare steal).
  // 50  = middle of the pack.
  // 0   = priced 2x+ above the lowest market price.
  const values = Object.values(pricesCNY).filter(p => p > 0);
  if (values.length < 2) return null;

  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;

  if (lowest === 0 || highest === lowest) return { score: 50, lowest, highest, avg };

  // Spread percentage — how much can you save by going to the cheapest platform?
  const spread = ((highest - lowest) / highest) * 100;

  // Raw score: higher when lowest is much cheaper than avg
  const rawScore = Math.min(100, Math.max(0, 100 - ((lowest / avg) - 0.5) * 100));

  return {
    score: Math.round(rawScore),
    spread: rd(spread, 1),
    lowest: rd(lowest),
    highest: rd(highest),
    avg: rd(avg),
  };
}

// ---- Recomendação híbrida (automática + override admin) ----
// Retorna { verdict: 'COMPRAR'|'ESPERAR'|'EVITAR', confidence: 0-100, reasons: [] }
function autoRecommendation(scoreData, trend) {
  if (!scoreData) return { verdict: 'ESPERAR', confidence: 30, reasons: ['Dados insuficientes'] };
  const reasons = [];
  let points = 0;

  // Score (peso 50%)
  if (scoreData.score >= 70) { points += 50; reasons.push(`Preço ${scoreData.score}/100 (bom)`); }
  else if (scoreData.score >= 50) { points += 25; reasons.push(`Preço ${scoreData.score}/100 (justo)`); }
  else { points -= 25; reasons.push(`Preço ${scoreData.score}/100 (caro)`); }

  // Spread entre marketplaces (peso 20%): spread grande = boa oportunidade de arbitragem
  if (scoreData.spread >= 15) { points += 20; reasons.push(`Arbitragem de ${scoreData.spread}% entre plataformas`); }
  else if (scoreData.spread >= 8) { points += 10; }

  // Tendência (peso 30%)
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

// Busca override manual do admin (coleção opportunities)
async function getAdminOpportunity(skinName) {
  try {
    const db = admin.firestore();
    const doc = await db.collection('opportunities').doc(skinName).get();
    if (!doc.exists) return null;
    const d = doc.data();
    // Só vale se ativa E ainda dentro da validade
    if (!d.active) return null;
    if (d.expiresAt && new Date(d.expiresAt) < new Date()) return null;
    return {
      badge: d.badge || 'Oportunidade do dia',
      note: d.note || '',
      verdictOverride: d.verdictOverride || null, // 'COMPRAR' | 'ESPERAR' | 'EVITAR' (opcional)
      highlightedAt: d.highlightedAt || null,
    };
  } catch {
    return null;
  }
}

// Análise de risco Gumax Shield: rastreia o preço no momento da análise "full"
// pra poder conferir depois se caiu mais que SHIELD_MAX_DROP_PCT em 48h.
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

// Cron job: checa registros do shield cuja janela de 48h expirou e,
// se o preço caiu ≤5%, devolve os créditos gastos.
async function processShieldRefunds() {
  const db = admin.firestore();
  const { award } = require('./credits');
  const now = new Date();
  const snap = await db.collection('shield_tracking')
    .where('checked', '==', false)
    .where('expiresAt', '<=', now.toISOString())
    .limit(100)
    .get();

  const PRICEMPIRE_KEY = process.env.PRICEMPIRE_API_KEY;
  let refunded = 0;

  for (const doc of snap.docs) {
    const t = doc.data();
    try {
      const detail = await fetchPricempireDetail(t.skin, PRICEMPIRE_KEY);
      if (!detail) { await doc.ref.update({ checked: true, error: 'not found' }); continue; }
      const rate = await fetchExchangeRate();
      const prices = [
        parseFloat(detail.buff) || 0, parseFloat(detail.youpin) || 0,
        parseFloat(detail.c5game) || 0, parseFloat(detail.steam) || 0,
        parseFloat(detail.csfloat) || 0, parseFloat(detail.csmoney) || 0,
      ].filter(p => p > 0);
      if (!prices.length) { await doc.ref.update({ checked: true, error: 'no prices' }); continue; }

      const currentLowestBRL = Math.min(...prices) * rate;
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

// ---- Trend classification ----
function classifyTrend(historyPoints) {
  // Pricempire history format (assumed): [{ date, price_cny }, ...] sorted asc.
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
  };
}

// ---- Cache helpers ----
async function getCached(skinName) {
  try {
    const db = admin.firestore();
    const doc = await db.collection('analysis_cache').doc(skinName).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (Date.now() - new Date(data.cachedAt).getTime() > CACHE_TTL_MS) return null;
    return data;
  } catch (e) {
    return null;
  }
}

async function setCached(skinName, payload) {
  try {
    const db = admin.firestore();
    await db.collection('analysis_cache').doc(skinName).set({
      ...payload,
      cachedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (e) {
    console.log('[Analysis] cache write error:', e.message);
  }
}

// ---- Main handler ----
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }

  const PRICEMPIRE_KEY = process.env.PRICEMPIRE_API_KEY;
  if (!PRICEMPIRE_KEY) return json(500, { error: 'API not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { name, depth } = body;
  if (!name) return json(400, { error: 'name is required' });
  const tier = depth || 'basic';
  if (!(tier in COSTS)) return json(400, { error: `Invalid depth. Use one of: ${Object.keys(COSTS).join(', ')}` });

  // Auth: basic requires login (free but logged); full/history require login AND credits
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return json(401, { error: 'Unauthorized — login required for analysis' });
  const uid = decoded.uid;

  // Cost & debit (for paid tiers)
  const cost = COSTS[tier];
  if (cost > 0) {
    const result = await consume(uid, cost, `analysis:${tier}:${name}`, { skin: name, tier });
    if (!result.ok) {
      return json(402, { error: 'insufficient_credits', balance: result.balance, needed: cost, tier });
    }
  }

  // Try cache first
  let cached = await getCached(name);
  const needsHistory = tier === 'history' || tier === 'full';

  // Fetch from Pricempire
  let detail = cached?.detail;
  if (!detail) {
    detail = await fetchPricempireDetail(name, PRICEMPIRE_KEY);
    if (!detail) return json(404, { error: 'Skin not found' });
  }

  const rate = await fetchExchangeRate();

  // Extract CNY prices from all platforms
  const pricesCNY = {
    buff: parseFloat(detail.buff) || 0,
    youpin: parseFloat(detail.youpin) || 0,
    c5game: parseFloat(detail.c5game) || 0,
    steam: parseFloat(detail.steam) || 0,
    csfloat: parseFloat(detail.csfloat) || 0,
    csmoney: parseFloat(detail.csmoney) || 0,
  };

  const scoreData = computeScore(pricesCNY);

  // Build response
  const response = {
    name,
    tier,
    creditsSpent: cost,
    rarity: detail.rarity || 'Common',
    type: detail.type || 'Weapon Skin',
    wear: detail.wear || '',
    icon: detail.icon || '',
    exchangeRate: rd(rate),

    // Always included (even basic)
    score: scoreData ? {
      value: scoreData.score,
      label: scoreLabel(scoreData.score),
    } : null,
  };

  // --- BASIC: score + short trend ---
  if (tier === 'basic' || tier === 'full' || tier === 'history') {
    // Fetch history for trend classification (cached inside analysis_cache)
    let history = cached?.history;
    if (!history && (needsHistory || tier === 'basic')) {
      history = await fetchPricempireHistory(name, PRICEMPIRE_KEY);
    }
    response.trend = history ? classifyTrend(history) : null;
  }

  // --- FULL: detailed breakdown + recomendação + shield ---
  if (tier === 'full') {
    const pricesBRL = {};
    for (const [k, v] of Object.entries(pricesCNY)) pricesBRL[k] = v > 0 ? rd(v * rate) : 0;

    response.breakdown = {
      cny: pricesCNY,
      brl: pricesBRL,
      spread: scoreData?.spread ?? null,
      cheapestPlatform: scoreData
        ? Object.entries(pricesCNY).find(([, p]) => p === scoreData.lowest)?.[0] ?? null
        : null,
    };

    response.stickers = detail.stickers || [];
    response.paintSeed = detail.paintSeed || null;
    response.float = detail.float || null;

    // Recomendação híbrida: algoritmo + override admin
    const autoRec = autoRecommendation(scoreData, response.trend);
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

    // Gumax Shield: rastreia esta análise pra refund se cair ≤5% em 48h
    const lowestBRL = scoreData ? rd(scoreData.lowest * rate) : null;
    const shield = await trackShield(uid, name, lowestBRL, tier);
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

  // --- HISTORY: price curve ---
  if (tier === 'history') {
    const history = cached?.history || await fetchPricempireHistory(name, PRICEMPIRE_KEY);
    if (history) {
      response.history = (Array.isArray(history) ? history : [])
        .map(p => ({ date: p.date, price_cny: p.price_cny || p.price || 0 }))
        .filter(p => p.price_cny > 0);
    }
  }

  // Cache the upstream payload (not the final tier-specific response)
  await setCached(name, { detail, history: cached?.history });

  return json(200, response);
};

function scoreLabel(s) {
  if (s == null) return 'n/a';
  if (s >= 80) return 'Ótimo';
  if (s >= 65) return 'Bom';
  if (s >= 50) return 'Justo';
  if (s >= 35) return 'Caro';
  return 'Muito caro';
}

exports.COSTS = COSTS;
exports.processShieldRefunds = processShieldRefunds;
exports.autoRecommendation = autoRecommendation;
