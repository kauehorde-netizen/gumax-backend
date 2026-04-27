// ═══ Gumax — Skin Detail Endpoint ═══
// Retorna detalhes de uma skin específica com preços.
// Stack:
//   • Pricempire (primary, CNY — fonte canônica, Youpin-base)
//   • Steam Market (complementar, BRL — cache 24h)

// Migrado pra CSPriceAPI (Trader Pro). Mesma signature exportada.
const { getPricempireItem, getYoupinPrice, buildIconUrl } = require('./cspriceapi');
const { getSteamPrice } = require('./steam-market');

function rd(val) {
  return val == null || !Number.isFinite(val) ? null : Math.round(val * 100) / 100;
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

    // Fetch paralelo: Pricempire (primary) + Steam Market (complementar)
    const [pricempireItem, steam, cnyRate, config] = await Promise.all([
      getPricempireItem(name),
      getSteamPrice(name),
      fetchCnyBrl(),
      getFirestoreConfig(),
    ]);

    const hasSteam = steam && steam.lowest_price_brl != null;
    const hasPricempire = pricempireItem != null;

    if (!hasSteam && !hasPricempire) {
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Skin not found in any source', name }) };
    }

    const margin = config.margin ?? 15;
    const categoryMargins = config.categoryMargins || {};

    // Preços em BRL por plataforma (Pricempire tem todos os marketplaces; Steam vem separado)
    const pricesBRL = {};
    if (hasPricempire) {
      const plats = ['buff', 'youpin', 'c5game', 'csfloat', 'csmoney', 'dmarket', 'waxpeer'];
      for (const p of plats) {
        const v = parseFloat(pricempireItem[p]) || 0;
        if (v > 0) pricesBRL[p] = rd(v * cnyRate);
      }
    }
    if (hasSteam) pricesBRL.steam = rd(steam.lowest_price_brl);

    const validPrices = Object.entries(pricesBRL).filter(([, v]) => v != null && v > 0);
    if (!validPrices.length) {
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'No valid prices', name }) };
    }

    // Preço base = Youpin (canônico), ou o mais barato disponível
    const baseBRL = pricesBRL.youpin || validPrices.reduce((min, cur) => cur[1] < min[1] ? cur : min, validPrices[0])[1];
    const baseSrc = pricesBRL.youpin ? 'youpin' : validPrices.reduce((min, cur) => cur[1] < min[1] ? cur : min, validPrices[0])[0];
    const categoryMargin = categoryMargins[pricempireItem?.type || 'Weapon Skin'] ?? margin;
    const finalBRL = rd(baseBRL * (1 + categoryMargin / 100));

    const detail = {
      success: true,
      name,
      type: pricempireItem?.type || 'Weapon Skin',
      rarity: pricempireItem?.rarity || 'Common',
      collection: pricempireItem?.collection || '',
      description: pricempireItem?.description || '',

      prices: {
        lowest: {
          source: baseSrc,
          brl: baseBRL,
          withMargin: finalBRL,
        },
        allPlatforms: { brl: pricesBRL },
      },

      margin: {
        percentage: categoryMargin,
        basePrice: baseBRL,
        finalPrice: finalBRL,
        profitMargin: rd(finalBRL - baseBRL),
      },

      inStock: false,
      exchangeRate: { cnyBrl: rd(cnyRate, 3) },

      icon: buildIconUrl(pricempireItem?.icon) || '',
      wear: pricempireItem?.wear || '',
      float: pricempireItem?.float || null,
      paintSeed: pricempireItem?.paintSeed || null,
      stickers: pricempireItem?.stickers || [],

      sources: {
        steam: hasSteam,
        pricempire: hasPricempire,
      },
      volume: {
        steam: steam?.volume || 0,
      },

      lastUpdated: new Date().toISOString(),
      source: baseSrc,
    };

    return { statusCode: 200, headers: H, body: JSON.stringify(detail) };
  } catch (e) {
    console.error('[SkinDetail] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
