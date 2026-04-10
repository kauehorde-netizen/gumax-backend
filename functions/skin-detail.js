// ═══ Gumax — Skin Detail Endpoint ═══
// Returns single skin detail with all platform prices and available data

const https = require('https');

function parsePrice(obj, source = 'buff') {
  if (!obj) return 0;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'object' && source in obj) return parseFloat(obj[source]) || 0;
  return 0;
}

function rd(val) {
  return Math.round(val * 100) / 100;
}

async function fetchPricempireDetail(skinName, apiKey) {
  try {
    const response = await fetch(`https://api.pricempire.com/v4/cs2/item/${encodeURIComponent(skinName)}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'Gumax-Backend/1.0'
      },
      timeout: 10000
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.log('[SkinDetail] Pricempire error:', e.message);
    return null;
  }
}

async function fetchExchangeRate() {
  if (global._rateCache && global._rateCache.ts && Date.now() - global._rateCache.ts < 60 * 60 * 1000) {
    return global._rateCache.value;
  }

  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', {
      timeout: 5000
    });
    const data = await response.json();
    const rate = data.rates?.BRL || 0.68;

    global._rateCache = { value: rate, ts: Date.now() };
    return rate;
  } catch (e) {
    return global._rateCache?.value || 0.68;
  }
}

async function getFirestoreConfig() {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const doc = await db.collection('config').doc('store').get();
    return doc.data() || {};
  } catch (e) {
    return {};
  }
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: H, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { name } = body;

    if (!name || !name.trim()) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Skin name required' }) };
    }

    const PRICEMPIRE_KEY = process.env.PRICEMPIRE_API_KEY;
    if (!PRICEMPIRE_KEY) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'API not configured' }) };
    }

    // Fetch data in parallel
    const [priceData, rate, config] = await Promise.all([
      fetchPricempireDetail(name, PRICEMPIRE_KEY),
      fetchExchangeRate(),
      getFirestoreConfig()
    ]);

    if (!priceData) {
      return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Skin not found' }) };
    }

    const margin = config.margin || 15;
    const categoryMargins = config.categoryMargins || {};

    // Extract prices from all platforms (in CNY)
    const pricesCNY = {
      buff: parsePrice(priceData, 'buff') || 0,
      youpin: parsePrice(priceData, 'youpin') || 0,
      c5game: parsePrice(priceData, 'c5game') || 0,
      steam: parsePrice(priceData, 'steam') || 0,
      csfloat: parsePrice(priceData, 'csfloat') || 0,
      csmoney: parsePrice(priceData, 'csmoney') || 0
    };

    // Use the lowest available price as the "best" price
    const bestCNY = Math.min(...Object.values(pricesCNY).filter(p => p > 0)) || 0;

    // Apply margin
    const categoryMargin = categoryMargins[priceData.type || 'Weapon Skin'] || margin;
    const marginedPrice = bestCNY * (1 + (categoryMargin / 100));

    // Convert to BRL
    const pricesBRL = {};
    for (const [source, cnyPrice] of Object.entries(pricesCNY)) {
      pricesBRL[source] = cnyPrice > 0 ? rd(cnyPrice * rate) : 0;
    }

    const bestBRL = rd(marginedPrice * rate);

    // Build response
    const detail = {
      success: true,
      name: name,
      type: priceData.type || 'Weapon Skin',
      rarity: priceData.rarity || 'Common',
      collection: priceData.collection || '',
      description: priceData.description || '',

      // Pricing
      prices: {
        lowest: {
          source: Object.entries(pricesCNY).filter(([, p]) => p === bestCNY)[0]?.[0] || 'buff',
          cny: rd(bestCNY),
          brl: rd(bestCNY * rate),
          withMargin: bestBRL
        },
        allPlatforms: {
          cny: pricesCNY,
          brl: pricesBRL
        }
      },

      // Margin info
      margin: {
        percentage: categoryMargin,
        basePrice: rd(bestCNY * rate),
        finalPrice: bestBRL,
        profitMargin: rd(bestBRL - bestCNY * rate)
      },

      // Availability
      inStock: false, // Check Firestore separately if needed
      exchangeRate: rd(rate),

      // Additional details
      icon: priceData.icon || '',
      wear: priceData.wear || '',
      float: priceData.float || null,
      paintSeed: priceData.paintSeed || null,
      stickers: priceData.stickers || [],

      // Meta
      lastUpdated: priceData.lastUpdated || new Date().toISOString(),
      source: 'pricempire'
    };

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify(detail)
    };

  } catch (e) {
    console.error('[SkinDetail] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
