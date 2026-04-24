// ═══ Gumax — Float & Pattern Inspector ═══
// Busca float exato + paintseed (pattern) de cada skin via SteamWebAPI.com.
// Mesma abordagem usada pelo FlowSkins — serviço pago confiável, sem precisar
// montar bot Steam GC próprio.
//
// Env var necessária:
//   STEAMWEBAPI_KEY — chave da API do steamwebapi.com
//   (a mesma chave usada no Railway do FlowSkins pode ser reaproveitada)
//
// Estratégia de custo/performance:
//   1. BULK por steamId (1 chamada → todos os items com float/pattern). Super eficiente.
//   2. Fallback individual por inspect link (só pro que faltou).
//   3. Cache 7 dias por assetId (items Steam são imutáveis — asset nunca muda float).
//
// Endpoints:
//   GET  /api/inspect-float?link=<inspect_link>           → float de 1 item
//   POST /api/inspect-float/batch  body: { items: [...] } → batch por inspect links
//   POST /api/inspect-float/sync   body: { steamIds: [] } → bulk por steamId + persist em stock/
//     (usado automaticamente depois do sync de inventário)

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// Cache por assetId. Items Steam são imutáveis — mesmo asset sempre mesmo float.
// TTL 7 dias. Na prática nunca expira (sync refresca antes).
const floatCache = new Map();
const FLOAT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// Rate limit local pra SteamWebAPI (evita estouro do plano pago)
const requestTimes = [];
const MAX_PER_MINUTE = 200; // plano do SteamWebAPI aguenta bem mais, mas deixa margem
function canMakeRequest() {
  const now = Date.now();
  while (requestTimes.length && requestTimes[0] < now - 60000) requestTimes.shift();
  return requestTimes.length < MAX_PER_MINUTE;
}
function recordRequest() { requestTimes.push(Date.now()); }

function httpGetJson(url, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Gumax-Skins/1.0',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error('rate_limit'), { status: 429 }));
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error('http_' + res.statusCode),
            { status: res.statusCode, bodySample: body.substring(0, 200) }));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('bad_json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Extrai assetid do inspect link (cache key)
function extractAssetId(inspectLink) {
  const m = /A(\d+)D\d+/.exec(inspectLink || '');
  return m ? m[1] : null;
}

// ── BULK: busca TODOS os items de um steamId com float inline ──────────────
// SteamWebAPI.com endpoint: /steam/api/inventory?key=...&steam_id=...&game=cs2&parse=1
// Retorna array de items. Cada item tem .float = { floatvalue, paintseed, paintindex, phase }.
// e .assetid — podemos cachear por assetId.
async function fetchInventoryFloats(steamId) {
  const key = process.env.STEAMWEBAPI_KEY;
  if (!key) return { error: 'no_api_key' };

  if (!canMakeRequest()) return { error: 'rate_limit_local' };
  recordRequest();

  try {
    const url = `https://www.steamwebapi.com/steam/api/inventory?key=${key}&steam_id=${steamId}&game=cs2&parse=1`;
    const data = await httpGetJson(url, { timeout: 30000 });

    if (!Array.isArray(data)) return { error: 'bad_response', shape: typeof data };

    // Indexa por assetid
    const byAssetId = {};
    let withFloat = 0;
    for (const item of data) {
      const assetid = String(item.assetid || item.id || '');
      if (!assetid) continue;
      const floatObj = item.float || {};
      const fv = floatObj.floatvalue ?? item.floatvalue ?? null;
      const ps = floatObj.paintseed ?? item.paintseed ?? null;
      const pi = floatObj.paintindex ?? item.paintindex ?? null;
      const phase = floatObj.phase ?? item.phase ?? null;

      const result = {
        floatvalue: fv !== null && fv !== undefined ? parseFloat(fv) : null,
        paintseed: ps !== null && ps !== undefined ? parseInt(ps, 10) : null,
        paintindex: pi !== null && pi !== undefined ? parseInt(pi, 10) : null,
        phase: phase || null,
        market_hash_name: item.markethashname || item.market_hash_name || null,
      };
      byAssetId[assetid] = result;
      if (result.floatvalue !== null) withFloat++;

      // Popula cache
      floatCache.set(assetid, { data: result, ts: Date.now() });
    }
    return { total: data.length, withFloat, byAssetId };
  } catch (e) {
    return { error: e.message, status: e.status };
  }
}

// ── FALLBACK: busca float de UM item específico via inspect link ───────────
// SteamWebAPI.com endpoint: /steam/api/item?key=...&inspect_link=...
async function fetchFloatByInspectLink(inspectLink) {
  if (!inspectLink) return { error: 'no_link' };

  const assetId = extractAssetId(inspectLink);
  if (assetId) {
    const cached = floatCache.get(assetId);
    if (cached && Date.now() - cached.ts < FLOAT_CACHE_TTL) return cached.data;
  }

  const key = process.env.STEAMWEBAPI_KEY;
  if (!key) return { error: 'no_api_key' };

  if (!canMakeRequest()) return { error: 'rate_limit_local' };
  recordRequest();

  try {
    const url = `https://www.steamwebapi.com/steam/api/item?key=${key}&inspect_link=${encodeURIComponent(inspectLink)}`;
    const data = await httpGetJson(url, { timeout: 12000 });
    const info = data?.iteminfo || data;
    if (!info) return { error: 'no_data' };

    const result = {
      floatvalue: info.floatvalue != null ? parseFloat(info.floatvalue) : null,
      paintseed: info.paintseed != null ? parseInt(info.paintseed, 10) : null,
      paintindex: info.paintindex != null ? parseInt(info.paintindex, 10) : null,
      defindex: info.defindex != null ? parseInt(info.defindex, 10) : null,
      phase: info.phase || null,
      market_hash_name: info.full_item_name || info.market_hash_name || null,
    };
    if (assetId) floatCache.set(assetId, { data: result, ts: Date.now() });
    return result;
  } catch (e) {
    return { error: e.message, status: e.status };
  }
}

// Batch: processa múltiplos inspect links em paralelo (com throttle)
async function fetchFloatBatch(items, concurrency = 4) {
  if (!Array.isArray(items)) return [];
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const it = items[i];
      const r = await fetchFloatByInspectLink(it.inspectLink).catch(e => ({ error: e.message }));
      results[i] = { assetid: it.assetid, ...r };
      // Throttle leve — 250ms entre requests por worker
      await new Promise(r => setTimeout(r, 250));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ── Enriquece stock do Firestore com floats ───────────────────────────────
// Estratégia:
//   1. Por cada steamId que tem stock ativo, chama BULK (/inventory) — 1 chamada = tudo.
//   2. Pros items que não apareceram no bulk (improvável), fallback via inspect link individual.
//   3. Persiste floatvalue, paintseed, paintindex, phase nos docs de stock/.
async function enrichStockWithFloats(steamIds) {
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();

    if (!process.env.STEAMWEBAPI_KEY) {
      console.warn('[FloatEnrich] STEAMWEBAPI_KEY não configurado — skip');
      return { skipped: 'no_api_key' };
    }

    // Se steamIds não foi passado, pega todos os owners distintos com stock ativo
    if (!Array.isArray(steamIds) || steamIds.length === 0) {
      const snap = await db.collection('stock')
        .where('source', '==', 'steam_inventory')
        .where('active', '==', true)
        .get();
      const set = new Set();
      snap.forEach(d => {
        const s = d.data().ownerSteamId;
        if (s) set.add(s);
      });
      steamIds = Array.from(set);
    }

    if (!steamIds.length) {
      console.log('[FloatEnrich] nenhum steamId pra processar');
      return { processed: 0 };
    }

    console.log(`[FloatEnrich] processando ${steamIds.length} contas via bulk SteamWebAPI`);

    let totalFromBulk = 0;
    let totalUpdated = 0;
    let totalFallback = 0;
    const errors = [];

    for (const sid of steamIds) {
      const bulkStart = Date.now();
      const bulk = await fetchInventoryFloats(sid);
      if (bulk.error) {
        errors.push({ steamId: sid, error: bulk.error });
        console.warn(`[FloatEnrich] ${sid} bulk erro:`, bulk.error);
        continue;
      }
      console.log(`[FloatEnrich] ${sid} bulk: ${bulk.total} items, ${bulk.withFloat} c/ float (${Date.now() - bulkStart}ms)`);
      totalFromBulk += bulk.withFloat;

      // Busca stock docs desta conta que precisam de float
      const snap = await db.collection('stock')
        .where('ownerSteamId', '==', sid)
        .where('source', '==', 'steam_inventory')
        .where('active', '==', true)
        .get();

      // Agrupa updates em batches
      let batch = db.batch();
      let batchOps = 0;
      const stillPending = [];

      for (const doc of snap.docs) {
        const d = doc.data();
        if (d.floatvalue != null && d.paintseed != null) continue; // já tem
        const match = bulk.byAssetId[String(d.assetid)];
        if (match && match.floatvalue != null) {
          batch.update(doc.ref, {
            floatvalue: match.floatvalue,
            paintseed: match.paintseed,
            paintindex: match.paintindex,
            phase: match.phase,
            floatFetchedAt: new Date().toISOString(),
            floatSource: 'bulk',
          });
          batchOps++;
          totalUpdated++;
          if (batchOps >= 400) {
            await batch.commit();
            batch = db.batch();
            batchOps = 0;
          }
        } else if (d.inspectLink) {
          stillPending.push({ docId: doc.id, assetid: d.assetid, inspectLink: d.inspectLink });
        }
      }
      if (batchOps > 0) await batch.commit();

      // Fallback individual pro que faltou (max 30 por conta pra não estourar quota)
      if (stillPending.length) {
        const toFetch = stillPending.slice(0, 30);
        console.log(`[FloatEnrich] ${sid} fallback individual: ${toFetch.length}/${stillPending.length}`);
        const results = await fetchFloatBatch(toFetch, 3);
        let fbBatch = db.batch();
        let fbOps = 0;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const p = toFetch[i];
          if (r && r.floatvalue != null) {
            fbBatch.update(db.collection('stock').doc(p.docId), {
              floatvalue: r.floatvalue,
              paintseed: r.paintseed,
              paintindex: r.paintindex,
              phase: r.phase,
              floatFetchedAt: new Date().toISOString(),
              floatSource: 'inspect',
            });
            fbOps++;
            totalFallback++;
            totalUpdated++;
            if (fbOps >= 400) { await fbBatch.commit(); fbBatch = db.batch(); fbOps = 0; }
          }
        }
        if (fbOps > 0) await fbBatch.commit();
      }
    }

    console.log(`[FloatEnrich] OK — bulk=${totalFromBulk}, fallback=${totalFallback}, updated=${totalUpdated}`);
    return {
      steamIds: steamIds.length,
      totalFromBulk,
      totalFallback,
      totalUpdated,
      errors: errors.length ? errors : undefined,
    };
  } catch (e) {
    console.error('[FloatEnrich] erro:', e.message);
    return { error: e.message };
  }
}

// ── Handler HTTP ──────────────────────────────────────────────────────────
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
    const r = await fetchFloatByInspectLink(link);
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

  // POST /api/inspect-float/sync  body: { steamIds: [...] }
  // Admin-only: enriquece stock/ com floats. Automático após sync de inventário.
  if (event.httpMethod === 'POST' && path.endsWith('/sync')) {
    const admin = require('firebase-admin');
    const ADMIN_EMAILS = ['gumaxskins@gmail.com', 'cauehorde@gmail.com'];
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    let ok = false;
    if (token) {
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        if (ADMIN_EMAILS.includes((decoded.email || '').toLowerCase())) ok = true;
      } catch {
        if (process.env.ADMIN_API_KEY && token === process.env.ADMIN_API_KEY) ok = true;
      }
    }
    if (!ok) return json(401, { error: 'Unauthorized' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    const sids = Array.isArray(body.steamIds) ? body.steamIds : null;
    const r = await enrichStockWithFloats(sids);
    return json(200, r);
  }

  return json(405, { error: 'Method not allowed' });
};

exports.fetchInventoryFloats = fetchInventoryFloats;
exports.fetchFloatByInspectLink = fetchFloatByInspectLink;
exports.fetchFloatBatch = fetchFloatBatch;
exports.enrichStockWithFloats = enrichStockWithFloats;
