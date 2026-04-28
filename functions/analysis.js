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
// Migrado pra CSPriceAPI (Trader Pro). Mesma signature exportada.
const { getPricempireItem, getYoupinPrice, buildIconUrl } = require('./cspriceapi');
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
// Entra: { [platform]: valueBRL } + opcionalmente suggestedBRL (sugestão Skinport)
// Se tiver múltiplas plataformas, calcula via spread + deal quality.
// Se tiver só 1, compara contra suggested_price da Skinport pra saber se tá caro/barato.
function computeScore(prices, suggestedBRL) {
  const entries = Object.entries(prices).filter(([, v]) => v != null && v > 0);
  if (entries.length === 0) return null;

  const values = entries.map(([, v]) => v);
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const cheapestPlatform = entries.find(([, v]) => v === lowest)?.[0] || null;

  // Caso 1: uma só fonte → compara com suggested (se disponível)
  if (entries.length === 1) {
    if (!suggestedBRL || suggestedBRL <= 0) {
      // Sem referência, devolve apenas o preço e score neutro
      return {
        score: 50,
        spread: 0,
        lowest: rd(lowest), highest: rd(lowest), avg: rd(lowest),
        cheapestPlatform,
        breakdown: Object.fromEntries(entries.map(([k, v]) => [k, rd(v)])),
        singleSource: true,
      };
    }
    // deal ratio = lowest / suggested. <1 = está abaixo do sugerido (deal bom).
    const ratio = lowest / suggestedBRL;
    // Mapeia: 0.7 (30% abaixo) → 95; 1.0 → 50; 1.3 → 5.
    const rawScore = Math.min(100, Math.max(0, 100 - (ratio - 0.7) * 150));
    const savingsPct = (1 - ratio) * 100; // positivo = está abaixo do sugerido
    return {
      score: Math.round(rawScore),
      spread: rd(Math.max(0, savingsPct), 1),
      lowest: rd(lowest),
      highest: rd(suggestedBRL),
      avg: rd((lowest + suggestedBRL) / 2),
      cheapestPlatform,
      breakdown: Object.fromEntries(entries.map(([k, v]) => [k, rd(v)])),
      singleSource: true,
      suggested: rd(suggestedBRL),
    };
  }

  // Caso 2+: múltiplas plataformas (como era antes)
  if (highest === lowest) {
    return { score: 50, spread: 0, lowest: rd(lowest), highest: rd(highest), avg: rd(avg), cheapestPlatform, breakdown: Object.fromEntries(entries.map(([k, v]) => [k, rd(v)])) };
  }
  const spread = ((highest - lowest) / highest) * 100;
  const rawScore = Math.min(100, Math.max(0, 100 - ((lowest / avg) - 0.5) * 100));
  return {
    score: Math.round(rawScore),
    spread: rd(spread, 1),
    lowest: rd(lowest),
    highest: rd(highest),
    avg: rd(avg),
    cheapestPlatform,
    breakdown: Object.fromEntries(entries.map(([k, v]) => [k, rd(v)])),
  };
}

// ── Recomendação híbrida (algoritmo + override admin) ─────────────────────
//
// 4 verdicts pra alinhar com a intuição do consumidor final:
//   COMPRAR  — oferta boa, preço abaixo da média (score alto OU tendência alta)
//   JUSTO    — preço fair, pode comprar tranquilo se quer usar (sem urgência)
//   AGUARDAR — tendência de queda detectada, vale esperar baixar mais
//   EVITAR   — preço caro, não recomendamos
//
// MOTIVAÇÃO DA MUDANÇA: antes "ESPERAR" era usado pra "preço médio" o que confundia
// o user (clicava em "JUSTO 64/100" mas via "ESPERAR" como recomendação — contradição).
function autoRecommendation(scoreData, trend) {
  if (!scoreData) return { verdict: 'JUSTO', confidence: 30, reasons: ['Dados insuficientes — análise limitada'] };
  const reasons = [];
  let points = 0;

  // Score do preço (0-100 onde 100 = ofertão)
  const score = scoreData.score || 0;
  if (score >= 70)      { points += 50; reasons.push(`Preço ${score}/100 (oferta boa)`); }
  else if (score >= 50) { points += 25; reasons.push(`Preço ${score}/100 (justo)`); }
  else                  { points -= 25; reasons.push(`Preço ${score}/100 (caro)`); }

  // Spread/arbitragem (preço varia muito entre Buff/Steam/Skinport/etc)
  if (scoreData.spread >= 15)      { points += 20; reasons.push(`Arbitragem de ${scoreData.spread}% entre plataformas`); }
  else if (scoreData.spread >= 8)  { points += 10; }

  // Tendência últimos 7 dias
  const trendDir = trend?.direction;
  if (trendDir === 'up')        { points += 30; reasons.push(`Tendência de alta (+${trend.pctChange7d}%)`); }
  else if (trendDir === 'down') { points -= 20; reasons.push(`Tendência de queda (${trend.pctChange7d}%)`); }
  else if (trendDir === 'stable') { points += 5; reasons.push('Preço estável'); }

  // ── Decisão final (4 verdicts) ──
  // Prioridade 1: tendência de queda forte → AGUARDAR (vai ficar mais barato)
  // Prioridade 2: pontuação total decide
  let verdict;
  if (trendDir === 'down' && trend.pctChange7d <= -3) {
    verdict = 'AGUARDAR';
  } else if (points >= 55) {
    verdict = 'COMPRAR';
  } else if (points <= -10) {
    verdict = 'EVITAR';
  } else {
    verdict = 'JUSTO';   // default — preço fair, sem urgência
  }

  return {
    verdict,
    confidence: Math.max(20, Math.min(95, 50 + points / 2)),
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
      const cnyRate = await fetchCnyBrl();
      const item = await getPricempireItem(t.skin);
      const youpin = item ? getYoupinPrice(item) : 0;
      if (!item || !youpin) {
        await doc.ref.update({ checked: true, error: 'not_found_pricempire' });
        continue;
      }
      const currentLowestBRL = youpin * cnyRate;
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

// ── Tracking de análises PAGAS POR USER ──────────────────────────────────
// Quando user paga 2 créditos por uma skin, grava em paid_analyses/{uid}__{skin}__{tier}.
// Válido por 24h. Se o user refinar a mesma skin dentro da janela, NÃO cobra de novo.
const PAID_TTL_MS = 24 * 60 * 60 * 1000;
async function hasUserPaidRecently(uid, skinName, tier) {
  try {
    const db = admin.firestore();
    const id = `${uid}__${skinName}__${tier}`;
    const doc = await db.collection('paid_analyses').doc(id).get();
    if (!doc.exists) return false;
    const data = doc.data();
    if (!data.paidAt) return false;
    return Date.now() - new Date(data.paidAt).getTime() < PAID_TTL_MS;
  } catch { return false; }
}
async function markUserPaid(uid, skinName, tier) {
  try {
    const db = admin.firestore();
    const id = `${uid}__${skinName}__${tier}`;
    await db.collection('paid_analyses').doc(id).set({
      uid, skinName, tier, paidAt: new Date().toISOString(),
    });
  } catch (e) { console.log('[Analysis] paid mark error:', e.message); }
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

  const { name, depth, floatvalue, paintseed, paintindex } = body;
  if (!name) return json(400, { error: 'name is required' });
  const tier = depth || 'basic';
  if (!(tier in COSTS)) return json(400, { error: `Invalid depth. Use one of: ${Object.keys(COSTS).join(', ')}` });

  // Pattern refinement params — ao passar float/paintseed/paintindex, a análise
  // é enriquecida com tier de float + pattern tier (blue gems) + Doppler phase.
  // Isso não adiciona custo (pattern-tiers.js roda em memória, só lookup).
  const hasRefinement = floatvalue != null || paintseed != null || paintindex != null;

  // Auth obrigatório em todos os tiers (basic é grátis mas precisa estar logado)
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return json(401, { error: 'Unauthorized — login required for analysis' });
  const uid = decoded.uid;

  // Cache por (skinName, tier). Se bater cache, não cobramos de novo.
  // Se o cache tem score null (bug antigo) OU breakdown.brl vazio, ignora e refaz
  // MAS também não cobra de novo (já foi cobrado).
  // CACHE BYPASS: se houver refinement (float/pattern), não usa cache pois o
  // resultado muda a cada combinação de float+paintseed+paintindex.
  const cached = hasRefinement ? null : await getCached(name, tier);
  const cacheIsHealthy = cached && cached.score && (
    tier !== 'full' ||
    (cached.breakdown && cached.breakdown.brl && Object.keys(cached.breakdown.brl).length > 0)
  );
  const cacheExistsButUnhealthy = cached && !cacheIsHealthy;
  if (cached && cacheIsHealthy) {
    return json(200, { ...cached, fromCache: true });
  }

  // ── Fetch de dados base: Pricempire (fonte canônica) ────────────────────
  const [pricempireItem, cnyRate] = await Promise.all([
    getPricempireItem(name),
    fetchCnyBrl(),
  ]);

  if (!pricempireItem) {
    return json(404, { error: 'Skin not found on Pricempire', name });
  }

  // Steam Market — cacheado 24h. Complementar à Pricempire.
  const steam = await getSteamPrice(name);
  const steamBRL = steam?.lowest_price_brl || null;

  // ── Cobrar créditos AGORA (se tier pago) ──────────────────────────────
  // Cobra APENAS se:
  //   - tier tem custo > 0
  //   - cache não existe OU existe mas unhealthy (vai regerar mesmo, mas sem cobrar)
  //   - E o user AINDA não pagou por esta skin nas últimas 24h (evita cobrança
  //     quando user adiciona refinement na mesma skin que já pagou)
  const cost = COSTS[tier];
  const alreadyPaid = cost > 0 ? await hasUserPaidRecently(uid, name, tier) : false;
  if (cost > 0 && !cacheExistsButUnhealthy && !alreadyPaid) {
    const result = await consume(uid, cost, `analysis:${tier}:${name}`, { skin: name, tier });
    if (!result.ok) {
      return json(402, { error: 'insufficient_credits', balance: result.balance, needed: cost, tier });
    }
    // Marca que user pagou por esta skin — refinamentos na mesma skin não cobram de novo
    await markUserPaid(uid, name, tier);
  }

  // ── Montar breakdown de preços em BRL ─────────────────────────────────
  // Todos os preços vêm da Pricempire (real). Steam vem complementar.
  const pricesBRL = {};
  const priceSources = {};

  const plats = ['buff', 'youpin', 'c5game', 'csfloat', 'csmoney', 'dmarket', 'waxpeer'];
  for (const p of plats) {
    const v = parseFloat(pricempireItem[p]) || 0;
    if (v > 0) { pricesBRL[p] = v * cnyRate; priceSources[p] = 'api'; }
  }
  if (steamBRL != null) { pricesBRL.steam = steamBRL; priceSources.steam = 'api'; }

  // Youpin é a base canônica (em CNY) — usada como "suggested" pra score single-source
  const youpinBRL = pricesBRL.youpin || null;
  const scoreData = computeScore(pricesBRL, youpinBRL);

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
    rarity: pricempireItem.rarity || 'Common',
    type: pricempireItem.type || 'Weapon Skin',
    icon: buildIconUrl(pricempireItem.icon),
    exchangeRate: { cnyBrl: rd(cnyRate, 3) },
    sources: {
      pricempire: true,
      steam: steamBRL != null,
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
    // Breakdown agora inclui TODAS as plataformas (reais + estimativas)
    // mas com info pra frontend marcar visualmente
    const fullBreakdown = {};
    for (const [k, v] of Object.entries(pricesBRL)) {
      fullBreakdown[k] = rd(v);
    }
    const cheapestAll = Object.entries(fullBreakdown).sort((a, b) => a[1] - b[1])[0]?.[0] || null;
    response.breakdown = {
      brl: fullBreakdown,
      sources: priceSources,
      cheapestPlatform: cheapestAll,
      cheapestPlatformReal: scoreData?.cheapestPlatform || null,
      volume: { steam: steam?.volume || 0 },
    };

    response.stickers = pricempireItem.stickers || [];
    response.paintSeed = pricempireItem.paintSeed || null;
    response.float = pricempireItem.float || null;

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
      source: points.length ? 'internal_pricempire' : (trend ? 'pricempire' : 'none'),
      days: 30,
      points: points.map(p => ({ date: p.date, price_brl: rd(p.price_cny * cnyRate) })),
    };
  }

  // ── Pattern refinement (float tier, Doppler phase, Blue Gem) ──────────
  // Retorna classificação (tier do float, phase do Doppler, tier do Blue Gem)
  // MAS SEM preço estimado multiplicado. Usuário vê a classificação e usa os
  // preços REAIS do breakdown.brl (Buff, Youpin, etc) pra decidir.
  // Preços reais de skins com pattern específico só podem ser obtidos via
  // scraping live do marketplace — não é heurística.
  if (hasRefinement) {
    try {
      const { analyzePatternOverall } = require('./pattern-tiers');
      const pattern = analyzePatternOverall(name, { floatvalue, paintseed, paintindex });
      response.pattern = pattern;
      // NÃO incluir adjustedPriceBRL — frontend usa breakdown.brl (dados reais
      // do mercado) e separadamente mostra o tier info pra informação.
    } catch (e) {
      console.log('[Analysis] pattern-tiers error:', e.message);
    }
  }

  // Só cacheia quando não houver refinement (cache é por name+tier; com refinement
  // o resultado varia a cada input).
  if (!hasRefinement) {
    await setCached(name, tier, response);
  }
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
