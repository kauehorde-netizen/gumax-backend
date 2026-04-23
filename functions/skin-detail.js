// ═══ Gumax — Skin Detail Endpoint ═══
// Retorna detalhes de uma skin específica com preços.
// Stack:
//   • Skinport (primary, USD) — gratuito, bulk cacheado
//   • Steam Market (secondary, BRL) — gratuito, cache 24h
//   • Pricempire (opcional, CNY) — só se PRICEMPIRE_API_KEY estiver setado

const { getSkinportItem } = require('./skinport');
const { getSteamPrice } = require('./steam-market');

function rd(val) {
  return val == null || !Number.isFinite(val) ? null : Math.round(val * 100) / 100;
}

async function fetchUsdBrl() {
  if (global._usdBrlCache && global._usdBrlCache.ts && Date.now() - global._usdBrlCache.ts < 60 * 60 * 1000) {
    return global._usdBrlCache.value;
  }
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 5000 });
    const d = await r.json();
    const rate = d.rates?.BRL || 5.1;
    global._usdBrlCache = { value: rate, ts: Date.now() };
    return rate;
  } catch { return global._usdBrlCache?.value || 5.1; }
}

async function fetchCnyBrl() {
  if (global._cnyBrlCache && global._cnyBrlCache.ts && Date.now() - global._cnyBrlCache.ts < 60 * 60 * 1000) {
    return global._cnyBrlCache.value;
  }
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', { timeout: 5000 });
    const d = await r.json();
    const rate = d.rates?.BRL || 0.68;
    global._cnyBrlCache = { value: rate, ts: Date.now() };
    return rate;
  } catch { return global._cnyBrlCache?.value || 0.68; }
}

async function fetchPricempireDetail(skinName) {
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(`https://api.pricempire.com/v4/cs2/item/${encodeURIComponent(skinName)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': 'Gumax-Backend/1.0' },
      timeout: 10000,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.log('[SkinDetail] Pricempire error:', e.message);
    return null;
  }
}

async function getFirestoreConfig() {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const doc = await db.collection('config').doc('store').get();
    return doc.data() || {};
  } catch { return {}; }
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { name } = body;
    if (!name || !name.trim()) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Skin name required' }) };
    }

    // Fetch paralelo (todos optional)
    const [skinportItem, steam, pricempire, usdRate, cnyRate, config] = await Promise.all([
      getSkinportItem(name),
      getSteamPrice(name),
      fetchPricempireDetail(name),
      fetchUsdBrl(),
      fetchCnyBrl(),
      getFirestoreConfig(),
    ]);

    // Pelo menos uma fonte tem que ter retornado preço
    const hasSkinport = skinportItem && skinportItem.min_price != null;
    const hasSteam = steam && steam.lowest_price_brl != null;
    const hasPricempire = pricempire != null;

    if (!hasSkinport && !hasSteam && !hasPricempire) {
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Skin not found in any source', name }) };
    }

    const margin = config.margin ?? 15;
    const categoryMargins = config.categoryMargins || {};

    // Preços em BRL por plataforma
    const pricesBRL = {};
    if (hasSkinport) pricesBRL.skinport = rd(skinportItem.min_price * usdRate);
    if (hasSteam) pricesBRL.steam = rd(steam.lowest_price_brl);
    if (hasPricempire) {
      const plats = ['buff', 'youpin', 'c5game', 'csfloat', 'csmoney', 'dmarket', 'waxpeer'];
      for (const p of plats) {
        const v = parseFloat(pricempire[p]) || 0;
        if (v > 0) pricesBRL[p] = rd(v * cnyRate);
      }
    }

    const validPrices = Object.entries(pricesBRL).filter(([, v]) => v != null && v > 0);
    if (!validPrices.length) {
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'No valid prices', name }) };
    }

    const lowest = validPrices.reduce((min, cur) => cur[1] < min[1] ? cur : min, validPrices[0]);
    const lowestSrc = lowest[0];
    const bestBRL = lowest[1];
    const categoryMargin = categoryMargins[pricempire?.type || 'Weapon Skin'] ?? margin;
    const finalBRL = rd(bestBRL * (1 + categoryMargin / 100));

    const detail = {
      success: true,
      name,
      type: pricempire?.type || 'Weapon Skin',
      rarity: pricempire?.rarity || skinportItem?.rarity || 'Common',
      collection: pricempire?.collection || '',
      description: pricempire?.description || '',

      prices: {
        lowest: {
          source: lowestSrc,
          brl: bestBRL,
          withMargin: finalBRL,
        },
        allPlatforms: { brl: pricesBRL },
      },

      margin: {
        percentage: categoryMargin,
        basePrice: bestBRL,
        finalPrice: finalBRL,
        profitMargin: rd(finalBRL - bestBRL),
      },

      inStock: false,
      exchangeRate: { usdBrl: rd(usdRate, 3), cnyBrl: rd(cnyRate, 3) },

      icon: pricempire?.icon || '',
      wear: pricempire?.wear || '',
      float: pricempire?.float || null,
      paintSeed: pricempire?.paintSeed || null,
      stickers: pricempire?.stickers || [],

      sources: {
        skinport: hasSkinport,
        steam: hasSteam,
        pricempire: hasPricempire,
      },
      volume: {
        steam: steam?.volume || 0,
        skinport: skinportItem?.quantity || 0,
      },

      lastUpdated: new Date().toISOString(),
      source: lowestSrc,
    };

    return { statusCode: 200, headers: H, body: JSON.stringify(detail) };
  } catch (e) {
    console.error('[SkinDetail] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
