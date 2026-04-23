// ═══ Gumax — Steam Community Market priceoverview Wrapper ═══
// Endpoint não oficial (mas estável) usado pra puxar lowest_price / median_price / volume
// de uma skin na Steam Market. Rate-limit da Steam é cruel (~20 req/min por IP),
// então cacheamos por 24h no Firestore.
//
// Rotas:
//   POST /api/steam-market/price { market_hash_name }
//     → { lowest_price_brl, median_price_brl, volume, cachedAt }
//
// Também usado como helper por analysis.js (importa getSteamPrice).

const admin = require('firebase-admin');
const https = require('https');
const querystring = require('querystring');

const STEAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const STEAM_APP_ID = 730; // CS2
const STEAM_COUNTRY = 'BR';
const STEAM_CURRENCY = 7; // BRL (priceoverview currency codes)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// "R$ 42,90" → 42.90
function parseBRL(str) {
  if (!str) return null;
  const cleaned = String(str)
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')    // separador de milhar
    .replace(',', '.');    // vírgula decimal
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseVolume(str) {
  if (!str) return 0;
  // Ex: "1,234" → 1234
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Gumax-Backend/1.0', Accept: 'application/json' },
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error('steam_rate_limit'), { status: 429 }));
        if (res.statusCode >= 400) return reject(Object.assign(new Error('steam_http_' + res.statusCode), { status: res.statusCode }));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('steam_bad_json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('steam_timeout')); });
  });
}

// ── Cache Firestore ────────────────────────────────────────────────────────
async function getCached(name) {
  try {
    const db = admin.firestore();
    const doc = await db.collection('steam_market_cache').doc(encodeURIComponent(name)).get();
    if (!doc.exists) return null;
    const d = doc.data();
    if (Date.now() - new Date(d.cachedAt).getTime() > STEAM_CACHE_TTL_MS) return null;
    return d;
  } catch { return null; }
}

async function setCached(name, payload) {
  try {
    const db = admin.firestore();
    await db.collection('steam_market_cache').doc(encodeURIComponent(name)).set({
      ...payload,
      name,
      cachedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (e) {
    console.log('[SteamMarket] cache write error:', e.message);
  }
}

// ── Fetch core ─────────────────────────────────────────────────────────────
async function fetchFromSteam(marketHashName) {
  const qs = querystring.stringify({
    country: STEAM_COUNTRY,
    currency: STEAM_CURRENCY,
    appid: STEAM_APP_ID,
    market_hash_name: marketHashName,
  });
  const url = `https://steamcommunity.com/market/priceoverview/?${qs}`;
  const data = await httpGetJson(url);
  if (!data || data.success !== true) {
    const err = new Error('steam_not_found');
    err.status = 404;
    throw err;
  }
  return {
    lowest_price_brl: parseBRL(data.lowest_price),
    median_price_brl: parseBRL(data.median_price),
    volume: parseVolume(data.volume),
  };
}

// ── API pública (usada por analysis.js sem passar por HTTP) ───────────────
async function getSteamPrice(marketHashName) {
  if (!marketHashName) return null;
  const cached = await getCached(marketHashName);
  if (cached) return { ...cached, fromCache: true };

  try {
    const fresh = await fetchFromSteam(marketHashName);
    await setCached(marketHashName, fresh);
    return { ...fresh, fromCache: false };
  } catch (e) {
    // Se bater rate limit, devolve cache velho (mesmo expirado) como fallback
    if (e.status === 429) {
      try {
        const db = admin.firestore();
        const stale = await db.collection('steam_market_cache').doc(encodeURIComponent(marketHashName)).get();
        if (stale.exists) return { ...stale.data(), fromCache: true, stale: true };
      } catch {}
    }
    console.log(`[SteamMarket] fetch failed for ${marketHashName}:`, e.message);
    return null;
  }
}

// ── Handler HTTP ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const name = body.market_hash_name || body.name;
  if (!name) return json(400, { error: 'market_hash_name is required' });

  const result = await getSteamPrice(name);
  if (!result) return json(503, { error: 'steam_unavailable', name });
  return json(200, result);
};

exports.getSteamPrice = getSteamPrice;
