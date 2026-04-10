// ═══ Gumax — Catalog Endpoint ═══
// Returns paginated skin catalog with prices (Pricempire + margin)
// Supports filters: category, search, priceRange, deliveryType
// Supports sorting: price, name, discount

const https = require('https');

// Global cache for Pricempire prices (15 minutes)
const PRICE_CACHE_TTL = 15 * 60 * 1000;

function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 10000;
    const options = {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(opts.headers || {}),
      },
    };
    const req = https.get(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchPricempirePrices(apiKey) {
  // Check cache
  if (global._priceCache && global._priceCache.ts && Date.now() - global._priceCache.ts < PRICE_CACHE_TTL) {
    console.log('[Catalog] Using cached Pricempire prices');
    return global._priceCache.data || {};
  }

  try {
    console.log('[Catalog] Fetching Pricempire prices...');
    const response = await fetch('https://api.pricempire.com/v4/cs2/items/all', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'Gumax-Backend/1.0'
      },
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`Pricempire API error: ${response.status}`);
    }

    const data = await response.json();
    const prices = {};

    // Format: { "item_name": { "buff": 123.45, "youpin": 120.00, ... } }
    if (data && typeof data === 'object') {
      for (const [name, priceData] of Object.entries(data)) {
        prices[name] = priceData;
      }
    }

    global._priceCache = {
      data: prices,
      ts: Date.now()
    };

    console.log(`[Catalog] Cached ${Object.keys(prices).length} items`);
    return prices;
  } catch (e) {
    console.error('[Catalog] Pricempire fetch error:', e.message);
    // Return empty prices on error (catalog will show "not priced" items)
    return {};
  }
}

async function fetchExchangeRate() {
  // Check cache (60 min)
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
    console.log(`[Catalog] Exchange rate: CNY 1 = BRL ${rate.toFixed(3)}`);
    return rate;
  } catch (e) {
    console.error('[Catalog] Exchange rate error:', e.message);
    return global._rateCache?.value || 0.68; // fallback
  }
}

async function getFirestoreConfig() {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const doc = await db.collection('config').doc('store').get();
    return doc.data() || {};
  } catch (e) {
    console.log('[Catalog] Firestore config not available');
    return {};
  }
}

async function getInStockItems() {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const snapshot = await db.collection('stock').get();
    const items = [];
    snapshot.forEach(doc => {
      items.push({
        id: doc.id,
        ...doc.data()
      });
    });
    return items;
  } catch (e) {
    console.log('[Catalog] Firestore stock not available');
    return [];
  }
}

function calculateMargin(price, margin, categoryMargins = {}, category = '') {
  const categoryMargin = categoryMargins[category] || margin;
  return price * (1 + (categoryMargin / 100));
}

function parsePrice(obj, source = 'buff') {
  if (!obj) return 0;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'object' && source in obj) return parseFloat(obj[source]) || 0;
  return 0;
}

function rd(val) {
  return Math.round(val * 100) / 100;
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
    const {
      page = 1,
      limit = 20,
      category = null,
      search = '',
      minPrice = 0,
      maxPrice = 999999,
      deliveryType = 'normal', // 'full' or 'normal'
      sortBy = 'price', // 'price', 'name', 'discount'
      sortOrder = 'asc' // 'asc' or 'desc'
    } = body;

    const PRICEMPIRE_KEY = process.env.PRICEMPIRE_API_KEY;
    if (!PRICEMPIRE_KEY) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'API not configured' }) };
    }

    // Fetch data in parallel
    const [prices, rate, config, inStock] = await Promise.all([
      fetchPricempirePrices(PRICEMPIRE_KEY),
      fetchExchangeRate(),
      getFirestoreConfig(),
      deliveryType === 'full' ? getInStockItems() : Promise.resolve([])
    ]);

    const margin = config.margin || 15;
    const categoryMargins = config.categoryMargins || {};

    // Build catalog based on delivery type
    let items = [];

    if (deliveryType === 'full' && inStock.length > 0) {
      // "Full" delivery: only in-stock items managed by admin
      for (const stock of inStock) {
        const cnyPrice = stock.buyPrice || 0;
        const marginedPrice = calculateMargin(cnyPrice, margin, categoryMargins, stock.type || '');
        const brlPrice = rd(marginedPrice * rate);

        items.push({
          id: stock.id,
          name: stock.name,
          price: brlPrice,
          originalPrice: rd(cnyPrice * rate),
          discount: stock.buyPrice > 0 ? rd(((marginedPrice * rate - cnyPrice * rate) / (cnyPrice * rate)) * 100) : 0,
          wear: stock.wear || 'N/A',
          float: stock.float || null,
          rarity: stock.rarity || 'Common',
          type: stock.type || 'Weapon Skin',
          iconUrl: stock.iconUrl || '',
          inStock: true,
          deliveryDays: config.deliveryFullTime || 30,
          source: 'full'
        });
      }
    } else {
      // "Normal" delivery: full Pricempire catalog with margin
      for (const [name, priceData] of Object.entries(prices)) {
        const cnyPrice = parsePrice(priceData, 'buff') || parsePrice(priceData, 'youpin') || 0;
        if (cnyPrice <= 0) continue; // Skip unpriced items

        const marginedPrice = calculateMargin(cnyPrice, margin, categoryMargins, 'Weapon Skin');
        const brlPrice = rd(marginedPrice * rate);

        items.push({
          id: name.replace(/\s+/g, '_'),
          name: name,
          price: brlPrice,
          originalPrice: rd(cnyPrice * rate),
          discount: cnyPrice > 0 ? rd(((marginedPrice * rate - cnyPrice * rate) / (cnyPrice * rate)) * 100) : 0,
          wear: 'Factory New',
          float: null,
          rarity: 'Common',
          type: 'Weapon Skin',
          iconUrl: '',
          inStock: false,
          deliveryDays: config.deliveryNormalTime || 720,
          source: 'pricempire'
        });
      }
    }

    // Apply filters
    if (search && search.trim()) {
      const searchLower = search.toLowerCase();
      items = items.filter(item => item.name.toLowerCase().includes(searchLower));
    }

    if (category) {
      items = items.filter(item => item.type === category);
    }

    items = items.filter(item => item.price >= minPrice && item.price <= maxPrice);

    // Apply sorting
    if (sortBy === 'price') {
      items.sort((a, b) => sortOrder === 'asc' ? a.price - b.price : b.price - a.price);
    } else if (sortBy === 'name') {
      items.sort((a, b) => sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
    } else if (sortBy === 'discount') {
      items.sort((a, b) => sortOrder === 'asc' ? a.discount - b.discount : b.discount - a.discount);
    }

    // Apply pagination
    const total = items.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const paginatedItems = items.slice(offset, offset + limit);

    console.log(`[Catalog] Returned ${paginatedItems.length}/${total} items (page ${page}/${totalPages})`);

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        success: true,
        items: paginatedItems,
        pagination: {
          page,
          limit,
          total,
          totalPages
        },
        exchangeRate: rd(rate),
        margin: margin,
        deliveryType: deliveryType
      })
    };

  } catch (e) {
    console.error('[Catalog] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
