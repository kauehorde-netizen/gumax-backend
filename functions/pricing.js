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
// MODELO:
//   fixed → fator_final = fixedRate (user escolhe direto o R$/¥ final)
//   rate  → fator_final = googleRate + surcharge (cotação ao vivo + R$ fixos de lucro)
const DEFAULTS = Object.freeze({
  mode: 'fixed',       // 'fixed' | 'rate'
  fixedRate: 0.78,     // BRL por CNY — usado no modo fixed
  surcharge: 0.04,     // R$ extras somados à cotação — usado no modo rate
  margin: 0,           // DEPRECATED — mantido pra retro-compat, não aplicado
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
    const sc = parseFloat(data.surcharge);
    data.surcharge = (sc >= 0 && sc < 2) ? sc : DEFAULTS.surcharge;
    // margin deprecated — sempre 0
    data.margin = 0;
    configCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error('[Pricing] getPricingConfig error:', e.message);
    return { ...DEFAULTS };
  }
}

async function setPricingConfig({ mode, fixedRate, surcharge }, updatedBy = 'admin') {
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
  if (surcharge !== undefined) {
    const sc = parseFloat(surcharge);
    if (!(sc >= 0 && sc < 2)) throw new Error('surcharge must be between 0 and 2 R$');
    patch.surcharge = sc;
  }
  await db.collection('settings').doc('pricing').set(patch, { merge: true });
  configCache = { data: null, ts: 0 }; // invalida cache
  return getPricingConfig(true);
}

// Retorna o fator FINAL BRL/CNY já com o lucro aplicado (usado pra preço de venda).
//   fixed → fixedRate (user escolheu direto)
//   rate  → googleRate + surcharge (cotação + R$ fixos)
async function getConversionFactor() {
  const cfg = await getPricingConfig();
  if (cfg.mode === 'rate') {
    try {
      const rate = await fetchExchangeRate();
      return rate > 0 ? rate + (cfg.surcharge || 0) : cfg.fixedRate;
    } catch {
      return cfg.fixedRate;
    }
  }
  return cfg.fixedRate;
}

// Fator bruto (sem o surcharge). Usado pro strikethrough do preço Steam
// que não deve incluir lucro.
async function getBaseFactor() {
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

// Converte preço CNY → BRL de venda (já com lucro aplicado)
async function salePriceBRL(cny) {
  if (!cny || cny <= 0) return 0;
  const factor = await getConversionFactor();
  return Math.round(cny * factor * 100) / 100;
}

// Converte preço CNY → BRL "original" (sem lucro, pro valor strikethrough)
async function originalPriceBRL(cny) {
  if (!cny || cny <= 0) return 0;
  const factor = await getBaseFactor();
  return Math.round(cny * factor * 100) / 100;
}

// Versão síncrona pra quando já temos o factor em mãos (ex: loop de top-sellers).
// O factor passado já deve estar com o lucro aplicado quando apropriado.
function applyPricing(cny, factor) {
  if (!cny || cny <= 0) return 0;
  return Math.round(cny * factor * 100) / 100;
}

exports.getPricingConfig = getPricingConfig;
exports.setPricingConfig = setPricingConfig;
exports.getConversionFactor = getConversionFactor;
exports.getBaseFactor = getBaseFactor;
exports.salePriceBRL = salePriceBRL;
exports.originalPriceBRL = originalPriceBRL;
exports.applyPricing = applyPricing;
exports.DEFAULTS = DEFAULTS;
