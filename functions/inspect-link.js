// ═══ Gumax — Inspect Link Resolver ═══
// Pra skins que NÃO estão no estoque Full do Gu (ou seja, sem inspectLink salvo),
// busca uma listagem real no Steam Community Market e devolve o inspect link dela.
// Assim o cliente pode visualizar UMA skin daquela definição (genérica) no CS2,
// mesmo sem o asset id próprio.
//
// Endpoint:
//   GET /api/inspect-link?name=AK-47%20|%20Redline%20(Field-Tested)
//     → { inspectLink: "steam://...", source: "steam_market", listingId, assetId }
//     → { error: "not_found" } se não houver listagens
//
// Cache 1h no Firestore (steam_market_cache/inspect:<name>) — Steam Market tem
// rate limit cruel e essas listagens não mudam de minuto em minuto.

const admin = require('firebase-admin');
const https = require('https');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};
function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 10000;
    const req = https.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(opts.headers || {}),
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

// Constrói URL steam:// pra abrir o cliente Steam local com inspect.
//
// Steam Market listings têm formato:
//   steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20M<listingId>A<assetId>D<paramD>
//
// Onde:
//   - 76561202255233023 é o "session_steamid" (constante do CS2 no Steam Market)
//   - M = marker pra "market listing" (em vez de S = inventory)
//   - listingId = o ID da listagem
//   - assetId = o ID do asset
//   - D = "param d" — assinatura, vem no JSON da Steam
function buildInspectUrlFromMarket(listingId, assetId, paramD) {
  return `steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20M${listingId}A${assetId}D${paramD}`;
}

async function findInspectLinkForSkin(skinName) {
  const db = admin.firestore();
  const cacheKey = 'inspect:' + skinName.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 200);
  const cacheRef = db.collection('steam_market_cache').doc(cacheKey);

  // Cache hit?
  try {
    const doc = await cacheRef.get();
    if (doc.exists) {
      const data = doc.data();
      if (data.cachedAt && (Date.now() - data.cachedAt) < CACHE_TTL_MS && data.inspectLink) {
        return { ...data, source: 'cache' };
      }
    }
  } catch {}

  // Busca a primeira listagem real no Steam Market
  const encoded = encodeURIComponent(skinName);
  const url = `https://steamcommunity.com/market/listings/730/${encoded}/render?currency=7&start=0&count=1&format=json&country=BR`;
  const res = await httpsGet(url, { timeout: 8000 });
  if (res.status !== 200) {
    if (res.status === 429) throw new Error('Steam rate limited — tente em alguns minutos');
    if (res.status === 404) return null; // skin não tem listings no Market
    throw new Error(`Steam Market HTTP ${res.status}`);
  }
  let data;
  try { data = JSON.parse(res.body); } catch { return null; }
  if (!data.success) return null;

  // Estrutura da resposta:
  //   listinginfo: { "<listingId>": { listingid, asset: { id, market_actions: [{ link: "..." }] } } }
  //   assets: { "730": { "2": { "<assetId>": { ... } } } }
  const listings = data.listinginfo || {};
  const firstKey = Object.keys(listings)[0];
  if (!firstKey) return null;
  const listing = listings[firstKey];
  const listingId = listing.listingid;
  const asset = listing.asset || {};
  const assetId = asset.id;
  const marketActions = asset.market_actions || [];
  const inspectAction = marketActions.find(a => a.link && a.link.includes('+csgo_econ_action_preview'));
  if (!inspectAction) return null;

  // O `link` vem com placeholders %listingid%, %assetid% que precisam ser substituídos
  let inspectLink = inspectAction.link
    .replace('%listingid%', listingId)
    .replace('%assetid%', assetId);

  const result = {
    inspectLink,
    listingId,
    assetId,
    source: 'steam_market',
    cachedAt: Date.now(),
  };

  // Salva cache (best-effort)
  try { await cacheRef.set(result); } catch {}
  return result;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const name = event.queryStringParameters?.name;
  if (!name) return json(400, { error: 'missing_name' });

  try {
    const result = await findInspectLinkForSkin(name);
    if (!result) return json(404, { error: 'not_found', message: 'Sem listagens no Steam Market pra esta skin' });
    return json(200, result);
  } catch (e) {
    console.error('[inspect-link]', e.message);
    return json(500, { error: 'server_error', message: e.message });
  }
};

exports.findInspectLinkForSkin = findInspectLinkForSkin;
