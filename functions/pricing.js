// ═══ Gumax — Pricing Config ═══
// Ambos os modos usam a cotação CNY→BRL ao vivo do Google Finance.
// A diferença é COMO o lucro é calculado em cima dela:
//
//   mode="surcharge"  → final = youpin_CNY × (google_rate + surchargeBRL)
//     Ex: google 0,74 + R$ 0,04 = 0,78 por ¥  →  skin ¥100 = R$ 78,00
//
//   mode="percent"    → final = youpin_CNY × google_rate × (1 + marginPct/100)
//     Ex: google 0,74 × 1,10 = 0,814 por ¥  →  skin ¥100 = R$ 81,40
//
// Gu escolhe o modo pelo painel admin em Configurações → Preço das skins Youpin.

const { fetchExchangeRate } = require('./exchange-rate');

const DEFAULTS = Object.freeze({
  mode: 'surcharge',    // 'surcharge' (R$ fixo por ¥) | 'percent' (% sobre cotação)
  surchargeBRL: 0.04,   // R$ extras somados à cotação — modo surcharge
  marginPct: 10,        // % acima da cotação — modo percent
  fallbackRate: 0.74,   // usado só se API de cotação cair
});

// Cache em memória da config (TTL 1 min)
const CONFIG_TTL = 60 * 1000;
let configCache = { data: null, ts: 0 };

async function getPricingConfig(forceRefresh = false) {
  if (!forceRefresh && configCache.data && Date.now() - configCache.ts < CONFIG_TTL) {
    return configCache.data;
  }
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const doc = await db.collection('settings').doc('pricing').get();
    const raw = doc.exists ? doc.data() : {};
    const data = { ...DEFAULTS, ...raw };

    // Migração de modelos antigos: "fixed"/"rate" → "surcharge"/"percent"
    if (data.mode === 'fixed' || data.mode === 'rate') data.mode = 'surcharge';
    if (!['surcharge', 'percent'].includes(data.mode)) data.mode = DEFAULTS.mode;

    // Sanitize
    const sc = parseFloat(data.surchargeBRL);
    data.surchargeBRL = (sc >= 0 && sc < 2) ? sc : DEFAULTS.surchargeBRL;
    const mg = parseFloat(data.marginPct);
    data.marginPct = (mg >= 0 && mg < 100) ? mg : DEFAULTS.marginPct;
    const fb = parseFloat(data.fallbackRate);
    data.fallbackRate = (fb > 0 && fb < 5) ? fb : DEFAULTS.fallbackRate;

    configCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error('[Pricing] getPricingConfig error:', e.message);
    return { ...DEFAULTS };
  }
}

async function setPricingConfig({ mode, surchargeBRL, marginPct, fallbackRate }, updatedBy = 'admin') {
  const admin = require('firebase-admin');
  const db = admin.firestore();
  const patch = { updatedAt: new Date().toISOString(), updatedBy };
  if (mode !== undefined) {
    if (!['surcharge', 'percent'].includes(mode)) throw new Error('mode must be "surcharge" or "percent"');
    patch.mode = mode;
  }
  if (surchargeBRL !== undefined) {
    const sc = parseFloat(surchargeBRL);
    if (!(sc >= 0 && sc < 2)) throw new Error('surchargeBRL must be between 0 and 2');
    patch.surchargeBRL = sc;
  }
  if (marginPct !== undefined) {
    const mg = parseFloat(marginPct);
    if (!(mg >= 0 && mg < 100)) throw new Error('marginPct must be between 0 and 99');
    patch.marginPct = mg;
  }
  if (fallbackRate !== undefined) {
    const fb = parseFloat(fallbackRate);
    if (!(fb > 0 && fb < 5)) throw new Error('fallbackRate must be between 0 and 5');
    patch.fallbackRate = fb;
  }
  await db.collection('settings').doc('pricing').set(patch, { merge: true });
  configCache = { data: null, ts: 0 };
  return getPricingConfig(true);
}

// Retorna a cotação CNY→BRL crua (sem lucro aplicado). Usado pro strikethrough.
async function getBaseFactor() {
  try {
    const rate = await fetchExchangeRate();
    if (rate > 0) return rate;
  } catch {}
  const cfg = await getPricingConfig();
  return cfg.fallbackRate;
}

// Retorna o fator FINAL BRL/CNY com o lucro aplicado (usado pra preço de venda).
async function getConversionFactor() {
  const cfg = await getPricingConfig();
  const baseRate = await getBaseFactor();
  if (cfg.mode === 'percent') {
    return baseRate * (1 + (cfg.marginPct || 0) / 100);
  }
  // surcharge (default)
  return baseRate + (cfg.surchargeBRL || 0);
}

async function salePriceBRL(cny) {
  if (!cny || cny <= 0) return 0;
  const factor = await getConversionFactor();
  return Math.round(cny * factor * 100) / 100;
}

async function originalPriceBRL(cny) {
  if (!cny || cny <= 0) return 0;
  const factor = await getBaseFactor();
  return Math.round(cny * factor * 100) / 100;
}

// Síncrono: aplica um factor já pronto a um valor CNY.
function applyPricing(cny, factor) {
  if (!cny || cny <= 0) return 0;
  return Math.round(cny * factor * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════
// STOCK PRICING (skins do Gu — estoque próprio, Entrega Full).
// Mesma schema, doc separado em settings/stockPricing. Permite que o Gu
// tenha margens diferentes pro estoque dele vs top-sellers do Youpin.
// ═══════════════════════════════════════════════════════════════════
const STOCK_DEFAULTS = Object.freeze({
  mode: 'surcharge',
  surchargeBRL: 0.10,   // Gu costuma vender o estoque próprio mais caro (entrega em 30min)
  marginPct: 15,
  fallbackRate: 0.74,
});

let stockConfigCache = { data: null, ts: 0 };

async function getStockPricingConfig(forceRefresh = false) {
  if (!forceRefresh && stockConfigCache.data && Date.now() - stockConfigCache.ts < CONFIG_TTL) {
    return stockConfigCache.data;
  }
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const doc = await db.collection('settings').doc('stockPricing').get();
    const raw = doc.exists ? doc.data() : {};
    const data = { ...STOCK_DEFAULTS, ...raw };
    if (!['surcharge', 'percent'].includes(data.mode)) data.mode = STOCK_DEFAULTS.mode;
    const sc = parseFloat(data.surchargeBRL);
    data.surchargeBRL = (sc >= 0 && sc < 2) ? sc : STOCK_DEFAULTS.surchargeBRL;
    const mg = parseFloat(data.marginPct);
    data.marginPct = (mg >= 0 && mg < 100) ? mg : STOCK_DEFAULTS.marginPct;
    const fb = parseFloat(data.fallbackRate);
    data.fallbackRate = (fb > 0 && fb < 5) ? fb : STOCK_DEFAULTS.fallbackRate;
    stockConfigCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error('[Stock Pricing] error:', e.message);
    return { ...STOCK_DEFAULTS };
  }
}

async function setStockPricingConfig({ mode, surchargeBRL, marginPct }, updatedBy = 'admin') {
  const admin = require('firebase-admin');
  const db = admin.firestore();
  const patch = { updatedAt: new Date().toISOString(), updatedBy };
  if (mode !== undefined) {
    if (!['surcharge', 'percent'].includes(mode)) throw new Error('mode must be "surcharge" or "percent"');
    patch.mode = mode;
  }
  if (surchargeBRL !== undefined) {
    const sc = parseFloat(surchargeBRL);
    if (!(sc >= 0 && sc < 2)) throw new Error('surchargeBRL must be between 0 and 2');
    patch.surchargeBRL = sc;
  }
  if (marginPct !== undefined) {
    const mg = parseFloat(marginPct);
    if (!(mg >= 0 && mg < 100)) throw new Error('marginPct must be between 0 and 99');
    patch.marginPct = mg;
  }
  await db.collection('settings').doc('stockPricing').set(patch, { merge: true });
  stockConfigCache = { data: null, ts: 0 };
  return getStockPricingConfig(true);
}

// Retorna o fator final de venda pro estoque (mesma lógica do Youpin, config diferente)
async function getStockConversionFactor() {
  const cfg = await getStockPricingConfig();
  const baseRate = await getBaseFactor();
  if (cfg.mode === 'percent') return baseRate * (1 + (cfg.marginPct || 0) / 100);
  return baseRate + (cfg.surchargeBRL || 0);
}

exports.getPricingConfig = getPricingConfig;
exports.setPricingConfig = setPricingConfig;
exports.getConversionFactor = getConversionFactor;
exports.getBaseFactor = getBaseFactor;
exports.salePriceBRL = salePriceBRL;
exports.originalPriceBRL = originalPriceBRL;
exports.applyPricing = applyPricing;
exports.DEFAULTS = DEFAULTS;
exports.getStockPricingConfig = getStockPricingConfig;
exports.setStockPricingConfig = setStockPricingConfig;
exports.getStockConversionFactor = getStockConversionFactor;
exports.STOCK_DEFAULTS = STOCK_DEFAULTS;
