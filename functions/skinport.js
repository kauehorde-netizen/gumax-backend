// ═══ Gumax — Skinport API Wrapper ═══
// Bulk fetch do catálogo CS2 inteiro da Skinport (gratuito, sem API key).
// Cache em memória por 5 min pra alinhar com cache deles (evita hammering).
//
// Endpoint público exposto:
//   GET /api/skinport/items                 → retorna catálogo agrupado por market_hash_name
//   POST /api/skinport/item { name }        → retorna dados de 1 item específico
//
// Dados retornados por item:
//   { market_hash_name, min_price, suggested_price, quantity, currency, item_page }
//
// Preços sempre em USD — converter pra BRL no caller usando exchange-rate.

const SKINPORT_URL = 'https://api.skinport.com/v1/items?app_id=730&currency=USD';
const SKINPORT_CACHE_TTL = 5 * 60 * 1000; // 5 min

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// ── Fetch com cache de 5 min ──────────────────────────────────────────────
async function fetchSkinportItems() {
  if (global._skinportCache
      && global._skinportCache.ts
      && Date.now() - global._skinportCache.ts < SKINPORT_CACHE_TTL) {
    return global._skinportCache.data;
  }

  try {
    console.log('[Skinport] Fetching full catalog...');
    const resp = await fetch(SKINPORT_URL, {
      headers: { 'User-Agent': 'Gumax-Backend/1.0', Accept: 'application/json' },
      timeout: 30000,
    });
    if (!resp.ok) throw new Error(`Skinport API error: ${resp.status}`);
    const arr = await resp.json();
    if (!Array.isArray(arr)) throw new Error('Skinport: unexpected response shape');

    // Indexa por market_hash_name pra lookup O(1) no caller
    const byName = Object.create(null);
    for (const it of arr) {
      if (!it || !it.market_hash_name) continue;
      byName[it.market_hash_name] = {
        market_hash_name: it.market_hash_name,
        min_price: it.min_price,            // pode ser null quando não há listings
        suggested_price: it.suggested_price,
        quantity: it.quantity || 0,
        currency: it.currency || 'USD',
        item_page: it.item_page || null,
        market_page: it.market_page || null,
      };
    }

    global._skinportCache = { data: byName, ts: Date.now() };
    console.log(`[Skinport] Cached ${Object.keys(byName).length} items`);
    return byName;
  } catch (e) {
    console.error('[Skinport] Fetch error:', e.message);
    // Devolve último cache mesmo expirado, se houver — melhor do que array vazio
    if (global._skinportCache?.data) return global._skinportCache.data;
    return {};
  }
}

// ── Handler HTTP ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const path = event.path || '';

  // GET /api/skinport/items — retorna índice inteiro (~2-3MB JSON)
  if (event.httpMethod === 'GET' && path.endsWith('/items')) {
    const items = await fetchSkinportItems();
    const names = Object.keys(items);
    return json(200, {
      count: names.length,
      cachedAt: global._skinportCache?.ts || null,
      items,
    });
  }

  // POST /api/skinport/item { name } — retorna dados de 1 item
  if (event.httpMethod === 'POST' && path.endsWith('/item')) {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }
    const name = body.name;
    if (!name) return json(400, { error: 'name is required' });

    const items = await fetchSkinportItems();
    const it = items[name];
    if (!it) return json(404, { error: 'not_found', name });
    return json(200, it);
  }

  return json(405, { error: 'Method not allowed' });
};

// Helper exportado para ser chamado direto pelos outros módulos (sem HTTP)
exports.fetchSkinportItems = fetchSkinportItems;
exports.getSkinportItem = async (name) => {
  const items = await fetchSkinportItems();
  return items[name] || null;
};
