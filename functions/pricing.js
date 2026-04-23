// ═══ Gumax — Pricing Config + Conversion Helpers ═══
// Centraliza a lógica de "preço de venda ao cliente BR" usada pela home,
// catálogo, análise e detalhe de skin.
//
// MODELO:
//   preço_original_BRL  = Steam Market (em CNY) × fator_de_conversão        ← strikethrough
//   preço_venda_BRL     = Youpin     (em CNY) × fator_de_conversão × (1 + margem)  ← destaque
//
// Gu escolhe o fator via painel admin:
//   mode="fixed"  →  usa `fixedRate` (default 0.78)   — previsível, não sofre com volatilidade
//   mode="rate"   →  usa a cotação atual do Google Finance (via exchange-rate.js)
//
// E escolhe a margem (lucro) — default 10% acima do Youpin.

const { fetchExchangeRate } = require('./exchange-rate');

// Defaults se o doc settings/pricing não existir
const DEFAULTS = Object.freeze({
  mode: 'fixed',     // 'fixed' | 'rate'
  fixedRate: 0.78,   // BRL por CNY — valor com que o Gu trabalha
  margin: 0.10,      // +10% sobre youpin
});

// Cache em memória da config (TTL 1 min — admin muda raro, mas propaga rápido)
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
    const data = doc.exists ? { ...DEFAULTS, ...doc.data() } : { ...DEFAULTS };
    // Sanitize
    if (!['fixed', 'rate'].includes(data.mode)) data.mode = DEFAULTS.mode;
    const fr = parseFloat(data.fixedRate);
    data.fixedRate = (fr > 0 && fr < 5) ? fr : DEFAULTS.fixedRate;
    const mg = parseFloat(data.margin);
    data.margin = (mg >= 0 && mg < 1) ? mg : DEFAULTS.margin;
    configCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error('[Pricing] getPricingConfig error:', e.message);
    return { ...DEFAULTS };
  }
}

async function setPricingConfig({ mode, fixedRate, margin }, updatedBy = 'admin') {
  const admin = require('firebase-admin');
  const db = admin.firestore();
  const patch = { updatedAt: new Date().toISOString(), updatedBy };
  if (mode !== undefined) {
    if (!['fixed', 'rate'].includes(mode)) throw new Error('mode must be "fixed" or "rate"');
    patch.mode = mode;
  }
  if (fixedRate !== undefined) {
    const fr = parseFloat(fixedRate);
    if (!(fr > 0 && fr < 5)) throw new Error('fixedRate must be between 0 and 5');
    patch.fixedRate = fr;
  }
  if (margin !== undefined) {
    const mg = parseFloat(margin);
    if (!(mg >= 0 && mg < 1)) throw new Error('margin must be between 0 and 0.99');
    patch.margin = mg;
  }
  await db.collection('settings').doc('pricing').set(patch, { merge: true });
  configCache = { data: null, ts: 0 }; // invalida cache
  return getPricingConfig(true);
}

// Retorna o fator BRL/CNY atual (respeitando o modo selecionado)
async function getConversionFactor() {
  const cfg = await getPricingConfig();
  if (cfg.mode === 'rate') {
    try {
      const rate = await fetchExchangeRate();
      return rate > 0 ? rate : cfg.fixedRate;
    } catch {
      return cfg.fixedRate;
    }
  }
  return cfg.fixedRate;
}

// Converte preço CNY → BRL de venda (com margem aplicada)
async function salePriceBRL(cny) {
  if (!cny || cny <= 0) return 0;
  const cfg = await getPricingConfig();
  const factor = await getConversionFactor();
  return Math.round(cny * factor * (1 + cfg.margin) * 100) / 100;
}

// Converte preço CNY → BRL "original" (sem margem, pro valor strikethrough)
async function originalPriceBRL(cny) {
  if (!cny || cny <= 0) return 0;
  const factor = await getConversionFactor();
  return Math.round(cny * factor * 100) / 100;
}

// Versão síncrona pra quando já temos o factor/config em mãos (ex: loop de top-sellers)
function applyPricing(cny, factor, margin = 0) {
  if (!cny || cny <= 0) return 0;
  return Math.round(cny * factor * (1 + margin) * 100) / 100;
}

exports.getPricingConfig = getPricingConfig;
exports.setPricingConfig = setPricingConfig;
exports.getConversionFactor = getConversionFactor;
exports.salePriceBRL = salePriceBRL;
exports.originalPriceBRL = originalPriceBRL;
exports.applyPricing = applyPricing;
exports.DEFAULTS = DEFAULTS;
