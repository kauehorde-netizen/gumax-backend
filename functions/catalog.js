// ═══ Gumax — Catalog Endpoint (Pricempire-based) ═══
// Retorna catálogo paginado de skins com preços da Pricempire (fonte: Youpin).
// Suporta filtros: category, search, priceRange, deliveryType.
// Suporta ordenação: price, name, discount.

const { fetchPricempireItems, getYoupinPrice, buildIconUrl } = require('./pricempire');

// Cotação CNY→BRL (Pricempire retorna em CNY)
async function fetchExchangeRate() {
  if (global._cnyBrlCache && global._cnyBrlCache.ts && Date.now() - global._cnyBrlCache.ts < 60 * 60 * 1000) {
    return global._cnyBrlCache.value;
  }
  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', { timeout: 5000 });
    const data = await response.json();
    const rate = data.rates?.BRL || 0.68;
    global._cnyBrlCache = { value: rate, ts: Date.now() };
    console.log(`[Catalog] Exchange rate: CNY 1 = BRL ${rate.toFixed(3)}`);
    return rate;
  } catch (e) {
    console.error('[Catalog] Exchange rate error:', e.message);
    return global._cnyBrlCache?.value || 0.68;
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
      items.push({ id: doc.id, ...doc.data() });
    });
    return items;
  } catch (e) {
    console.log('[Catalog] Firestore stock not available');
    return [];
  }
}

function calculateMargin(price, margin, categoryMargins = {}, category = '') {
  const categoryMargin = categoryMargins[category] ?? margin;
  return price * (1 + (categoryMargin / 100));
}

function rd(val) {
  return Math.round(val * 100) / 100;
}

// Heurística simples pra categorizar pelo nome (Rifles/Pistolas/AWP/Facas/Luvas)
function inferCategory(name) {
  const n = name.toLowerCase();
  if (/★.*glove|gloves/.test(n)) return 'Luvas';
  if (/★/.test(n)) return 'Facas';
  if (/awp\s*\|/.test(n)) return 'AWP';
  if (/(ak-47|m4a4|m4a1-s|famas|galil|aug|sg\s553|ssg\s08|scar-20|g3sg1|sawed-off|nova|xm1014|mag-7|m249|negev|mp5-sd|mp7|mp9|mac-10|ump-45|p90|pp-bizon)\s*\|/.test(n)) return 'Rifles';
  if (/(glock|usp-s|p2000|p250|five-seven|tec-9|cz75|desert\s*eagle|deagle|dual\s*berettas|r8\s*revolver)\s*\|/.test(n)) return 'Pistolas';
  return 'Outros';
}

function inferRarity(name) {
  // Skinport não retorna raridade; vamos deixar "Common" como default e
  // permitir que o admin atribua pela collection `stock` pra itens em stock
  return 'Common';
}

function inferWearFromName(name) {
  if (name.includes('Factory New')) return 'FN';
  if (name.includes('Minimal Wear')) return 'MW';
  if (name.includes('Field-Tested')) return 'FT';
  if (name.includes('Well-Worn')) return 'WW';
  if (name.includes('Battle-Scarred')) return 'BS';
  return 'FT';
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
      sortBy = 'price',
      sortOrder = 'asc',
    } = body;

    // Fetch paralelo: Pricempire bulk (Youpin-base), taxa CNY→BRL, config, estoque
    const [pricempireItems, rate, config, inStock] = await Promise.all([
      fetchPricempireItems(),
      fetchExchangeRate(),
      getFirestoreConfig(),
      deliveryType === 'full' ? getInStockItems() : Promise.resolve([]),
    ]);

    const margin = config.margin ?? 15;
    const categoryMargins = config.categoryMargins || {};

    let items = [];

    if (deliveryType === 'full' && inStock.length > 0) {
      // "Full" delivery: só itens em estoque admin (sincronizados via Steam Inventory)
      for (const stock of inStock) {
        const buyPriceCNY = stock.buyPriceCNY || stock.buyPrice || 0;
        const marginedCNY = calculateMargin(buyPriceCNY, margin, categoryMargins, stock.type || '');
        const brlPrice = rd(marginedCNY * rate);
        items.push({
          id: stock.id,
          name: stock.name,
          price: brlPrice,
          originalPrice: rd(buyPriceCNY * rate),
          discount: buyPriceCNY > 0 ? rd(((marginedCNY - buyPriceCNY) / buyPriceCNY) * 100) : 0,
          wear: stock.wear || 'N/A',
          float: stock.float || null,
          rarity: stock.rarity || 'Common',
          type: stock.type || 'Weapon Skin',
          iconUrl: stock.iconUrl || '',
          inStock: true,
          deliveryDays: config.deliveryFullTime || 30,
          source: 'full',
        });
      }
    } else {
      // "Normal" delivery: catálogo Pricempire (preço Youpin) com margem
      for (const [name, it] of Object.entries(pricempireItems)) {
        const cnyPrice = getYoupinPrice(it);
        if (!Number.isFinite(cnyPrice) || cnyPrice <= 0) continue;

        const cat = it.type || inferCategory(name);
        const marginedCNY = calculateMargin(cnyPrice, margin, categoryMargins, cat);
        const brlPrice = rd(marginedCNY * rate);

        items.push({
          id: name.replace(/\s+/g, '_').slice(0, 120),
          name,
          price: brlPrice,
          originalPrice: rd(cnyPrice * rate),
          discount: rd(((marginedCNY - cnyPrice) / cnyPrice) * 100),
          wear: inferWearFromName(name),
          float: null,
          rarity: it.rarity || inferRarity(name),
          type: cat,
          iconUrl: buildIconUrl(it.icon),
          inStock: false,
          deliveryDays: config.deliveryNormalTime || 720,
          source: 'pricempire',
        });
      }
    }

    // Filtros
    if (search && search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(i => i.name.toLowerCase().includes(q));
    }
    if (category) {
      items = items.filter(i => i.type === category);
    }
    items = items.filter(i => i.price >= minPrice && i.price <= maxPrice);

    // Ordenação
    if (sortBy === 'price') {
      items.sort((a, b) => sortOrder === 'asc' ? a.price - b.price : b.price - a.price);
    } else if (sortBy === 'name') {
      items.sort((a, b) => sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
    } else if (sortBy === 'discount') {
      items.sort((a, b) => sortOrder === 'asc' ? a.discount - b.discount : b.discount - a.discount);
    }

    // Paginação
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
        pagination: { page, limit, total, totalPages },
        exchangeRate: { cnyBrl: rd(rate) },
        margin,
        deliveryType,
        source: deliveryType === 'full' ? 'stock' : 'pricempire',
      }),
    };
  } catch (e) {
    console.error('[Catalog] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
