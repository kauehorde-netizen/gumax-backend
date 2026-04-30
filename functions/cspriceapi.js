// ═══ Gumax — CSPriceAPI Wrapper ═══
// Substituto do pricempire.js — fonte canônica de preços do ecossistema Gumax.
// Pago via cspriceapi.com (~$50/mês plano Trader Basic), expõe Youpin como
// referência principal (FIPE table do mercado de skins) + Buff163, C5Game, etc
// pra comparativos.
//
// Estratégia:
//   1) 1 chamada bulk em /v1/prices/youpin → pega TODAS as skins do Youpin
//      (~25k items) com price_rmb, change_24h, count, liquidity
//   2) 1 chamada bulk em /v1/prices/buff163 → mesmo formato pra Buff
//   3) Mescla em memória num único byName{} (mesmo shape do pricempire.js antigo)
//   4) Cache no Firestore (TTL 25h, refresh diário via cron)
//
// Mantém EXATAMENTE a mesma API surface do pricempire.js pros wrappers
// (catalog.js, youpin-proxy.js, skin-detail.js, analysis.js, price-history.js)
// continuarem funcionando sem mudança — só trocar `require('./pricempire')`
// por `require('./cspriceapi')`.
//
// Endpoints expostos no server.js:
//   GET  /api/pricempire/items       → contagem do catálogo
//   POST /api/pricempire/item        → busca por nome (fuzzy)
//   GET  /api/pricempire/suggest     → autocomplete
//   GET  /api/pricempire/search      → busca catálogo
//   GET  /api/pricempire/by-category → por categoria (rifle/pistol/knife/etc)
//
// Doc upstream: https://api.cspriceapi.com/openapi.json

const https = require('https');

const CSPRICE_BASE = 'https://api.cspriceapi.com';
const CACHE_TTL = 15 * 60 * 1000; // 15 min memory

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// ── HTTP helper com auth header x-api-key ─────────────────────────────────
function httpsGet(url, apiKey, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 15000;
    const req = https.get(url, {
      timeout,
      headers: {
        'x-api-key': apiKey,
        'User-Agent': 'Gumax-Backend/1.0',
        'Accept': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// CSPriceAPI retorna prices como STRING decimal ("7333.0000") pra preservar
// precisão. Sempre passa por isso antes de comparar/multiplicar.
function parsePrice(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return val > 0 ? val : 0;
  const n = parseFloat(val);
  return n > 0 ? n : 0;
}

// ── Cache Firestore ───────────────────────────────────────────────────────
// Reaproveita a coleção `cached_prices` que o pricempire.js já usava — assim
// se um dia precisar fazer rollback, não precisa apagar nada. Doc separado.
const FIRESTORE_CACHE_DOC = { col: 'cached_prices', id: 'cspriceapi_catalog' };
const CACHE_SCHEMA_VERSION = 1;

async function loadFromFirestoreCache() {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const mainDoc = await db.collection(FIRESTORE_CACHE_DOC.col).doc(FIRESTORE_CACHE_DOC.id).get();
    if (!mainDoc.exists) return null;
    const meta = mainDoc.data();
    if (!meta || !meta.ts || !meta.chunks) return null;
    if (meta.schemaVersion !== CACHE_SCHEMA_VERSION) {
      console.log(`[CSPriceAPI] Firestore cache schema mismatch (v${meta.schemaVersion} != v${CACHE_SCHEMA_VERSION}) — ignorando`);
      return null;
    }
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
      console.log(`[CSPriceAPI] Loaded ${Object.keys(byName).length} items from Firestore cache (age: ${Math.round((Date.now() - meta.ts)/60000)}min)`);
      return { data: byName, ts: meta.ts };
    }
    return null;
  } catch (e) {
    console.log('[CSPriceAPI] Firestore cache read error:', e.message);
    return null;
  }
}

async function saveToFirestoreCache(byName) {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const names = Object.keys(byName);
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
      schemaVersion: CACHE_SCHEMA_VERSION,
      chunks: chunkCount,
      count: names.length,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    console.log(`[CSPriceAPI] Saved ${names.length} items to Firestore cache (${chunkCount} chunks)`);
  } catch (e) {
    console.log('[CSPriceAPI] Firestore cache write error:', e.message);
  }
}

// ── Lê a API key aceitando AMBOS os nomes históricos ──────────────────────
// Quando migramos Pricempire → CSPriceAPI, a env var no Railway permaneceu
// com o nome legado (PRICEMPIRE_API_KEY). Aceita os dois pra evitar que a
// integração quebre por causa do nome — a chave em si vale pra cspriceapi.com.
function getCspriceKey() {
  return process.env.CSPRICEAPI_KEY || process.env.PRICEMPIRE_API_KEY || '';
}

// ── Fetch ─────────────────────────────────────────────────────────────────
// Busca catálogo de Youpin + Buff163 + C5Game em paralelo e mescla em
// {market_hash_name → {youpin, buff, c5game, count, liquidity, ...}}.
// Esse é o EQUIVALENTE ao fetchPricempireItems do pricempire.js.
async function fetchSourcePrices(source, apiKey) {
  const url = `${CSPRICE_BASE}/v1/prices/${source}`;
  const res = await httpsGet(url, apiKey, { timeout: 20000 });
  if (res.status === 401) throw new Error(`CSPriceAPI auth falhou (${source}): chave inválida`);
  if (res.status === 403) throw new Error(`CSPriceAPI ${source}: chave não tem ACL pra esse endpoint`);
  if (res.status === 429) throw new Error(`CSPriceAPI rate limit estourou em ${source}`);
  if (res.status !== 200) throw new Error(`CSPriceAPI ${source} HTTP ${res.status}`);
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { throw new Error(`CSPriceAPI ${source}: JSON inválido`); }
  if (!Array.isArray(parsed.data)) throw new Error(`CSPriceAPI ${source}: data não é array`);
  return parsed.data;
}

async function fetchCSPriceItems() {
  // 1) Memory
  if (global._cspriceCache && Date.now() - global._cspriceCache.ts < CACHE_TTL) {
    return global._cspriceCache.data;
  }
  // 2) Firestore
  const fsCache = await loadFromFirestoreCache();
  if (fsCache) {
    global._cspriceCache = fsCache;
    return fsCache.data;
  }
  // 3) Fresh
  const apiKey = getCspriceKey();
  if (!apiKey) {
    console.warn('[CSPriceAPI] CSPRICEAPI_KEY não configurada');
    return global._cspriceCache?.data || {};
  }

  try {
    console.log('[CSPriceAPI] Buscando youpin + buff163 + c5game em paralelo...');
    const t0 = Date.now();
    const [youpinData, buffData, c5gameData] = await Promise.all([
      fetchSourcePrices('youpin', apiKey).catch(e => { console.warn('[CSPriceAPI] youpin falhou:', e.message); return []; }),
      fetchSourcePrices('buff163', apiKey).catch(e => { console.warn('[CSPriceAPI] buff163 falhou:', e.message); return []; }),
      fetchSourcePrices('c5game', apiKey).catch(e => { console.warn('[CSPriceAPI] c5game falhou:', e.message); return []; }),
    ]);
    console.log(`[CSPriceAPI] Fetch OK em ${Date.now() - t0}ms — youpin:${youpinData.length} buff:${buffData.length} c5game:${c5gameData.length}`);

    const byName = Object.create(null);
    // Youpin é o primário — popula price_rmb, count, liquidity
    for (const it of youpinData) {
      if (!it.market_hash_name) continue;
      byName[it.market_hash_name] = {
        market_hash_name: it.market_hash_name,
        youpin: parsePrice(it.price_rmb),
        youpin_count: it.count || 0,
        youpin_liquidity: parsePrice(it.liquidity),
        change_24h: parsePrice(it.change_24h),
        change_7d: parsePrice(it.change_7d),
        change_30d: parsePrice(it.change_30d),
        change_90d: parsePrice(it.change_90d),
        avg_7d: parsePrice(it.avg_7d),
        avg_30d: parsePrice(it.avg_30d),
        stattrak: it.stattrak === 1,
        souvenir: it.souvenir === 1,
        phase: it.phase || '',
      };
    }
    // Buff163: enriquece o que já tá lá + adiciona items que só existem no Buff
    for (const it of buffData) {
      if (!it.market_hash_name) continue;
      if (!byName[it.market_hash_name]) {
        byName[it.market_hash_name] = { market_hash_name: it.market_hash_name };
      }
      byName[it.market_hash_name].buff = parsePrice(it.price);
      byName[it.market_hash_name].buff_count = it.count || 0;
      byName[it.market_hash_name].buff_url = it.item_page_url || '';
    }
    // C5Game: idem
    for (const it of c5gameData) {
      if (!it.market_hash_name) continue;
      if (!byName[it.market_hash_name]) {
        byName[it.market_hash_name] = { market_hash_name: it.market_hash_name };
      }
      byName[it.market_hash_name].c5game = parsePrice(it.price);
      byName[it.market_hash_name].c5game_count = it.count || 0;
    }

    if (Object.keys(byName).length > 0) {
      global._cspriceCache = { data: byName, ts: Date.now() };
      console.log(`[CSPriceAPI] Mesclado ${Object.keys(byName).length} items no catálogo`);
      saveToFirestoreCache(byName).catch(() => {});
      return byName;
    }
    console.warn('[CSPriceAPI] Catálogo vazio — todas as 3 fontes falharam');
  } catch (e) {
    console.error('[CSPriceAPI] Erro fatal no fetch:', e.message);
  }

  return global._cspriceCache?.data || {};
}

// ── Helpers de matching ───────────────────────────────────────────────────
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

// Mantida com nome `getPricempireItem` pra wrappers continuarem funcionando.
async function getPricempireItem(name) {
  const items = await fetchCSPriceItems();
  if (!name) return null;

  // Exato
  if (items[name]) return items[name];

  // Normalizado
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

function getYoupinPrice(item) {
  if (!item) return 0;
  const youpin = parsePrice(item.youpin);
  if (youpin > 0) return youpin;
  // Fallbacks na ordem: buff (CNY), c5game (CNY)
  const buff = parsePrice(item.buff);
  if (buff > 0) return buff;
  const c5 = parsePrice(item.c5game);
  if (c5 > 0) return c5;
  return 0;
}

// CSPriceAPI não retorna icon hash — usa o ByMykel/CSGO-API gratuito
// (mesma estratégia do pricempire.js). Função buildIconUrl mantida pra
// compat mas só funciona se vier hash da Steam pronto.
function buildIconUrl(iconField) {
  if (!iconField) return '';
  if (iconField.startsWith('http')) return iconField;
  return `https://community.cloudflare.steamstatic.com/economy/image/${iconField}/360fx360f`;
}

// ── Lista de armas (idêntica ao pricempire.js) ────────────────────────────
const WEAPON_PREFIXES = [
  'AK-47', 'M4A4', 'M4A1-S', 'AUG', 'SG 553', 'Galil AR', 'FAMAS',
  'MP9', 'MAC-10', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon',
  'Nova', 'XM1014', 'Sawed-Off', 'MAG-7', 'M249', 'Negev',
  'AWP', 'SSG 08', 'G3SG1', 'SCAR-20',
  'Glock-18', 'USP-S', 'P2000', 'P250', 'Five-SeveN', 'Tec-9',
  'CZ75-Auto', 'Desert Eagle', 'Dual Berettas', 'R8 Revolver', 'Zeus x27',
];

function isWeaponOrKnifeOrGloves(name) {
  if (!name) return false;
  if (name.startsWith('★')) return true;
  const bare = name.replace(/^StatTrak™\s*/, '').trim();
  for (const prefix of WEAPON_PREFIXES) {
    if (bare.startsWith(prefix + ' |')) return true;
  }
  return false;
}

// Sugestões pra autocomplete
async function suggestSkins(query, limit = 10) {
  const items = await fetchCSPriceItems();
  const q = normalizeName(query);
  if (!q) return [];
  const words = q.split(' ');
  const matches = [];
  for (const key of Object.keys(items)) {
    if (!isWeaponOrKnifeOrGloves(key)) continue;
    const k = normalizeName(key);
    if (words.every(w => k.includes(w))) {
      matches.push({ name: key, score: Math.abs(k.length - q.length) });
      if (matches.length > 300) break;
    }
  }
  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, limit).map(m => m.name);
}

// Search catalog (mesmo retorno do pricempire.js)
async function searchCatalog(query, limit = 200, minPriceCNY = 1, maxPriceCNY = 200000) {
  const items = await fetchCSPriceItems();
  const q = normalizeName(query);
  if (!q) return [];
  const words = q.split(' ');
  const wantsStatTrak = /stattrak/i.test(query);
  const wantsSouvenir = /souvenir/i.test(query);

  const candidates = [];
  for (const [key, item] of Object.entries(items)) {
    if (!isWeaponOrKnifeOrGloves(key)) continue;
    const hasWear = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/.test(key);
    if (!hasWear) continue;
    if (!key.includes(' | ')) continue;
    if (!wantsStatTrak && /StatTrak™/.test(key)) continue;
    if (!wantsSouvenir && /^Souvenir\s+/.test(key)) continue;

    const k = normalizeName(key);
    if (!words.every(w => k.includes(w))) continue;
    const youpin = getYoupinPrice(item);
    if (youpin < minPriceCNY || youpin > maxPriceCNY) continue;
    candidates.push({
      name: key,
      youpin,
      platforms: ['buff', 'youpin', 'c5game'].filter(p => parsePrice(item[p]) > 0).length,
      item,
      score: Math.abs(k.length - q.length),
    });
  }

  candidates.sort((a, b) => a.score - b.score || b.platforms - a.platforms);
  const top = candidates.slice(0, limit);

  const { getConversionFactor, getBaseFactor, applyPricing } = require('./pricing');
  const [saleFactor, baseFactor] = await Promise.all([
    getConversionFactor(),
    getBaseFactor(),
  ]);

  const bymykelMap = await loadBymykelImages();

  const result = top.map(x => {
    const steamEstCNY = x.youpin * 1.35; // CSPriceAPI não retorna Steam — extrapola Youpin × 1.35
    const icon = resolveImageFromBymykel(bymykelMap, x.name);
    return {
      name: x.name,
      price_cny: x.youpin,
      steam_price_cny: steamEstCNY,
      originalBRL: applyPricing(steamEstCNY, baseFactor),
      saleBRL: applyPricing(x.youpin, saleFactor),
      rarity: 'Common', // CSPriceAPI não retorna rarity
      type: inferTypeFromName(x.name),
      iconUrl: icon,
      platforms: x.platforms,
      source: 'cspriceapi_search',
    };
  });
  applyImageFallback(result, bymykelMap, 'search');
  return result;
}

// Top sellers — ordena por liquidity (do Youpin) que é o melhor proxy de
// popularidade real. Fallback pra count se liquidity vier null.
async function getTopSellers(limit = 50, minPriceCNY = 3, maxPriceCNY = 20000) {
  const items = await fetchCSPriceItems();
  const all = Object.entries(items)
    .filter(([name]) => isWeaponOrKnifeOrGloves(name))
    .map(([name, it]) => ({
      name,
      youpin: getYoupinPrice(it),
      youpinCount: it.youpin_count || 0,
      buffCount: it.buff_count || 0,
      liquidity: parsePrice(it.youpin_liquidity),
      platforms: ['buff', 'youpin', 'c5game'].filter(p => parsePrice(it[p]) > 0).length,
      item: it,
    }))
    .filter(x => x.youpin >= minPriceCNY && x.youpin <= maxPriceCNY && x.platforms >= 1);

  // Rank por liquidity (vem do Youpin, é proxy de popularidade real). Quando
  // liquidity == 0 (skin não no catálogo interno do CSPriceAPI), cai pra count.
  const hasLiquidity = all.some(x => x.liquidity > 0);
  console.log(`[CSPriceAPI] top-sellers: ${all.length} candidatos, hasLiquidity=${hasLiquidity}`);

  let ranked;
  if (hasLiquidity) {
    ranked = all.filter(x => x.liquidity > 0).sort((a, b) => b.liquidity - a.liquidity);
  } else if (all.some(x => x.youpinCount > 0)) {
    ranked = all.filter(x => x.youpinCount > 0).sort((a, b) => b.youpinCount - a.youpinCount);
  } else {
    // Fallback final: estratificação por faixa de preço (igual pricempire)
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
  }

  const top = ranked.slice(0, limit);
  const { getConversionFactor, getBaseFactor, applyPricing } = require('./pricing');
  const [saleFactor, baseFactor] = await Promise.all([
    getConversionFactor(),
    getBaseFactor(),
  ]);

  const bymykelMap = await loadBymykelImages();

  const result = top.map(x => {
    const steamEstCNY = x.youpin * 1.35;
    const icon = resolveImageFromBymykel(bymykelMap, x.name);
    return {
      name: x.name,
      price_cny: x.youpin,
      steam_price_cny: steamEstCNY,
      originalBRL: applyPricing(steamEstCNY, baseFactor),
      saleBRL: applyPricing(x.youpin, saleFactor),
      onSale: x.youpinCount || x.platforms,
      total: x.youpinCount + x.buffCount || x.platforms,
      rarity: 'Common',
      type: inferTypeFromName(x.name),
      iconUrl: icon,
      platforms: x.platforms,
      source: 'cspriceapi',
    };
  });

  applyImageFallback(result, bymykelMap, 'top-sellers');
  return result;
}

// ── Skin base = nome sem StatTrak™/Souvenir/wear, MANTÉM ★ pra facas/luvas ─
// Usado pra agrupar variantes da mesma skin (que compartilham imagem).
function baseSkinKey(name) {
  if (!name) return '';
  return name
    .replace(/^Souvenir\s+/, '')
    .replace(/^★\s*StatTrak™\s*/, '★ ')
    .replace(/^StatTrak™\s*/, '')
    .replace(/\s*\([^)]+\)\s*$/, '')
    .trim();
}

// ── Aplica fallback de imagem in-place num array de items ─────────────────
// 1ª passada: pra cada item sem iconUrl, busca outro item do mesmo array com
// a mesma skin base (skins StatTrak/Souvenir compartilham imagem da Normal).
// 2ª passada: tenta direto no ByMykel a chave base e a chave-sem-★ (cobre
// caso em que a Normal não veio no response mas existe no ByMykel).
function applyImageFallback(items, bymykelMap, label = 'items') {
  if (!Array.isArray(items) || !items.length) return;
  const baseImageMap = {};
  for (const it of items) {
    if (!it.iconUrl) continue;
    const k = baseSkinKey(it.name);
    if (k && !baseImageMap[k]) baseImageMap[k] = it.iconUrl;
  }
  let resolvedFromMap = 0, resolvedFromBymykelBase = 0;
  for (const it of items) {
    if (it.iconUrl) continue;
    const k = baseSkinKey(it.name);
    if (k && baseImageMap[k]) {
      it.iconUrl = baseImageMap[k];
      resolvedFromMap++;
      continue;
    }
    if (k && bymykelMap) {
      const noStar = k.replace(/^★\s*/, '').trim();
      if (bymykelMap[k]) { it.iconUrl = bymykelMap[k]; resolvedFromBymykelBase++; continue; }
      if (bymykelMap[noStar]) { it.iconUrl = bymykelMap[noStar]; resolvedFromBymykelBase++; continue; }
    }
  }
  if (resolvedFromMap || resolvedFromBymykelBase) {
    console.log(`[image fallback ${label}] +${resolvedFromMap} from response, +${resolvedFromBymykelBase} from ByMykel base`);
  }
}

function inferTypeFromName(name) {
  if (name.startsWith('★')) {
    return /Gloves|Hand Wraps/i.test(name) ? 'Luva' : 'Faca';
  }
  return 'Arma';
}

// ── ByMykel image DB (mesma estratégia do pricempire.js) ──────────────────
let _bymykelCache = null;
let _bymykelCacheTs = 0;
const BYMYKEL_CACHE_TTL = 24 * 60 * 60 * 1000;

async function loadBymykelImages() {
  if (_bymykelCache && Date.now() - _bymykelCacheTs < BYMYKEL_CACHE_TTL) {
    return _bymykelCache;
  }
  const sources = [
    'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json',
    'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json',
    'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json',
    'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/keychains.json',
  ];
  const map = Object.create(null);
  await Promise.all(sources.map(async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      for (const item of data) {
        if (item.name && item.image) map[item.name] = item.image;
      }
    } catch (e) { console.log('[ByMykel] erro:', e.message); }
  }));
  _bymykelCache = map;
  _bymykelCacheTs = Date.now();
  console.log(`[ByMykel] ${Object.keys(map).length} items carregados`);
  return map;
}

function resolveImageFromBymykel(map, fullName) {
  if (!fullName || !map) return '';
  const variants = new Set([fullName]);
  const noWear = fullName.replace(/\s*\([^)]+\)\s*$/, '').trim();
  variants.add(noWear);
  variants.add(fullName.replace(/^★\s*/, '').trim());
  variants.add(noWear.replace(/^★\s*/, '').trim());
  variants.add(fullName.replace(/^StatTrak™\s*/, '').trim());
  variants.add(fullName.replace(/^★\s*StatTrak™\s*/, '').trim());
  variants.add(fullName.replace(/^Souvenir\s+/, '').trim());

  // CRÍTICO: pra facas/luvas StatTrak™/Souvenir, ByMykel cataloga COM ★ (sem
  // o StatTrak/Souvenir). Ex: "★ StatTrak™ Karambit | Fade (FN)" precisa virar
  // "★ Karambit | Fade" / "★ Karambit | Fade (FN)" pra bater no map.
  // Sem essas variantes, todo card de faca StatTrak vinha sem imagem (placeholder).
  const knifeStripStat = fullName.replace(/^★\s*StatTrak™\s*/, '★ ').trim();
  variants.add(knifeStripStat);
  variants.add(knifeStripStat.replace(/\s*\([^)]+\)\s*$/, '').trim());
  const knifeStripSouv = fullName.replace(/^★\s*Souvenir\s+/, '★ ').trim();
  variants.add(knifeStripSouv);
  variants.add(knifeStripSouv.replace(/\s*\([^)]+\)\s*$/, '').trim());

  const fullyStripped = fullName
    .replace(/^Souvenir\s+/, '')
    .replace(/^★\s*/, '')
    .replace(/^StatTrak™\s*/, '')
    .replace(/^★\s*/, '')
    .trim();
  variants.add(fullyStripped);
  variants.add(fullyStripped.replace(/\s*\([^)]+\)\s*$/, '').trim());

  for (const v of variants) {
    if (map[v]) return map[v];
  }
  return '';
}

// ── By-category (idêntico ao pricempire.js) ───────────────────────────────
const AGENT_GROUP_NAMES_BE = [
  'Elite Crew','The Professionals','Professional','SWAT','NSWC SEAL','FBI','Phoenix',
  'Sabre','Sabre Footsoldier','Sabre Footman','Balkan','Gendarmerie Nationale',
  'Guerrilla Warfare','NZSAS','SAS','SEAL Frogmen','SEAL Frogman','TACP Cavalry',
  'KSK','Spetsnaz','Nautilus','Brazilian 1st Battalion','FBI Sniper','FBI HRT',
  'FBI SWAT','Ground Rebel','Seal Team 6',
];
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
    if (/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/.test(name)) return false;
    for (const g of AGENT_GROUP_NAMES_BE) {
      if (name.endsWith(' | ' + g)) return true;
    }
    return false;
  }
  const hasWear = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/.test(name);
  if (!hasWear) return false;
  if (!name.includes(' | ')) return false;
  // ANTES: filtrava out StatTrak™ e Souvenir agressivamente — isso fazia
  // categorias (especialmente Faca/Luva) parecerem vazias porque a maioria
  // dos top-sellers caros é StatTrak. AGORA: inclui as variantes; o frontend
  // tem dropdown Variante (Normal/StatTrak/Souvenir) pra filtrar se quiser.
  if (type === 'knife')  return matchesKnifeBE(name);
  if (type === 'gloves') return matchesGlovesBE(name);
  if (WEAPON_CLASSES_BE[type]) return matchesWeaponClass(name, type);
  return false;
}

async function getItemsByCategory(type, limit = 80, minPriceCNY = 1, maxPriceCNY = 19000) {
  const items = await fetchCSPriceItems();
  const matches = [];
  for (const [name, item] of Object.entries(items)) {
    if (!matchesCategory(name, type)) continue;
    const youpin = getYoupinPrice(item);
    if (youpin < minPriceCNY || youpin > maxPriceCNY) continue;
    const platforms = ['buff', 'youpin', 'c5game'].filter(p => parsePrice(item[p]) > 0).length;
    if (platforms < 2) continue;
    matches.push({ name, youpin, platforms, item });
  }
  matches.sort((a, b) => b.youpin - a.youpin);
  const top = matches.slice(0, limit);

  const { getConversionFactor, getBaseFactor, applyPricing } = require('./pricing');
  const [saleFactor, baseFactor] = await Promise.all([
    getConversionFactor(),
    getBaseFactor(),
  ]);

  const bymykelMap = await loadBymykelImages();

  // ANTES: items sem icon eram filtrados out (`if (!icon) continue;`) — isso
  // descartava silenciosamente todas as facas StatTrak™ que o ByMykel não
  // cataloga, fazendo a categoria parecer vazia. AGORA: inclui sempre e
  // applyImageFallback resolve depois (1ª via response, 2ª via ByMykel base).
  const enriched = top.map(x => {
    const icon = resolveImageFromBymykel(bymykelMap, x.name);
    const steamEstCNY = x.youpin * 1.35;
    return {
      name: x.name,
      price_cny: x.youpin,
      steam_price_cny: steamEstCNY,
      originalBRL: applyPricing(steamEstCNY, baseFactor),
      saleBRL: applyPricing(x.youpin, saleFactor),
      rarity: 'Common',
      type: type,
      iconUrl: icon,
      source: 'cspriceapi_category',
    };
  });
  applyImageFallback(enriched, bymykelMap, `category-${type}`);
  return enriched;
}

// ── Float Ranged Data (CSPriceAPI Trader Pro+ feature) ──────────────────
// Pricing por faixa de float específica — núcleo da análise "essa skin tem
// overpay pelo float?". Endpoint upstream: GET /v2/prices/float-ranged
//
// Retorna lista de {market_hash_name, float_range, phase, count, price_rmb, updated_at}.
// O Gumax usa pra: dado uma skin + seu float real (do float-inspector), buscar
// o preço médio pra essa faixa de float e comparar com o pedido pelo vendedor.
//
// Cache 6h em memória + Firestore — não muda muito mais rápido que isso.

const FLOAT_RANGED_CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

async function fetchFloatRangedData() {
  // 1) Memory cache
  if (global._floatRangedCache && Date.now() - global._floatRangedCache.ts < FLOAT_RANGED_CACHE_TTL) {
    return global._floatRangedCache.data;
  }

  const apiKey = getCspriceKey();
  if (!apiKey) {
    console.warn('[CSPriceAPI] CSPRICEAPI_KEY não configurada (float-ranged)');
    return global._floatRangedCache?.data || [];
  }

  try {
    const url = `${CSPRICE_BASE}/v2/prices/float-ranged`;
    const res = await httpsGet(url, apiKey, { timeout: 20000 });
    if (res.status === 401 || res.status === 403) {
      console.warn(`[CSPriceAPI] float-ranged sem ACL (status ${res.status}) — plano não inclui esse endpoint`);
      return [];
    }
    if (res.status !== 200) {
      console.warn(`[CSPriceAPI] float-ranged HTTP ${res.status}`);
      return global._floatRangedCache?.data || [];
    }
    const parsed = JSON.parse(res.body);
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    global._floatRangedCache = { data, ts: Date.now() };
    console.log(`[CSPriceAPI] float-ranged: ${data.length} rows`);
    return data;
  } catch (e) {
    console.error('[CSPriceAPI] float-ranged erro:', e.message);
    return global._floatRangedCache?.data || [];
  }
}

// Dado nome da skin + float real (ou faixa "0.00-0.07"), retorna o preço esperado
// pra essa faixa. Se passar float real (number), tenta achar a faixa que contém ele.
async function getFloatRangedPrice(name, floatOrRange) {
  if (!name) return null;
  const data = await fetchFloatRangedData();
  if (!data.length) return null;

  // Filtra por nome (sem stattrak/souvenir prefix mismatch)
  const matches = data.filter(d => d.market_hash_name === name);
  if (!matches.length) return null;

  // Se passou string "0.00-0.07", busca exato
  if (typeof floatOrRange === 'string' && /^\d/.test(floatOrRange)) {
    const exact = matches.find(d => d.float_range === floatOrRange);
    if (exact) return { ...exact, price_rmb: parsePrice(exact.price_rmb) };
  }

  // Se passou número (float real), acha a faixa que contém
  if (typeof floatOrRange === 'number') {
    for (const m of matches) {
      const [lo, hi] = String(m.float_range || '').split('-').map(parseFloat);
      if (!isNaN(lo) && !isNaN(hi) && floatOrRange >= lo && floatOrRange <= hi) {
        return { ...m, price_rmb: parsePrice(m.price_rmb) };
      }
    }
  }

  // Fallback: retorna a faixa mais barata (geralmente a de menor float = mais valiosa)
  matches.sort((a, b) => parsePrice(a.price_rmb) - parsePrice(b.price_rmb));
  return { ...matches[0], price_rmb: parsePrice(matches[0].price_rmb), matchedAs: 'fallback_cheapest' };
}

// Lista todas as faixas disponíveis pra uma skin — útil pra mostrar no modal
// "preço por float" tipo: 0.00-0.07 = ¥1230, 0.07-0.15 = ¥850, 0.15-0.38 = ¥420
async function getAllFloatRangesForSkin(name) {
  if (!name) return [];
  const data = await fetchFloatRangedData();
  return data
    .filter(d => d.market_hash_name === name)
    .map(d => ({
      float_range: d.float_range,
      phase: d.phase,
      count: d.count || 0,
      price_rmb: parsePrice(d.price_rmb),
      updated_at: d.updated_at,
    }))
    .sort((a, b) => {
      const aLo = parseFloat(String(a.float_range).split('-')[0]) || 0;
      const bLo = parseFloat(String(b.float_range).split('-')[0]) || 0;
      return aLo - bLo;
    });
}

// ── YouPin Buyorder (CSPriceAPI Trader Pro+ feature) ────────────────────
// Preço REAL de compra (o que outros estão dispostos a pagar AGORA pra adquirir
// a skin). Diferente do listing price (preço pedido). Útil pra buyback do Gumax —
// dá floor de mercado pra calcular oferta justa quando comprar de cliente.
//
// Endpoint upstream: GET /v1/prices/youpin/buyorder

async function fetchYoupinBuyorders() {
  if (global._youpinBuyorderCache && Date.now() - global._youpinBuyorderCache.ts < FLOAT_RANGED_CACHE_TTL) {
    return global._youpinBuyorderCache.data;
  }

  const apiKey = getCspriceKey();
  if (!apiKey) {
    console.warn('[CSPriceAPI] CSPRICEAPI_KEY não configurada (buyorder)');
    return global._youpinBuyorderCache?.data || {};
  }

  try {
    const url = `${CSPRICE_BASE}/v1/prices/youpin/buyorder`;
    const res = await httpsGet(url, apiKey, { timeout: 20000 });
    if (res.status === 401 || res.status === 403) {
      console.warn(`[CSPriceAPI] buyorder sem ACL (status ${res.status}) — plano não inclui`);
      return {};
    }
    if (res.status !== 200) {
      console.warn(`[CSPriceAPI] buyorder HTTP ${res.status}`);
      return global._youpinBuyorderCache?.data || {};
    }
    const parsed = JSON.parse(res.body);
    const arr = Array.isArray(parsed.data) ? parsed.data : [];
    // Indexa por market_hash_name pra lookup O(1)
    const byName = Object.create(null);
    for (const it of arr) {
      if (!it.market_hash_name) continue;
      byName[it.market_hash_name] = {
        market_hash_name: it.market_hash_name,
        buyorder_price: parsePrice(it.buyorder_price),
        blue_buyorder_price: parsePrice(it.blue_buyorder_price),
        phase: it.phase || '',
        count: it.count || 0,
        updated_at: it.updated_at,
      };
    }
    global._youpinBuyorderCache = { data: byName, ts: Date.now() };
    console.log(`[CSPriceAPI] buyorder: ${Object.keys(byName).length} items`);
    return byName;
  } catch (e) {
    console.error('[CSPriceAPI] buyorder erro:', e.message);
    return global._youpinBuyorderCache?.data || {};
  }
}

async function getYoupinBuyorder(name) {
  if (!name) return null;
  const map = await fetchYoupinBuyorders();
  return map[name] || null;
}

// ── Análise de overpay (combina float-ranged + buyorder + youpin price) ──
// Recebe { name, floatValue, askingPrice (CNY) } e devolve veredito + score.
// Usado pelo analise.html — núcleo do feature de "essa skin tá cara?".
async function analyzeOverpay({ name, floatValue, askingPriceCNY }) {
  const [item, floatPrice, buyorder] = await Promise.all([
    getPricempireItem(name),
    floatValue != null ? getFloatRangedPrice(name, floatValue) : null,
    getYoupinBuyorder(name),
  ]);

  const youpinPrice = getYoupinPrice(item);
  const buyorderPrice = buyorder?.buyorder_price || 0;
  // Preço de referência: float-ranged > youpin listing > buyorder. O float-ranged
  // é o mais granular (preço pra ESSE float específico), tem prioridade.
  const referencePrice = floatPrice?.price_rmb || youpinPrice || buyorderPrice;

  if (!referencePrice || !askingPriceCNY) {
    return { error: 'insufficient_data', name, referencePrice, askingPriceCNY };
  }

  // % de overpay (positivo = caro, negativo = barato)
  const overpayPercent = ((askingPriceCNY - referencePrice) / referencePrice) * 100;

  let verdict;
  if (overpayPercent >= 25) verdict = 'OVERPAY_ALTO';
  else if (overpayPercent >= 10) verdict = 'OVERPAY_MODERADO';
  else if (overpayPercent >= -5) verdict = 'PRECO_JUSTO';
  else if (overpayPercent >= -15) verdict = 'BOM_DEAL';
  else verdict = 'EXCELENTE_DEAL';

  return {
    name,
    floatValue,
    askingPriceCNY,
    referencePrice,
    referenceSource: floatPrice ? 'float_ranged' : (youpinPrice ? 'youpin_listing' : 'buyorder'),
    youpinListing: youpinPrice,
    youpinBuyorder: buyorderPrice,
    floatRangePrice: floatPrice?.price_rmb || null,
    floatRange: floatPrice?.float_range || null,
    overpayPercent: Math.round(overpayPercent * 10) / 10,
    verdict,
  };
}

// ── Handler HTTP (rotas mantidas: /api/pricempire/*) ──────────────────────
// ═══ BLUEGEM SALES — histórico de vendas por pattern (CSPriceAPI Pro feature) ═══
//
// Endpoint do CSPriceAPI: GET /v1/bluegem-sales?market_hash_name=X&pattern=Y
// Aceita name COM ou SEM wear:
//   - "AK-47 | Case Hardened" + pattern=661 → todas as wears
//   - "AK-47 | Case Hardened (Minimal Wear)" + pattern=661 → só essa wear
//
// Resposta:
//   { market_hash_name, pattern, count, data: [
//       { id, market_hash_name, item_name, pattern, floatvalue, market,
//         sale_price_cents, price_currency_code, transacted_at_ep,
//         transacted_at, record_type } ...
//     ]
//   }
//
// Útil principalmente pra Case Hardened (bluegems), Marble Fade, Crimson Web,
// Doppler — skins onde o PATTERN dita o preço (variação de até 20x).
//
// Cache: 6h TTL no Firestore (vendas históricas mudam pouco).
const BLUEGEM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const _bluegemMemCache = new Map(); // key = name|pattern

async function getBluegemSales(marketHashName, pattern) {
  if (!marketHashName) return null;
  const key = `${marketHashName}|${pattern || ''}`;
  const now = Date.now();

  // Mem cache primeiro (mesma instância)
  const mem = _bluegemMemCache.get(key);
  if (mem && (now - mem.fetchedAt) < BLUEGEM_CACHE_TTL_MS) return mem.data;

  // Firestore cache (sobrevive restart do servidor)
  try {
    const docId = key.replace(/[/\\#?\[\]]/g, '_').slice(0, 1500);
    const fsRef = require('firebase-admin').firestore().collection('cspriceCache').doc('bluegem').collection('sales').doc(docId);
    const snap = await fsRef.get();
    if (snap.exists) {
      const cached = snap.data();
      if (cached.fetchedAt && (now - cached.fetchedAt) < BLUEGEM_CACHE_TTL_MS) {
        _bluegemMemCache.set(key, { data: cached.data, fetchedAt: cached.fetchedAt });
        return cached.data;
      }
    }
  } catch (e) { /* sem cache disponível, segue */ }

  // Busca da API
  const apiKey = getCspriceKey();
  if (!apiKey) {
    console.warn('[bluegem] CSPRICEAPI_KEY ausente');
    return null;
  }
  const url = `https://api.cspriceapi.com/v1/bluegem-sales?market_hash_name=${encodeURIComponent(marketHashName)}${pattern ? `&pattern=${encodeURIComponent(pattern)}` : ''}`;
  try {
    const raw = await httpsGet(url, apiKey);
    const parsed = JSON.parse(raw);
    // Normaliza: ordena por data desc, calcula price em USD (cents → dollars)
    const sales = (parsed.data || []).map(s => ({
      id: s.id,
      pattern: s.pattern,
      floatvalue: s.floatvalue ? parseFloat(s.floatvalue) : null,
      market: s.market,
      priceUSD: s.sale_price_cents ? s.sale_price_cents / 100 : null,
      currency: s.price_currency_code || 'USD',
      transactedAt: s.transacted_at,
      transactedAtEp: s.transacted_at_ep,
    })).sort((a, b) => (b.transactedAtEp || 0) - (a.transactedAtEp || 0));

    const result = {
      marketHashName: parsed.market_hash_name || marketHashName,
      pattern: parsed.pattern || pattern || null,
      count: parsed.count || sales.length,
      sales,
    };

    // Salva nos caches
    _bluegemMemCache.set(key, { data: result, fetchedAt: now });
    try {
      const docId = key.replace(/[/\\#?\[\]]/g, '_').slice(0, 1500);
      await require('firebase-admin').firestore()
        .collection('cspriceCache').doc('bluegem').collection('sales').doc(docId)
        .set({ data: result, fetchedAt: now }, { merge: true });
    } catch {}
    return result;
  } catch (e) {
    console.error('[bluegem] fetch falhou:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  if (event.httpMethod === 'GET' && path.endsWith('/items')) {
    const items = await fetchCSPriceItems();
    return json(200, { count: Object.keys(items).length, cachedAt: global._cspriceCache?.ts || null });
  }

  if (event.httpMethod === 'POST' && path.endsWith('/item')) {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }
    const it = await getPricempireItem(body.name);
    if (!it) return json(404, { error: 'not_found', name: body.name });
    return json(200, it);
  }

  if (event.httpMethod === 'GET' && path.endsWith('/suggest')) {
    const q = (event.queryStringParameters || {}).q || '';
    const limit = Math.min(30, Math.max(1, parseInt((event.queryStringParameters || {}).limit, 10) || 10));
    const suggestions = await suggestSkins(q, limit);
    return json(200, { query: q, count: suggestions.length, suggestions });
  }

  if (event.httpMethod === 'GET' && path.endsWith('/search')) {
    const q = (event.queryStringParameters || {}).q || '';
    const limit = Math.min(200, Math.max(1, parseInt((event.queryStringParameters || {}).limit, 10) || 200));
    const items = await searchCatalog(q, limit);
    return json(200, { query: q, count: items.length, items });
  }

  // GET /api/pricempire/diag — healthcheck (sem auth) — diz se a API tá viva.
  // Útil pro user descobrir rápido se CSPRICEAPI_KEY tá faltando ou expirou.
  if (event.httpMethod === 'GET' && path.endsWith('/diag')) {
    const hasKey = !!getCspriceKey();
    const keySource = process.env.CSPRICEAPI_KEY ? 'CSPRICEAPI_KEY'
                    : process.env.PRICEMPIRE_API_KEY ? 'PRICEMPIRE_API_KEY (legado)'
                    : null;
    const memCache = global._cspriceCache;
    const memCount = memCache?.data ? Object.keys(memCache.data).length : 0;
    const memAgeSec = memCache?.ts ? Math.round((Date.now() - memCache.ts) / 1000) : null;
    let probe = null;
    if (hasKey) {
      try {
        const r = await httpsGet(CSPRICE_BASE + '/v1/account/usage', getCspriceKey(), { timeout: 7000 });
        probe = { status: r.status, sample: String(r.body || '').slice(0, 220) };
      } catch (e) {
        probe = { status: 'error', error: e.message };
      }
    }
    return json(200, {
      hasKey,
      keySource,
      memCount,
      memAgeSec,
      probe,
      hint: hasKey ? null : 'Configurar CSPRICEAPI_KEY (ou PRICEMPIRE_API_KEY legado) nas env vars do Railway.',
    });
  }

  // GET /api/pricempire/diag-sources — testa cada fonte (youpin, buff163, c5game)
  // INDIVIDUALMENTE pra descobrir qual está falhando. Mostra status HTTP, número
  // de items, primeiros nomes, e erro completo se falhar.
  if (event.httpMethod === 'GET' && path.endsWith('/diag-sources')) {
    const apiKey = getCspriceKey();
    if (!apiKey) return json(400, { error: 'no API key configured' });
    const results = {};
    for (const source of ['youpin', 'buff163', 'c5game']) {
      const url = `${CSPRICE_BASE}/v1/prices/${source}`;
      try {
        const t0 = Date.now();
        const r = await httpsGet(url, apiKey, { timeout: 25000 });
        const elapsed = Date.now() - t0;
        let parsed = null;
        try { parsed = JSON.parse(r.body); } catch {}
        results[source] = {
          httpStatus: r.status,
          elapsedMs: elapsed,
          dataCount: Array.isArray(parsed?.data) ? parsed.data.length : 0,
          plan: parsed?.plan || null,
          requestor: parsed?.requestor || null,
          firstName: parsed?.data?.[0]?.market_hash_name || null,
          error: r.status !== 200 ? String(r.body || '').slice(0, 400) : null,
        };
      } catch (e) {
        results[source] = { error: e.message };
      }
    }
    return json(200, { tested: 'youpin, buff163, c5game', results });
  }

  if (event.httpMethod === 'GET' && path.endsWith('/by-category')) {
    const q = event.queryStringParameters || {};
    const type = String(q.type || '').toLowerCase();
    const ALLOWED = ['sticker','charm','agent','rifle','pistol','smg','shotgun','mg','knife','gloves'];
    if (!ALLOWED.includes(type)) {
      return json(400, { error: 'type must be one of: ' + ALLOWED.join(', ') });
    }
    const limit = Math.min(120, Math.max(1, parseInt(q.limit, 10) || 80));
    let items = await getItemsByCategory(type, limit);
    // FALLBACK: CSPriceAPI vazia (sem key/cataloga) → busca YouPin direto + filtra pela categoria
    if (items.length === 0) {
      console.warn(`[by-category ${type}] CSPriceAPI vazia — caindo pra YouPin direto`);
      try {
        const { fetchYoupinTopSellersDirect } = require('./youpin-proxy');
        const direct = await fetchYoupinTopSellersDirect(300); // pega bastante e filtra
        const matchType = (name) => {
          const bare = name.replace(/^StatTrak™\s*/, '').replace(/^Souvenir\s+/, '').replace(/^★\s*/, '').replace(/^★ StatTrak™\s*/, '');
          if (type === 'knife')   return name.startsWith('★ ') && !matchesGlovesBE(name);
          if (type === 'gloves')  return matchesGlovesBE(name);
          if (type === 'sticker') return /^Sticker\s*\|/i.test(name) || /^Sealed\s+Graffiti/i.test(name);
          if (type === 'charm')   return /^Charm\s*\|/i.test(name);
          if (type === 'agent')   return false; // agents não vêm no top-sellers do youpin
          return matchesWeaponClass(name, type);
        };
        let factor = 0.78, baseFactor = 0.78;
        try {
          const { getConversionFactor, getBaseFactor } = require('./pricing');
          [factor, baseFactor] = await Promise.all([getConversionFactor(), getBaseFactor()]);
        } catch {}
        const bymykelMap = await loadBymykelImages().catch(() => null);
        const filtered = direct.filter(it => it.name && matchType(it.name)).slice(0, limit);
        items = filtered.map(it => {
          let iconUrl = it.iconUrl || '';
          if (iconUrl && !iconUrl.startsWith('http') && !iconUrl.includes('/')) {
            iconUrl = `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}/256fx256f`;
          }
          if (!iconUrl && bymykelMap) {
            iconUrl = resolveImageFromBymykel(bymykelMap, it.name) || '';
          }
          const cny = it.price_cny || 0;
          return {
            name: it.name,
            price_cny: cny,
            steam_price_cny: cny * 1.35,
            originalBRL: cny > 0 ? Math.round(cny * 1.35 * baseFactor * 100) / 100 : 0,
            saleBRL: cny > 0 ? Math.round(cny * factor * 100) / 100 : 0,
            rarity: '',
            type,
            iconUrl,
            source: 'youpin_direct_category',
          };
        });
        if (bymykelMap) applyImageFallback(items, bymykelMap, `category-${type}-fallback`);
        console.log(`[by-category ${type}] fallback YouPin direto: ${items.length} items`);
      } catch (e) {
        console.error(`[by-category ${type}] fallback err:`, e.message);
      }
    }
    return json(200, { type, count: items.length, items });
  }

  // GET /api/pricempire/float-ranged?name=AK-47%20|%20Redline%20(Field-Tested)&float=0.15
  // Retorna preço esperado pra essa faixa de float específica.
  if (event.httpMethod === 'GET' && path.endsWith('/float-ranged')) {
    const q = event.queryStringParameters || {};
    if (!q.name) return json(400, { error: 'missing param: name' });
    const floatVal = q.float ? parseFloat(q.float) : (q.range || null);
    if (q.all === '1') {
      const ranges = await getAllFloatRangesForSkin(q.name);
      return json(200, { name: q.name, count: ranges.length, ranges });
    }
    const result = await getFloatRangedPrice(q.name, floatVal);
    if (!result) return json(404, { error: 'not_found', name: q.name, float: floatVal });
    return json(200, result);
  }

  // GET /api/pricempire/bluegem-sales?name=AK-47%20|%20Case%20Hardened&pattern=661
  // Histórico de vendas reais por pattern (top tier feature pra Case Hardened etc)
  if (event.httpMethod === 'GET' && path.endsWith('/bluegem-sales')) {
    const q = event.queryStringParameters || {};
    if (!q.name) return json(400, { error: 'missing param: name' });
    const pattern = q.pattern ? parseInt(q.pattern, 10) : null;
    const result = await getBluegemSales(q.name, pattern);
    if (!result) return json(404, { error: 'not_found_or_no_sales', name: q.name, pattern });
    return json(200, result);
  }

  // GET /api/pricempire/buyorder?name=AK-47%20|%20Redline%20(Field-Tested)
  // Retorna o preço de buyorder real (o que outros pagam pra comprar AGORA).
  if (event.httpMethod === 'GET' && path.endsWith('/buyorder')) {
    const q = event.queryStringParameters || {};
    if (!q.name) return json(400, { error: 'missing param: name' });
    const result = await getYoupinBuyorder(q.name);
    if (!result) return json(404, { error: 'not_found', name: q.name });
    return json(200, result);
  }

  // POST /api/pricempire/analyze-overpay  body: { name, floatValue, askingPriceCNY }
  // Núcleo da análise: cruza float-ranged + listing + buyorder e devolve veredito.
  if (event.httpMethod === 'POST' && path.endsWith('/analyze-overpay')) {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'invalid JSON' }); }
    if (!body.name || !body.askingPriceCNY) {
      return json(400, { error: 'required: name + askingPriceCNY (number, CNY)' });
    }
    const result = await analyzeOverpay({
      name: body.name,
      floatValue: body.floatValue,
      askingPriceCNY: parseFloat(body.askingPriceCNY),
    });
    return json(200, result);
  }

  return json(405, { error: 'Method not allowed' });
};

// ── Exports (mesmas funções que pricempire.js exportava + novas Pro-tier) ─
exports.fetchPricempireItems = fetchCSPriceItems;  // alias pra compat
exports.fetchCSPriceItems = fetchCSPriceItems;
exports.getPricempireItem = getPricempireItem;
exports.getYoupinPrice = getYoupinPrice;
// Trader Pro features:
exports.getFloatRangedPrice = getFloatRangedPrice;
exports.getAllFloatRangesForSkin = getAllFloatRangesForSkin;
exports.fetchFloatRangedData = fetchFloatRangedData;
exports.getYoupinBuyorder = getYoupinBuyorder;
exports.fetchYoupinBuyorders = fetchYoupinBuyorders;
exports.getBluegemSales = getBluegemSales;
exports.analyzeOverpay = analyzeOverpay;
exports.buildIconUrl = buildIconUrl;
exports.suggestSkins = suggestSkins;
exports.getTopSellers = getTopSellers;
exports.getItemsByCategory = getItemsByCategory;
exports.searchCatalog = searchCatalog;
exports.loadBymykelImages = loadBymykelImages;
exports.resolveImageFromBymykel = resolveImageFromBymykel;
exports.applyImageFallbackPublic = applyImageFallback;
