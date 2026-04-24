// ═══ Gumax — Float & Pattern Inspector ═══
// Dado um inspect link da Steam (steam://rungame/730/.../+csgo_econ_action_preview...),
// retorna o float exato (0.xxxxxx) + paintseed (pattern).
//
// Usa a API pública do CSFloat (api.csfloat.com) — gratuita, rate-limited ~120 req/min.
// Cache em memória 24h por assetId (items Steam são imutáveis — mesmo asset sempre tem
// mesmo float/pattern até ser consumido).
//
// Endpoints:
//   GET /api/inspect-float?link=<inspect_link>  → { float, paintseed, defindex, ... }
//   POST /api/inspect-float/batch  body: { items: [{ assetid, inspectLink }, ...] }
//        → [{ assetid, float, paintseed, error? }, ...]

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// Cache de floats por assetid. Steam asset é imutável — mesmo asset sempre mesmo float.
// Armazena por 24h; refresh automático depois.
const floatCache = new Map();
const FLOAT_CACHE_TTL = 24 * 60 * 60 * 1000;

// Rate limit interno pra não abusar da API free do CSFloat (max 120/min)
const requestTimes = [];
const MAX_PER_MINUTE = 100;

function canMakeRequest() {
  const now = Date.now();
  // Remove timestamps > 60s
  while (requestTimes.length && requestTimes[0] < now - 60000) {
    requestTimes.shift();
  }
  return requestTimes.length < MAX_PER_MINUTE;
}

function recordRequest() {
  requestTimes.push(Date.now());
}

function httpGetJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0',
        'Accept': 'application/json',
      },
      timeout: opts.timeout || 10000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error('rate_limit'), { status: 429 }));
        if (res.statusCode >= 400) return reject(Object.assign(new Error('http_' + res.statusCode), { status: res.statusCode, body: body.substring(0, 300) }));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('bad_json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Extrai assetid do inspect link (pra usar como cache key)
function extractAssetId(inspectLink) {
  const m = /A(\d+)D\d+/.exec(inspectLink || '');
  return m ? m[1] : null;
}

// Busca float + paintseed do CSFloat. Retorna { float, paintseed, defindex, paintindex }.
async function fetchFloatFromCsfloat(inspectLink) {
  if (!inspectLink) return null;
  const assetId = extractAssetId(inspectLink);

  // Cache hit?
  if (assetId) {
    const cached = floatCache.get(assetId);
    if (cached && Date.now() - cached.ts < FLOAT_CACHE_TTL) {
      return cached.data;
    }
  }

  if (!canMakeRequest()) {
    return { error: 'rate_limit_local', message: 'Muitas requisições — tente mais tarde' };
  }
  recordRequest();

  try {
    const apiUrl = 'https://api.csfloat.com/?url=' + encodeURIComponent(inspectLink);
    const data = await httpGetJson(apiUrl, { timeout: 12000 });
    const info = data?.iteminfo;
    if (!info) return { error: 'no_data' };

    const result = {
      floatvalue: parseFloat(info.floatvalue) || null,
      paintseed: parseInt(info.paintseed, 10) || null,
      paintindex: info.paintindex || null,
      defindex: info.defindex || null,
      quality: info.quality || null,
      origin: info.origin || null,
      rarity: info.rarity || null,
      market_hash_name: info.full_item_name || null,
      fetchedAt: Date.now(),
    };

    if (assetId) floatCache.set(assetId, { data: result, ts: Date.now() });
    return result;
  } catch (e) {
    return { error: e.message, status: e.status };
  }
}

// Batch: processa múltiplos inspect links em paralelo (com throttle)
async function fetchFloatBatch(items, concurrency = 3) {
  if (!Array.isArray(items)) return [];
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const it = items[i];
      const r = await fetchFloatFromCsfloat(it.inspectLink).catch(e => ({ error: e.message }));
      results[i] = { assetid: it.assetid, ...r };
      // Throttle: 200ms entre requests do mesmo worker
      await new Promise(r => setTimeout(r, 200));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// Atualiza os stock docs do Firestore com float + pattern.
// Chamado após sync, em background (fire-and-forget). Só processa items sem float.
async function enrichStockWithFloats() {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const snap = await db.collection('stock')
      .where('source', '==', 'steam_inventory')
      .where('active', '==', true)
      .get();

    const pendingItems = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.inspectLink && d.floatvalue == null) {
        pendingItems.push({ docId: doc.id, assetid: d.assetid, inspectLink: d.inspectLink });
      }
    });

    if (!pendingItems.length) {
      console.log('[FloatEnrich] nada pendente');
      return { processed: 0 };
    }

    console.log(`[FloatEnrich] processando ${pendingItems.length} items`);
    const results = await fetchFloatBatch(pendingItems, 3);

    let updated = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const p = pendingItems[i];
      if (r && r.floatvalue != null) {
        await db.collection('stock').doc(p.docId).update({
          floatvalue: r.floatvalue,
          paintseed: r.paintseed,
          floatFetchedAt: new Date().toISOString(),
        });
        updated++;
      }
    }
    console.log(`[FloatEnrich] atualizou ${updated}/${pendingItems.length}`);
    return { processed: pendingItems.length, updated };
  } catch (e) {
    console.error('[FloatEnrich] erro:', e.message);
    return { error: e.message };
  }
}

// ── Handler HTTP ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  // GET /api/inspect-float?link=...
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const link = q.link || '';
    if (!link.startsWith('steam://')) {
      return json(400, { error: 'link inválido (precisa começar com steam://)' });
    }
    const r = await fetchFloatFromCsfloat(link);
    return json(r?.error ? 500 : 200, r || { error: 'no_data' });
  }

  // POST /api/inspect-float/batch  body: { items: [...] }
  if (event.httpMethod === 'POST' && path.endsWith('/batch')) {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    if (!items.length) return json(400, { error: 'items vazio' });
    const results = await fetchFloatBatch(items);
    return json(200, { count: results.length, results });
  }

  return json(405, { error: 'Method not allowed' });
};

exports.fetchFloatFromCsfloat = fetchFloatFromCsfloat;
exports.enrichStockWithFloats = enrichStockWithFloats;
