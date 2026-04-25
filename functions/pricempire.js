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

// Endpoint correto da Pricempire v4 (descoberto via FlowSkins production).
// Auth via query string `api_key=`. Lista de sources é obrigatória.
const PRICEMPIRE_V4_URL = (key) => `https://api.pricempire.com/v4/paid/items/prices?app_id=730&api_key=${key}&sources=buff163,youpin,steam,csfloat,c5game,csmoney&currency=CNY&avg=false&median=false&inflation_threshold=-1`;
const PRICEMPIRE_V3_URL = (key) => `https://api.pricempire.com/v3/items/prices?api_key=${key}&currency=CNY&appId=730`;
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

// Normaliza: {item_name: {buff163: {price, count}, youpin: {price, count}, ...}}
// → {item_name: {buff: 12.34, youpin: 11.90, youpin_count: 42, ...}, market_hash_name, ...}
// IMPORTANTE: Pricempire v4 paid retorna preço em CENTAVOS. Dividimos por 100.
// Salvamos também o `count` (listings disponíveis = proxy de volume/popularidade).
function normalizeV4Item(marketHashName, priceMap) {
  const flat = { market_hash_name: marketHashName };
  const mapKey = { buff163: 'buff', youpin: 'youpin', steam: 'steam', csfloat: 'csfloat', c5game: 'c5game', csmoney: 'csmoney' };
  for (const [src, mapped] of Object.entries(mapKey)) {
    const entry = priceMap[src];
    if (entry && entry.price != null) {
      flat[mapped] = entry.price / 100;
      if (entry.count != null) flat[mapped + '_count'] = entry.count;
    }
  }
  return flat;
}

// Cache no Firestore — persiste entre restarts do Railway e compartilhado entre instâncias
const FIRESTORE_CACHE_DOC = { col: 'cached_prices', id: 'pricempire_top_sellers' };
// Schema version — incrementa quando mudar estrutura de dados pra invalidar cache antigo
// v4: force reload pra corrigir items que tinham buff:{object} em vez de buff:número (bug v3 fallback)
const CACHE_SCHEMA_VERSION = 4;
// Como o payload é grande (~25k items), salvamos chunks em subcolection
async function loadFromFirestoreCache() {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const mainDoc = await db.collection(FIRESTORE_CACHE_DOC.col).doc(FIRESTORE_CACHE_DOC.id).get();
    if (!mainDoc.exists) return null;
    const meta = mainDoc.data();
    if (!meta || !meta.ts || !meta.chunks) return null;
    // Invalida se schema version do cache não bate com o atual (ex: fix de centavos)
    if (meta.schemaVersion !== CACHE_SCHEMA_VERSION) {
      console.log(`[Pricempire] Firestore cache schema v${meta.schemaVersion} != v${CACHE_SCHEMA_VERSION} — ignorando`);
      return null;
    }
    // Cache válido por até 25h (safe margin em cima do cron 24h)
    if (Date.now() - meta.ts > 25 * 60 * 60 * 1000) return null;

    const chunks = await db.collection(FIRESTORE_CACHE_DOC.col)
      .doc(FIRESTORE_CACHE_DOC.id).collection('chunks').get();
    const byName = Object.create(null);
    chunks.forEach(doc => {
      const items = doc.data()?.items || {};
      for (const [name, data] of Object.entries(items)) {
        byName[name] = { market_hash_name: name, ...data };
      }
    });
    if (Object.keys(byName).length > 0) {
      console.log(`[Pricempire] Loaded ${Object.keys(byName).length} items from Firestore cache (age: ${Math.round((Date.now() - meta.ts)/60000)}min)`);
      return { data: byName, ts: meta.ts, version: meta.version || 'firestore' };
    }
    return null;
  } catch (e) {
    console.log('[Pricempire] Firestore cache read error:', e.message);
    return null;
  }
}

async function saveToFirestoreCache(byName, version) {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const names = Object.keys(byName);
    // Firestore doc limit 1MB; chunks de 2000 items ~ bem dentro
    const CHUNK_SIZE = 2000;
    const chunkCount = Math.ceil(names.length / CHUNK_SIZE);
    for (let i = 0; i < names.length; i += CHUNK_SIZE) {
      const chunk = names.slice(i, i + CHUNK_SIZE);
      const chunkIdx = Math.floor(i / CHUNK_SIZE);
      const payload = {};
      for (const n of chunk) payload[n] = byName[n];
      await db.collection(FIRESTORE_CACHE_DOC.col)
        .doc(FIRESTORE_CACHE_DOC.id).collection('chunks').doc(String(chunkIdx))
        .set({ items: payload }, { merge: false });
    }
    await db.collection(FIRESTORE_CACHE_DOC.col).doc(FIRESTORE_CACHE_DOC.id).set({
      ts: Date.now(),
      version: version || 'v4paid',
      schemaVersion: CACHE_SCHEMA_VERSION,
      chunks: chunkCount,
      count: names.length,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    console.log(`[Pricempire] Saved ${names.length} items to Firestore cache (${chunkCount} chunks)`);
  } catch (e) {
    console.log('[Pricempire] Firestore cache write error:', e.message);
  }
}

// Busca catálogo inteiro via Pricempire v4 paid, com fallback pra v3 se v4 falhar.
// Estratégia de cache (em ordem):
//   1) Memory cache (fast, zera a cada restart)
//   2) Firestore cache (persistente, shared entre instâncias, age < 25h)
//   3) Chamada fresh na Pricempire (5-10s)
async function fetchPricempireItems() {
  // 1) Memory
  if (global._pricempireCache
      && global._pricempireCache.ts
      && Date.now() - global._pricempireCache.ts < CACHE_TTL) {
    return global._pricempireCache.data;
  }
  // 2) Firestore
  const fsCache = await loadFromFirestoreCache();
  if (fsCache) {
    global._pricempireCache = fsCache;
    return fsCache.data;
  }
  // 3) Fresh
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey) {
    console.warn('[Pricempire] PRICEMPIRE_API_KEY not configured');
    return global._pricempireCache?.data || {};
  }

  // ── v4 paid ──
  try {
    console.log('[Pricempire] Fetching v4/paid/items/prices...');
    const resp = await fetch(PRICEMPIRE_V4_URL(apiKey), {
      headers: { 'User-Agent': 'Gumax-Backend/1.0' },
    });
    console.log(`[Pricempire] v4 status=${resp.status}`);
    if (resp.ok) {
      const raw = await resp.json();
      const byName = Object.create(null);
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!entry.market_hash_name) continue;
          const priceMap = {};
          if (Array.isArray(entry.prices)) {
            for (const p of entry.prices) {
              if (p.provider_key && p.price != null) priceMap[p.provider_key] = { price: p.price, count: p.count };
            }
          }
          if (Object.keys(priceMap).length > 0) {
            byName[entry.market_hash_name] = normalizeV4Item(entry.market_hash_name, priceMap);
          }
        }
      } else if (raw && typeof raw === 'object') {
        for (const [name, data] of Object.entries(raw)) {
          byName[name] = normalizeV4Item(name, data);
        }
      }
      if (Object.keys(byName).length > 0) {
        global._pricempireCache = { data: byName, ts: Date.now(), version: 'v4paid' };
        console.log(`[Pricempire] v4 OK — ${Object.keys(byName).length} items`);
        // Salva no Firestore pra próximas instâncias/restarts
        saveToFirestoreCache(byName, 'v4paid').catch(() => {});
        return byName;
      }
      console.warn('[Pricempire] v4 returned empty payload');
    }
  } catch (e) {
    console.error('[Pricempire] v4 error:', e.message);
  }

  // ── v3 fallback ──
  try {
    console.log('[Pricempire] Trying v3 fallback...');
    const resp = await fetch(PRICEMPIRE_V3_URL(apiKey), {
      headers: { 'User-Agent': 'Gumax-Backend/1.0' },
    });
    if (resp.ok) {
      const raw = await resp.json();
      const src = raw?.data || raw || {};
      const byName = Object.create(null);
      for (const [name, data] of Object.entries(src)) {
        if (typeof data === 'object' && data) {
          byName[name] = { market_hash_name: name, ...data };
        }
      }
      if (Object.keys(byName).length > 0) {
        global._pricempireCache = { data: byName, ts: Date.now(), version: 'v3' };
        console.log(`[Pricempire] v3 OK — ${Object.keys(byName).length} items`);
        saveToFirestoreCache(byName, 'v3').catch(() => {});
        return byName;
      }
    }
  } catch (e) {
    console.error('[Pricempire] v3 error:', e.message);
  }

  console.error('[Pricempire] ALL sources failed');
  return global._pricempireCache?.data || {};
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

// Helper defensivo: extrai um preço do campo, seja ele:
//   - número (formato normalizado)            → retorna como está
//   - objeto { price: X, ... }                  → retorna X / 100 (X em centavos)
//   - string                                    → parse
function extractPriceField(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val > 0 ? val : 0;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return n > 0 ? n : 0;
  }
  if (typeof val === 'object' && val.price != null) {
    const n = parseFloat(val.price);
    return n > 0 ? n / 100 : 0;
  }
  return 0;
}

function extractCountField(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val > 0 ? val : 0;
  if (typeof val === 'object' && val.count != null) {
    const n = parseFloat(val.count);
    return n > 0 ? n : 0;
  }
  return parseFloat(val) || 0;
}

// Helper: extrai o preço de Youpin (base) em CNY, com fallback pra outras fontes
function getYoupinPrice(item) {
  if (!item) return 0;
  const youpin = extractPriceField(item.youpin);
  if (youpin > 0) return youpin;
  const buff = extractPriceField(item.buff);
  if (buff > 0) return buff;
  const c5 = extractPriceField(item.c5game);
  if (c5 > 0) return c5;
  const csfloat = extractPriceField(item.csfloat);
  if (csfloat > 0) return csfloat;
  return 0;
}

// Monta URL completa do icon a partir do hash da Pricempire (ou usa URL se já for completa)
function buildIconUrl(iconField) {
  if (!iconField) return '';
  if (iconField.startsWith('http')) return iconField;
  return `https://community.cloudflare.steamstatic.com/economy/image/${iconField}/360fx360f`;
}

// Sugestões pra autocomplete — só armas, facas e luvas (sem sticker/patch/case/music kit).
async function suggestSkins(query, limit = 10) {
  const items = await fetchPricempireItems();
  const q = normalizeName(query);
  if (!q) return [];
  const words = q.split(' ');
  const matches = [];
  for (const key of Object.keys(items)) {
    if (!isWeaponOrKnifeOrGloves(key)) continue;  // filtro anti-sticker
    const k = normalizeName(key);
    if (words.every(w => k.includes(w))) {
      matches.push({ name: key, score: Math.abs(k.length - q.length) });
      if (matches.length > 300) break;
    }
  }
  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, limit).map(m => m.name);
}

// Busca cards do catálogo completo (não só top-sellers).
// Retorna itens com preços já aplicados (originalBRL, saleBRL, iconUrl) prontos pro frontend.
// Usado pela home quando o user digita na busca — permite encontrar qualquer skin do Youpin.
async function searchCatalog(query, limit = 40, minPriceCNY = 1, maxPriceCNY = 200000) {
  const items = await fetchPricempireItems();
  const q = normalizeName(query);
  if (!q) return [];
  const words = q.split(' ');

  const candidates = [];
  for (const [key, item] of Object.entries(items)) {
    if (!isWeaponOrKnifeOrGloves(key)) continue;
    const k = normalizeName(key);
    if (!words.every(w => k.includes(w))) continue;
    const youpin = getYoupinPrice(item);
    if (youpin < minPriceCNY || youpin > maxPriceCNY) continue;
    candidates.push({
      name: key,
      youpin,
      platforms: ['buff', 'youpin', 'c5game', 'csfloat', 'csmoney', 'steam']
        .filter(p => extractPriceField(item[p]) > 0).length,
      item,
      score: Math.abs(k.length - q.length),
    });
  }

  // Relevância: menor diferença de tamanho do nome tem prioridade
  candidates.sort((a, b) => a.score - b.score || b.platforms - a.platforms);
  const top = candidates.slice(0, limit);

  // Aplica pricing config (igual no getTopSellers)
  const { getConversionFactor, getBaseFactor, applyPricing } = require('./pricing');
  const [saleFactor, baseFactor] = await Promise.all([
    getConversionFactor(),
    getBaseFactor(),
  ]);

  return top.map(x => {
    const steamCNY = extractPriceField(x.item.steam);
    const steamEstCNY = steamCNY > 0 ? steamCNY : x.youpin * 1.35;
    return {
      name: x.name,
      price_cny: x.youpin,
      steam_price_cny: steamEstCNY,
      originalBRL: applyPricing(steamEstCNY, baseFactor),
      saleBRL: applyPricing(x.youpin, saleFactor),
      rarity: x.item.rarity || 'Common',
      type: x.item.type || inferTypeFromName(x.name),
      iconUrl: buildIconUrl(x.item.icon),
      platforms: x.platforms,
      source: 'pricempire_search',
    };
  });
}

// Lista de armas do CS2. Usada pra filtrar o top-sellers — queremos mostrar só
// armas, facas e luvas na home (mercado BR não investe em sticker/patch/music kit).
const WEAPON_PREFIXES = [
  // Rifles
  'AK-47', 'M4A4', 'M4A1-S', 'AUG', 'SG 553', 'Galil AR', 'FAMAS',
  // SMGs
  'MP9', 'MAC-10', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon',
  // Heavy
  'Nova', 'XM1014', 'Sawed-Off', 'MAG-7', 'M249', 'Negev',
  // Snipers
  'AWP', 'SSG 08', 'G3SG1', 'SCAR-20',
  // Pistols
  'Glock-18', 'USP-S', 'P2000', 'P250', 'Five-SeveN', 'Tec-9',
  'CZ75-Auto', 'Desert Eagle', 'Dual Berettas', 'R8 Revolver', 'Zeus x27',
];

// Retorna true se o nome é de uma arma, faca ou luva.
// Aceita prefixos ★ (facas/luvas) e StatTrak™ (variantes com contador de kills).
function isWeaponOrKnifeOrGloves(name) {
  if (!name) return false;
  // Facas e luvas sempre começam com ★ (também StatTrak de facas: "★ StatTrak™ Karambit...")
  if (name.startsWith('★')) return true;
  // Remove prefixo "StatTrak™ " pra checar a arma por baixo
  const bare = name.replace(/^StatTrak™\s*/, '').trim();
  for (const prefix of WEAPON_PREFIXES) {
    if (bare.startsWith(prefix + ' |')) return true;
  }
  return false;
}

// Top sellers: ranking por liquidez + preços calculados no backend.
//
// Cada item retorna DOIS preços em BRL:
//   originalBRL = preço_steam_CNY × fator_conversão          (strikethrough)
//   saleBRL     = preço_youpin_CNY × fator_conversão × (1 + margem)  (destaque)
//
// O fator e a margem vêm de settings/pricing (configurado pelo Gu no admin).
async function getTopSellers(limit = 50, minPriceCNY = 3, maxPriceCNY = 20000) {
  const items = await fetchPricempireItems();
  const all = Object.entries(items)
    .filter(([name]) => isWeaponOrKnifeOrGloves(name))
    .map(([name, it]) => {
      // Counts: podem vir como {src}_count OU embutidos em {src: {count}}
      const youpinCount = extractCountField(it.youpin_count) || extractCountField(it.youpin);
      const buffCount   = extractCountField(it.buff_count)   || extractCountField(it.buff);
      // Platforms: conta quantas fontes têm preço válido (usa extractPriceField — aceita número ou objeto)
      const platforms = ['buff', 'youpin', 'c5game', 'csfloat', 'csmoney', 'steam']
        .filter(p => extractPriceField(it[p]) > 0).length;
      return {
        name,
        youpin: getYoupinPrice(it),
        youpinCount,
        buffCount,
        volume: youpinCount + buffCount,
        platforms,
        item: it,
      };
    })
    .filter(x => x.youpin >= minPriceCNY && x.youpin <= maxPriceCNY && x.platforms >= 2);

  // Verifica se temos dados de volume. Se sim, rankeia por volume.
  // Se não (API não retorna count), cai pra platforms + faixas de preço pra diversificar.
  const hasVolumeData = all.some(x => x.volume > 0);
  console.log(`[Pricempire] top-sellers: ${all.length} candidatos, hasVolumeData=${hasVolumeData}`);

  let ranked;
  if (hasVolumeData) {
    ranked = all
      .filter(x => x.volume > 0)
      .sort((a, b) => b.volume - a.volume);
  } else {
    // Fallback: estratificação por faixa de preço + ranking por platforms.
    // Divide em 5 faixas logarítmicas e pega top de cada faixa.
    const buckets = [
      [3, 50], [50, 200], [200, 800], [800, 3000], [3000, maxPriceCNY]
    ];
    ranked = [];
    for (const [lo, hi] of buckets) {
      const inRange = all
        .filter(x => x.youpin >= lo && x.youpin < hi)
        .sort((a, b) => b.platforms - a.platforms || b.youpin - a.youpin)
        .slice(0, Math.ceil(limit / buckets.length));
      ranked.push(...inRange);
    }
    // Intercala faixas (alterna barato/caro) pra visual não ficar monotônico
    ranked.sort(() => Math.random() - 0.5);
  }

  // Aplica pricing config — modelo novo:
  //   fixed → saleFactor = fixedRate (user escolheu o R$/¥ final)
  //   rate  → saleFactor = googleRate + surcharge (cotação + R$ fixos de lucro)
  // Pro strikethrough (preço Steam original) usamos o fator BASE sem o surcharge,
  // pra mostrar o valor "de face" em R$ sem margem embutida.
  const top = ranked.slice(0, limit);
  const { getConversionFactor, getBaseFactor, applyPricing } = require('./pricing');
  const [saleFactor, baseFactor] = await Promise.all([
    getConversionFactor(),
    getBaseFactor(),
  ]);

  return top.map(x => {
    const steamCNY = extractPriceField(x.item.steam);
    // Se não tem Steam price, extrapola a partir do Youpin (Steam costuma ser +~35% sobre Youpin)
    const steamEstCNY = steamCNY > 0 ? steamCNY : x.youpin * 1.35;
    return {
      name: x.name,
      price_cny: x.youpin,
      steam_price_cny: steamEstCNY,
      originalBRL: applyPricing(steamEstCNY, baseFactor),     // strikethrough (Steam puro)
      saleBRL: applyPricing(x.youpin, saleFactor),            // preço final de venda
      onSale: x.youpinCount || x.platforms,
      total: x.volume || x.platforms,
      rarity: x.item.rarity || 'Common',
      type: x.item.type || inferTypeFromName(x.name),
      iconUrl: buildIconUrl(x.item.icon),
      platforms: x.platforms,
      source: 'pricempire',
    };
  });
}

function inferTypeFromName(name) {
  if (name.startsWith('★')) {
    return /Gloves|Hand Wraps/i.test(name) ? 'Luva' : 'Faca';
  }
  return 'Arma';
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

  // GET /api/pricempire/search?q=ak+redline&limit=40
  // Busca no catálogo inteiro, retorna cards prontos com preços aplicados
  if (event.httpMethod === 'GET' && path.endsWith('/search')) {
    const q = (event.queryStringParameters || {}).q || '';
    const limit = Math.min(80, Math.max(1, parseInt((event.queryStringParameters || {}).limit, 10) || 40));
    const items = await searchCatalog(q, limit);
    return json(200, { query: q, count: items.length, items });
  }

  return json(405, { error: 'Method not allowed' });
};

// ── Busca por CATEGORIA (sticker / charm / agent) ─────────────────────────
// Categorias não têm "modelo" como armas — são todos itens únicos identificados
// por padrão de nome. Retorna cards prontos igual searchCatalog.
//
//   sticker: nome começa com "Sticker |" ou "Sealed Graffiti"
//   charm  : nome começa com "Charm |"
//   agent  : nome termina com "| <GrupoConhecido>" (Elite Crew, FBI, SWAT, etc)
const AGENT_GROUP_NAMES_BE = [
  'Elite Crew','The Professionals','Professional','SWAT','NSWC SEAL','FBI','Phoenix',
  'Sabre','Sabre Footsoldier','Sabre Footman','Balkan','Gendarmerie Nationale',
  'Guerrilla Warfare','NZSAS','SAS','SEAL Frogmen','SEAL Frogman','TACP Cavalry',
  'KSK','Spetsnaz','Nautilus','Brazilian 1st Battalion','FBI Sniper','FBI HRT',
  'FBI SWAT','Ground Rebel','Seal Team 6',
];

// Classes de armas — grupos por tipo (não por modelo específico)
const WEAPON_CLASSES_BE = {
  rifle:   ['AK-47','M4A4','M4A1-S','AUG','SG 553','FAMAS','Galil AR','AWP','SSG 08','SCAR-20','G3SG1'],
  pistol:  ['Desert Eagle','USP-S','Glock-18','P2000','P250','Five-SeveN','R8 Revolver','Dual Berettas','Tec-9','CZ75-Auto','Zeus x27'],
  smg:     ['MAC-10','MP9','MP7','MP5-SD','UMP-45','P90','PP-Bizon'],
  shotgun: ['Nova','XM1014','Sawed-Off','MAG-7'],
  mg:      ['M249','Negev'],
};
const GLOVE_NAMES_BE = ['Sport Gloves','Driver Gloves','Specialist Gloves','Moto Gloves','Bloodhound Gloves','Hand Wraps','Hydra Gloves','Broken Fang Gloves'];

function matchesWeaponClass(name, classKey) {
  const prefixes = WEAPON_CLASSES_BE[classKey]; if (!prefixes) return false;
  const bare = name.replace(/^StatTrak™\s*/, '').replace(/^Souvenir\s+/, '');
  for (const p of prefixes) {
    if (bare.startsWith(p + ' |')) return true;
  }
  return false;
}
function matchesGlovesBE(name) {
  if (!name) return false;
  for (const g of GLOVE_NAMES_BE) {
    if (name.includes(g + ' |') || name.startsWith('★ ' + g + ' |')) return true;
  }
  return false;
}
function matchesKnifeBE(name) {
  if (!name || !name.startsWith('★ ')) return false;
  return !matchesGlovesBE(name);
}

function matchesCategory(name, type) {
  if (!name) return false;
  if (type === 'sticker') return /^Sticker\s*\|/.test(name) || /^Sealed\s+Graffiti/.test(name);
  if (type === 'charm')   return /^Charm\s*\|/.test(name);
  if (type === 'agent') {
    // Agents NÃO têm wear. Weapons tem "(Factory New)" etc — exclui de cara.
    if (/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/.test(name)) return false;
    for (const g of AGENT_GROUP_NAMES_BE) {
      if (name.endsWith(' | ' + g)) return true;
    }
    return false;
  }
  // Classes de armas: filtram por prefixo do modelo
  if (type === 'knife')  return matchesKnifeBE(name);
  if (type === 'gloves') return matchesGlovesBE(name);
  if (WEAPON_CLASSES_BE[type]) return matchesWeaponClass(name, type);
  return false;
}

async function getItemsByCategory(type, limit = 80, minPriceCNY = 1, maxPriceCNY = 50000) {
  const items = await fetchPricempireItems();
  const matches = [];
  for (const [name, item] of Object.entries(items)) {
    if (!matchesCategory(name, type)) continue;
    const youpin = getYoupinPrice(item);
    if (youpin < minPriceCNY || youpin > maxPriceCNY) continue;
    // Conta liquidez (quantas plataformas têm preço REAL) — proxy de popularidade.
    const platforms = ['buff', 'youpin', 'c5game', 'csfloat', 'csmoney', 'steam']
      .filter(p => extractPriceField(item[p]) > 0).length;
    // Filtro de qualidade: pelo menos 3 plataformas tem que ter preço (item realmente
    // vendido em múltiplos lugares — descarta dados quebrados/items mortos).
    if (platforms < 3) continue;
    matches.push({ name, youpin, platforms, item });
  }
  // Ordenação: dentro do filtro de liquidez (3+ plataformas + cap 50k), pega os
  // MAIS CAROS primeiro. Isso mostra facas top (Karambit, Butterfly, M9), rifles
  // populares (AK Asiimov, AWP Asiimov), etc — em vez de Navaja/Gut baratas.
  matches.sort((a, b) => b.youpin - a.youpin);
  const top = matches.slice(0, limit);

  // Aplica pricing pra converter CNY → BRL
  const { getConversionFactor, getBaseFactor, applyPricing } = require('./pricing');
  const [saleFactor, baseFactor] = await Promise.all([
    getConversionFactor(),
    getBaseFactor(),
  ]);

  return top.map(x => {
    const steamCNY = extractPriceField(x.item.steam);
    const steamEstCNY = steamCNY > 0 ? steamCNY : x.youpin * 1.35;
    // Icon fallback: Pricempire pode ter o icon em .icon, .image ou .image_url.
    // Pra stickers/charms/agents muitas vezes o campo é vazio — frontend vai
    // resolver via Steam Market /priceoverview usando o nome (fallback existente).
    const iconRaw = x.item.icon || x.item.image || x.item.image_url || '';
    return {
      name: x.name,
      price_cny: x.youpin,
      steam_price_cny: steamEstCNY,
      originalBRL: applyPricing(steamEstCNY, baseFactor),
      saleBRL: applyPricing(x.youpin, saleFactor),
      rarity: x.item.rarity || 'Common',
      type: x.item.type || type,
      iconUrl: buildIconUrl(iconRaw),
      source: 'pricempire_category',
    };
  });
}

// Estende o handler HTTP com a rota /by-category
// (deixa o handler existente intacto — esta rota é checada primeiro)
const _originalHandler = exports.handler;
exports.handler = async (event) => {
  const path = event.path || '';
  // GET /api/pricempire/by-category?type=agent&limit=80
  // Types aceitos: sticker, charm, agent, rifle, pistol, smg, shotgun, mg, knife, gloves
  if (event.httpMethod === 'GET' && path.endsWith('/by-category')) {
    const q = event.queryStringParameters || {};
    const type = String(q.type || '').toLowerCase();
    const ALLOWED = ['sticker','charm','agent','rifle','pistol','smg','shotgun','mg','knife','gloves'];
    if (!ALLOWED.includes(type)) {
      return json(400, { error: 'type must be one of: ' + ALLOWED.join(', ') });
    }
    const limit = Math.min(120, Math.max(1, parseInt(q.limit, 10) || 80));
    const items = await getItemsByCategory(type, limit);
    return json(200, { type, count: items.length, items });
  }
  return _originalHandler(event);
};

exports.fetchPricempireItems = fetchPricempireItems;
exports.getPricempireItem = getPricempireItem;
exports.getYoupinPrice = getYoupinPrice;
exports.buildIconUrl = buildIconUrl;
exports.suggestSkins = suggestSkins;
exports.getTopSellers = getTopSellers;
exports.getItemsByCategory = getItemsByCategory;
exports.searchCatalog = searchCatalog;
