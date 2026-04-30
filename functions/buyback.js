// ═══ Gumax — Buyback / Trade System ═══
// Sistema onde o cliente vende skins pro Gu.
//
// PREÇO DE COMPRA:
//   offerCNY = min(youpinCNY, buffCNY) × 0.85  (Gu paga 15% abaixo do mais barato)
//   offerBRL = offerCNY × cotação_Google        (sem margem, pq Gu tá comprando)
//
// TIPOS DE TRANSAÇÃO:
//   sell      → user envia skin, Gu paga PIX (após 8d trade protection)
//   upgrade   → user paga PIX + envia skin, Gu envia skin melhor
//   downgrade → user envia skin cara, Gu envia skin mais barata + troco PIX
//
// WORKFLOW (todos os tipos): SEMPRE espera 8 dias de trade protection antes
// de qualquer pagamento. Gu nunca paga antes.
//
// Endpoints:
//   POST /api/buyback/quote          body: { names: [...] }  → array com preços
//   POST /api/buyback/create         body: { type, offered, target?, pixKey?, tradeLink }
//                                    (requer Firebase auth header)
//   GET  /api/buyback/my             → lista transações do user logado

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// Busca dados de preço de um item no CSPriceAPI (era Pricempire)
async function getItemPrices(marketHashName) {
  const { getPricempireItem } = require('./cspriceapi');
  return getPricempireItem(marketHashName);
}

// Fallback: Steam Market priceoverview (gratuito, sem auth, rate-limit suave).
// Retorna preço em BRL diretamente (currency=23 = BRL). Cacheado em memória 1h
// pra não estourar rate limit em quotações em batch.
const _steamPriceCache = new Map(); // name -> { brl, ts }
const STEAM_PRICE_TTL = 60 * 60 * 1000;
async function fetchSteamMarketBRL(marketHashName) {
  const cached = _steamPriceCache.get(marketHashName);
  if (cached && Date.now() - cached.ts < STEAM_PRICE_TTL) return cached.brl;
  try {
    const url = `https://steamcommunity.com/market/priceoverview/?currency=23&appid=730&market_hash_name=${encodeURIComponent(marketHashName)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!r.ok) return 0;
    const d = await r.json();
    if (!d?.success) return 0;
    // Steam retorna "R$ 1.234,56" — converte
    const raw = String(d.lowest_price || d.median_price || '');
    const m = raw.match(/[\d.,]+/);
    if (!m) return 0;
    // "1.234,56" → 1234.56
    const brl = parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(brl) || brl <= 0) return 0;
    _steamPriceCache.set(marketHashName, { brl, ts: Date.now() });
    return brl;
  } catch (e) {
    console.warn('[buyback] Steam Market fallback err:', e.message);
    return 0;
  }
}

// Calcula proposta de compra pra UMA skin.
// Retorna { name, youpinCNY, buffCNY, cheapestCNY, offerCNY, offerBRL, iconUrl }.
//
// FALLBACK: se CSPriceAPI não retornou preço (key não configurada / catálogo
// vazio), tenta Steam Market priceoverview pra ainda dar uma cotação.
async function quoteItem(marketHashName) {
  const item = await getItemPrices(marketHashName);
  const { buildIconUrl } = require('./cspriceapi');
  const { getBaseFactor: getBaseFactorPricing } = require('./pricing');

  const extractPrice = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return v > 0 ? v : 0;
    if (typeof v === 'string') { const n = parseFloat(v); return n > 0 ? n : 0; }
    if (typeof v === 'object' && v.price != null) {
      const n = parseFloat(v.price);
      return n > 0 ? n / 100 : 0;
    }
    return 0;
  };

  const youpinCNY = item ? extractPrice(item.youpin) : 0;
  const buffCNY   = item ? extractPrice(item.buff)   : 0;
  const available = [youpinCNY, buffCNY].filter(p => p > 0);
  const cheapestCNY = available.length ? Math.min(...available) : 0;
  const offerCNY = cheapestCNY > 0 ? cheapestCNY * 0.85 : 0;
  const factor = await getBaseFactorPricing();
  let offerBRL = offerCNY > 0 ? Math.round(offerCNY * factor * 100) / 100 : 0;
  let usedFallback = false;

  // FALLBACK Steam Market quando CSPriceAPI vazio
  if (offerBRL <= 0) {
    const steamBRL = await fetchSteamMarketBRL(marketHashName);
    if (steamBRL > 0) {
      // Steam é o preço de mercado/lowest listing — pra recompra, oferta 15% abaixo
      offerBRL = Math.round(steamBRL * 0.85 * 100) / 100;
      usedFallback = true;
    }
  }

  if (offerBRL <= 0) return null;  // realmente não temos preço de lugar nenhum

  return {
    name: (item && item.market_hash_name) || marketHashName,
    youpinCNY, buffCNY, cheapestCNY,
    offerCNY, offerBRL,
    cheapestSource: usedFallback ? 'steam_market' : (cheapestCNY === youpinCNY ? 'youpin' : 'buff'),
    iconUrl: item ? buildIconUrl(item.icon) : '',
    fallback: usedFallback || undefined,
  };
}

async function quoteBatch(names) {
  if (!Array.isArray(names) || !names.length) return [];
  const results = await Promise.all(names.map(n => quoteItem(n).catch(() => null)));
  return results.filter(Boolean);
}

// Cria uma transação no Firestore. Retorna o id gerado.
async function createTransaction(payload, auth) {
  const admin = require('firebase-admin');
  const db = admin.firestore();

  const { type, offered, target, pixKey, tradeLink, steamId, userName } = payload;
  if (!['sell', 'upgrade', 'downgrade'].includes(type)) {
    throw new Error('type inválido');
  }
  if (!Array.isArray(offered) || offered.length === 0) {
    throw new Error('offered vazio');
  }
  if (!tradeLink || !/steamcommunity\.com\/tradeoffer/.test(tradeLink)) {
    throw new Error('tradeLink inválido (precisa ser link steamcommunity.com/tradeoffer/...)');
  }
  if ((type === 'sell' || type === 'downgrade') && !pixKey) {
    throw new Error('pixKey obrigatório pra sell/downgrade');
  }
  if ((type === 'upgrade' || type === 'downgrade') && (!Array.isArray(target) || !target.length)) {
    throw new Error('target obrigatório pra upgrade/downgrade');
  }

  // Re-cota no servidor (não confia em preços que o cliente mandou)
  const offeredNames = offered.map(x => x.name).filter(Boolean);
  const offeredQuotes = await quoteBatch(offeredNames);
  if (offeredQuotes.length !== offeredNames.length) {
    throw new Error('uma ou mais skins ofertadas não foram encontradas no catálogo');
  }
  const offeredTotalBRL = offeredQuotes.reduce((s, q) => s + (q.offerBRL || 0), 0);

  // Target (skin(s) que o user vai receber — no upgrade/downgrade)
  let targetTotalBRL = 0;
  let targetDetails = [];
  if (target && target.length) {
    // Pro target usamos o preço DE VENDA da loja (getConversionFactor + pricing config)
    const { getConversionFactor, applyPricing } = require('./pricing');
    const { getYoupinPrice } = require('./cspriceapi');
    const saleFactor = await getConversionFactor();
    for (const t of target) {
      const it = await getItemPrices(t.name);
      if (!it) throw new Error(`target não encontrado: ${t.name}`);
      const youpinCNY = getYoupinPrice(it);
      const saleBRL = applyPricing(youpinCNY, saleFactor);
      targetDetails.push({
        name: it.market_hash_name || t.name,
        youpinCNY,
        saleBRL,
        iconUrl: require('./cspriceapi').buildIconUrl(it.icon),
      });
      targetTotalBRL += saleBRL;
    }
  }

  // net = user owes Gu (positive) OR Gu owes user (negative)
  //   sell:       Gu owes user (= -offeredTotal)
  //   upgrade:    user owes Gu (= target - offered)
  //   downgrade:  Gu owes user (= offered - target, positive porque offered > target)
  let netAmountBRL = 0;
  if (type === 'sell') {
    netAmountBRL = -offeredTotalBRL;
  } else if (type === 'upgrade') {
    netAmountBRL = targetTotalBRL - offeredTotalBRL;
    if (netAmountBRL <= 0) throw new Error('no upgrade o valor target deve ser MAIOR que offered');
  } else if (type === 'downgrade') {
    netAmountBRL = targetTotalBRL - offeredTotalBRL;
    if (netAmountBRL >= 0) throw new Error('no downgrade o valor target deve ser MENOR que offered');
  }

  const now = new Date().toISOString();
  const tx = {
    userId: auth.uid,
    steamId: steamId || null,
    userName: userName || null,
    userTradeLink: tradeLink,
    userPixKey: pixKey || null,
    type,
    offered: offeredQuotes,
    offeredTotalBRL: Math.round(offeredTotalBRL * 100) / 100,
    target: targetDetails,
    targetTotalBRL: Math.round(targetTotalBRL * 100) / 100,
    netAmountBRL: Math.round(netAmountBRL * 100) / 100,
    // Status inicial depende do tipo
    //   sell:      WAITING_USER_TRADE    (user precisa enviar skins)
    //   upgrade:   WAITING_USER_PIX      (user precisa pagar diferença)
    //   downgrade: WAITING_USER_TRADE    (user precisa enviar skin)
    status: type === 'upgrade' ? 'WAITING_USER_PIX' : 'WAITING_USER_TRADE',
    statusHistory: [{ to: type === 'upgrade' ? 'WAITING_USER_PIX' : 'WAITING_USER_TRADE', at: now, by: 'system', note: 'transação criada' }],
    pixMercadoPagoId: null,
    pixPaidAt: null,
    pixOutSentAt: null,
    tradeAcceptedAt: null,
    tradeProtectionEndsAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const ref = await db.collection('transactions').add(tx);
  return { id: ref.id, ...tx };
}

// Verifica o Firebase ID token do request e retorna { uid, email }.
async function verifyAuth(headers) {
  const raw = headers.authorization || headers.Authorization || '';
  const token = raw.replace(/^Bearer\s+/, '').trim();
  if (!token) throw new Error('Auth header ausente');
  const admin = require('firebase-admin');
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email, steamId: decoded.steamId };
  } catch (e) {
    throw new Error('Token inválido: ' + e.message);
  }
}

// ── Handler HTTP ────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const path = event.path || '';

  // POST /api/buyback/quote — body: { names: [...] }  (público, não exige auth)
  if (event.httpMethod === 'POST' && path.endsWith('/quote')) {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'JSON inválido' }); }

    const names = Array.isArray(body.names) ? body.names.filter(Boolean).slice(0, 50) : [];
    if (!names.length) {
      // Suporta {name: "X"} singular também
      if (body.name) return json(200, { item: await quoteItem(body.name) });
      return json(400, { error: 'informe names: [...] ou name: "..."' });
    }
    const items = await quoteBatch(names);
    const totalBRL = items.reduce((s, x) => s + (x.offerBRL || 0), 0);
    return json(200, { count: items.length, totalBRL: Math.round(totalBRL * 100) / 100, items });
  }

  // POST /api/buyback/create — body: { type, offered, target?, pixKey?, tradeLink }
  // Exige Firebase ID token no header Authorization: Bearer <token>
  if (event.httpMethod === 'POST' && path.endsWith('/create')) {
    let auth;
    try { auth = await verifyAuth(event.headers || {}); }
    catch (e) { return json(401, { error: e.message }); }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'JSON inválido' }); }

    try {
      const result = await createTransaction(body, auth);
      return json(201, { success: true, transaction: result });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  // GET /api/buyback/my — transações do user logado (últimas 50)
  if (event.httpMethod === 'GET' && path.endsWith('/my')) {
    let auth;
    try { auth = await verifyAuth(event.headers || {}); }
    catch (e) { return json(401, { error: e.message }); }

    try {
      const admin = require('firebase-admin');
      const db = admin.firestore();
      const snap = await db.collection('transactions')
        .where('userId', '==', auth.uid)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return json(200, { count: transactions.length, transactions });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  return json(405, { error: 'Method not allowed' });
};

exports.quoteItem = quoteItem;
exports.quoteBatch = quoteBatch;
exports.createTransaction = createTransaction;
