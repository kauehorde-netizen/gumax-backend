// ═══ Gumax — Pricempire API Wrapper ═══
// Fonte canônica de preços do ecossistema Gumax. A gente PAGA a Pricempire (v4),
// então puxamos o catálogo CS2 inteiro em uma chamada bulk e cacheamos em memória.
//
// Preço base usado em todo o site = `youpin` (em CNY).
// Outros marketplaces (buff, c5game, csfloat, dmarket, etc) vem junto e podem
// aparecer na análise comparativa tier full.
//
// Endpoints expostos:
//   GET  /api/pricempire/items       → catálogo inteiro (usado raramente, é grande)
//   POST /api/pricempire/item        → busca por nome (com fuzzy match)
//   GET  /api/pricempire/suggest     → autocomplete
//
// Estrutura do item retornado pelo Pricempire v4 (campos que usamos):
//   {
//     "market_hash_name": "AK-47 | Redline (Field-Tested)",
//     "buff":     12.34,   // CNY
//     "youpin":   11.90,   // CNY  ← preço base
//     "c5game":   12.50,   // CNY
//     "steam":    22.10,   // CNY (fee 15% já embutido)
//     "csfloat":  13.20,   // CNY
//     "csmoney":  12.80,   // CNY
//     "dmarket":  14.00,   // CNY
//     "waxpeer":  12.60,   // CNY
//     "type":     "Weapon Skin",
//     "rarity":   "Classified",
//     "icon":     "-9a81d...",  (hash, completar com https://community.../image/HASH/360fx360f)
//     "lastUpdated": "2026-04-23T..."
//   }

const PRICEMPIRE_URL = 'https://api.pricempire.com/v4/cs2/items/all';
const CACHE_TTL = 15 * 60 * 1000; // 15 min

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// Busca catálogo inteiro da Pricempire, com cache em memória
async function fetchPricempireItems() {
  if (global._pricempireCache
      && global._pricempireCache.ts
      && Date.now() - global._pricempireCache.ts < CACHE_TTL) {
    return global._pricempireCache.data;
  }
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey) {
    console.warn('[Pricempire] PRICEMPIRE_API_KEY not configured');
    return global._pricempireCache?.data || {};
  }
  try {
    console.log('[Pricempire] Fetching full catalog...');
    const resp = await fetch(PRICEMPIRE_URL, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'Gumax-Backend/1.0',
      },
      timeout: 30000,
    });
    if (!resp.ok) throw new Error(`Pricempire error: ${resp.status}`);
    const raw = await resp.json();

    // A API retorna { "AK-47 | Redline (Field-Tested)": {buff, youpin, ...}, ... }
    // OU array de objetos com market_hash_name. Tratamos os dois casos.
    const byName = Object.create(null);
    if (Array.isArray(raw)) {
      for (const it of raw) {
        if (!it || !it.market_hash_name) continue;
        byName[it.market_hash_name] = { ...it, market_hash_name: it.market_hash_name };
      }
    } else if (raw && typeof raw === 'object') {
      for (const [name, data] of Object.entries(raw)) {
        byName[name] = { market_hash_name: name, ...data };
      }
    }

    global._pricempireCache = { data: byName, ts: Date.now() };
    console.log(`[Pricempire] Cached ${Object.keys(byName).length} items`);
    return byName;
  } catch (e) {
    console.error('[Pricempire] Fetch error:', e.message);
    return global._pricempireCache?.data || {};
  }
}

// Normaliza nome pra matching fuzzy (mesmo padrão do skinport.js antigo)
const WEAR_ABBR = {
  '\\bfn\\b': 'factory new',
  '\\bmw\\b': 'minimal wear',
  '\\bft\\b': 'field tested',
  '\\bww\\b': 'well worn',
  '\\bbs\\b': 'battle scarred',
  '\\bst\\b': 'stattrak',
};
function normalizeName(s) {
  let out = String(s || '')
    .toLowerCase()
    .replace(/[|()★™\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [abbr, full] of Object.entries(WEAR_ABBR)) {
    out = out.replace(new RegExp(abbr, 'g'), full);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Busca exata + fuzzy match por nome
async function getPricempireItem(name) {
  const items = await fetchPricempireItems();
  if (!name) return null;

  // 1. Exato
  if (items[name]) return items[name];

  // 2. Normalizado exato
  const q = normalizeName(name);
  if (!q) return null;

  const candidates = [];
  for (const [key, item] of Object.entries(items)) {
    const k = normalizeName(key);
    if (k === q) return { ...item, market_hash_name: key, matchedAs: 'normalized' };
    const words = q.split(' ');
    if (words.every(w => k.includes(w))) {
      candidates.push({ key, item, score: Math.abs(k.length - q.length) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  return { ...candidates[0].item, market_hash_name: candidates[0].key, matchedAs: 'fuzzy' };
}

// Helper: extrai o preço de Youpin (base) em CNY, com fallback pra outras fontes
function getYoupinPrice(item) {
  if (!item) return 0;
  const youpin = parseFloat(item.youpin) || 0;
  if (youpin > 0) return youpin;
  // Fallbacks na ordem: buff (bem correlacionado com Youpin), c5game, csfloat
  const buff = parseFloat(item.buff) || 0;
  if (buff > 0) return buff;
  const c5 = parseFloat(item.c5game) || 0;
  if (c5 > 0) return c5;
  const csfloat = parseFloat(item.csfloat) || 0;
  if (csfloat > 0) return csfloat;
  return 0;
}

// Monta URL completa do icon a partir do hash da Pricempire (ou usa URL se já for completa)
function buildIconUrl(iconField) {
  if (!iconField) return '';
  if (iconField.startsWith('http')) return iconField;
  return `https://community.cloudflare.steamstatic.com/economy/image/${iconField}/360fx360f`;
}

// Sugestões pra autocomplete — top N nomes que contenham as palavras da query
async function suggestSkins(query, limit = 10) {
  const items = await fetchPricempireItems();
  const q = normalizeName(query);
  if (!q) return [];
  const words = q.split(' ');
  const matches = [];
  for (const key of Object.keys(items)) {
    const k = normalizeName(key);
    if (words.every(w => k.includes(w))) {
      matches.push({ name: key, score: Math.abs(k.length - q.length) });
      if (matches.length > 300) break;
    }
  }
  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, limit).map(m => m.name);
}

// Top sellers: sort por preço Youpin entre um range razoável, filtrando skins com
// preços em múltiplas plataformas (= liquidez real). Evita itens super baratos e super caros.
async function getTopSellers(limit = 50, minPriceCNY = 30, maxPriceCNY = 2000) {
  const items = await fetchPricempireItems();
  const candidates = Object.entries(items)
    .map(([name, it]) => ({
      name,
      youpin: getYoupinPrice(it),
      platforms: ['buff', 'youpin', 'c5game', 'csfloat', 'dmarket'].filter(p => parseFloat(it[p]) > 0).length,
      item: it,
    }))
    .filter(x => x.youpin >= minPriceCNY && x.youpin <= maxPriceCNY && x.platforms >= 3)
    // Rankeia por produto: (preço * liquidez) — skins caras + com múltiplas plataformas
    .sort((a, b) => (b.youpin * b.platforms) - (a.youpin * a.platforms));

  return candidates.slice(0, limit).map(x => ({
    name: x.name,
    price_cny: x.youpin,
    rarity: x.item.rarity || 'Common',
    type: x.item.type || 'Weapon Skin',
    iconUrl: buildIconUrl(x.item.icon),
    platforms: x.platforms,
    source: 'pricempire',
  }));
}

// ── Handler HTTP ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  // GET /api/pricempire/items
  if (event.httpMethod === 'GET' && path.endsWith('/items')) {
    const items = await fetchPricempireItems();
    return json(200, { count: Object.keys(items).length, cachedAt: global._pricempireCache?.ts || null });
  }

  // POST /api/pricempire/item { name }
  if (event.httpMethod === 'POST' && path.endsWith('/item')) {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }
    const it = await getPricempireItem(body.name);
    if (!it) return json(404, { error: 'not_found', name: body.name });
    return json(200, it);
  }

  // GET /api/pricempire/suggest?q=redline&limit=10
  if (event.httpMethod === 'GET' && path.endsWith('/suggest')) {
    const q = (event.queryStringParameters || {}).q || '';
    const limit = Math.min(30, Math.max(1, parseInt((event.queryStringParameters || {}).limit, 10) || 10));
    const suggestions = await suggestSkins(q, limit);
    return json(200, { query: q, count: suggestions.length, suggestions });
  }

  return json(405, { error: 'Method not allowed' });
};

exports.fetchPricempireItems = fetchPricempireItems;
exports.getPricempireItem = getPricempireItem;
exports.getYoupinPrice = getYoupinPrice;
exports.buildIconUrl = buildIconUrl;
exports.suggestSkins = suggestSkins;
exports.getTopSellers = getTopSellers;
