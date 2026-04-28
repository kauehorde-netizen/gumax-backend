// ═══ Gumax — Inspect Link Resolver ═══
// Pra skins que NÃO estão no estoque Full do Gu (ou seja, sem inspectLink salvo),
// busca uma listagem real no Steam Community Market e devolve o inspect link dela.
// Assim o cliente pode visualizar UMA skin daquela definição (genérica) no CS2,
// mesmo sem o asset id próprio.
//
// Endpoint:
//   GET /api/inspect-link?name=AK-47%20|%20Redline%20(Field-Tested)
//     → { inspectLink: "steam://...", source: "steam_market_render|steam_market_html|cache", listingId, assetId }
//     → { error: "not_found", diag: [...] } se nenhuma estratégia retornou link
//
// Estratégias (em ordem):
//   1) GET /market/listings/730/{name}/render/  → JSON com listinginfo + assets
//   2) GET /market/listings/730/{name}          → HTML, extrai g_rgAssets/g_rgListingInfo via regex
//
// Cache 1h no Firestore (steam_market_cache/inspect:<name>) — Steam Market tem
// rate limit cruel e essas listagens não mudam de minuto em minuto.

const admin = require('firebase-admin');
const https = require('https');

// Cache 30 DIAS — inspect links de listings do Steam Market são quase sempre estáveis
// (a primeira listing fica viva por meses/anos). Como o scraping é frágil (Steam
// bloqueia frequentemente), uma vez que pegamos um link válido vale ouro.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STEAM_MARKET_OWNER_ID = '76561202255233023'; // Steam Market usa esse SteamID fixo nos inspect links

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
    // Headers que mimicam um Chrome real visitando steamcommunity.com.
    // Sem o conjunto completo, Steam serve 200 mas com payload reduzido (sem
    // listinginfo/asset.actions) e fica achando que é bot.
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
      'Accept-Encoding': 'identity',                  // sem gzip pra simplificar parsing
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': 'https://steamcommunity.com/market/',
      'Origin': 'https://steamcommunity.com',
      // Cookie de sessão fake — Steam aceita qualquer browserid + steamCountry pra
      // não disparar verificação. Alguns endpoints só servem dados completos com
      // session ID válido; pra contornar, mandamos um "navegador anônimo" plausível.
      'Cookie': [
        `browserid=${process.env.STEAM_BROWSERID || '38' + Date.now().toString().slice(-8)}`,
        'sessionidSecureOpenIDNonce=ABC',
        'steamCountry=BR%7C' + (process.env.STEAM_COOKIE_HASH || 'a1b2c3d4e5f6789012345678901234567890ab'),
        'timezoneOffset=-10800,0',
      ].join('; '),
    };
    const req = https.get(url, {
      timeout,
      headers: { ...browserHeaders, ...(opts.headers || {}) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Substitui placeholders comuns e valida formato.
// Retorna { link, raw, substituted } pra debug.
function normalizeInspectLink(rawLink, listingId, assetId) {
  if (!rawLink) return { link: null, raw: null, error: 'no_raw_link' };
  let link = rawLink
    // listing id (várias variantes)
    .replace(/%listingid%/gi, listingId || '0')
    .replace(/%listing_id%/gi, listingId || '0')
    // asset id (várias variantes)
    .replace(/%assetid%/gi, assetId || '0')
    .replace(/%asset_id%/gi, assetId || '0')
    .replace(/%assetid_string%/gi, assetId || '0')
    // owner steamid (várias variantes)
    .replace(/%owner_steamid%/gi, STEAM_MARKET_OWNER_ID)
    .replace(/%ownersteamid%/gi, STEAM_MARKET_OWNER_ID)
    .replace(/%steamid%/gi, STEAM_MARKET_OWNER_ID);

  const valid = /[SM]\d+A\d+D\d+/.test(link);
  const stillHasPlaceholder = /%[a-z_]+%/i.test(link);
  return {
    link: valid ? link : null,
    raw: rawLink,
    substituted: link,
    valid,
    stillHasPlaceholder,
    error: valid ? null : (stillHasPlaceholder ? 'unsubstituted_placeholder' : 'pattern_mismatch'),
  };
}

// ───── Estratégia 1: endpoint /render JSON ─────
async function tryRenderEndpoint(skinName, diag) {
  const encoded = encodeURIComponent(skinName);
  // URL que o Steam Market real usa (com trailing slash em /render/ e params completos):
  const url = `https://steamcommunity.com/market/listings/730/${encoded}/render/?query=&start=0&count=1&country=US&language=english&currency=1`;
  diag.push({ step: 'render_request', url });
  let res;
  try {
    res = await httpsGet(url, {
      timeout: 8000,
      headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
    });
  } catch (e) {
    diag.push({ step: 'render_network_error', error: e.message });
    return null;
  }
  diag.push({ step: 'render_response', status: res.status, bodyLen: res.body?.length || 0 });
  if (res.status !== 200) {
    if (res.status === 429) diag.push({ step: 'render_rate_limited' });
    return null;
  }
  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    diag.push({ step: 'render_parse_fail', preview: res.body?.slice(0, 200) });
    return null;
  }
  if (!data.success) {
    diag.push({ step: 'render_not_success', success: data.success });
    return null;
  }
  const listings = data.listinginfo || {};
  const firstKey = Object.keys(listings)[0];
  if (!firstKey) {
    diag.push({ step: 'render_no_listings' });
    return null;
  }
  const listing = listings[firstKey];
  const listingId = listing.listingid || firstKey;
  const asset = listing.asset || {};
  const assetId = asset.id;
  const allActions = [
    ...(asset.market_actions || []),
    ...(asset.actions || []),
  ];
  const inspectAction = allActions.find(a => a?.link && a.link.includes('+csgo_econ_action_preview'));
  if (!inspectAction) {
    diag.push({ step: 'render_no_inspect_action', actionsCount: allActions.length });
    return null;
  }
  const norm = normalizeInspectLink(inspectAction.link, listingId, assetId);
  if (!norm.link) {
    diag.push({
      step: 'render_invalid_link',
      error: norm.error,
      raw: norm.raw,
      substituted: norm.substituted,
      listingId,
      assetId,
    });
    return null;
  }
  return { inspectLink: norm.link, listingId, assetId, source: 'steam_market_render' };
}

// ───── Estratégia 2: scrape do HTML da página da listagem ─────
async function tryHtmlScrape(skinName, diag) {
  const encoded = encodeURIComponent(skinName);
  const url = `https://steamcommunity.com/market/listings/730/${encoded}`;
  diag.push({ step: 'html_request', url });
  let res;
  try {
    res = await httpsGet(url, { timeout: 10000 });
  } catch (e) {
    diag.push({ step: 'html_network_error', error: e.message });
    return null;
  }
  diag.push({ step: 'html_response', status: res.status, bodyLen: res.body?.length || 0 });
  if (res.status !== 200) return null;

  // Extrai g_rgAssets — contém actions/market_actions com inspect link template.
  // Formato: g_rgAssets = { "730": { "2": { "<assetId>": {...} } } };
  const assetsMatch = res.body.match(/g_rgAssets\s*=\s*(\{[\s\S]*?\});/);
  if (!assetsMatch) {
    diag.push({ step: 'html_no_g_rgAssets' });
    return null;
  }
  let assetsObj;
  try { assetsObj = JSON.parse(assetsMatch[1]); } catch (e) {
    diag.push({ step: 'html_assets_parse_fail', error: e.message });
    return null;
  }
  const ctxAssets = assetsObj?.['730']?.['2'] || {};
  const assetIds = Object.keys(ctxAssets);
  if (!assetIds.length) {
    diag.push({ step: 'html_no_assets' });
    return null;
  }

  // Extrai g_rgListingInfo — mapeia listingId → assetId
  const listingsMatch = res.body.match(/g_rgListingInfo\s*=\s*(\{[\s\S]*?\});/);
  let listingsObj = {};
  if (listingsMatch) {
    try { listingsObj = JSON.parse(listingsMatch[1]); } catch {}
  }

  // Pega o primeiro listing válido com inspect action
  const failures = [];
  for (const [listingId, listing] of Object.entries(listingsObj)) {
    const aId = listing?.asset?.id;
    if (!aId) { failures.push({ listingId, reason: 'no_asset_id' }); continue; }
    const asset = ctxAssets[aId];
    if (!asset) { failures.push({ listingId, aId, reason: 'no_asset_in_ctx' }); continue; }
    const allActions = [
      ...(asset.market_actions || []),
      ...(asset.actions || []),
    ];
    const inspectAction = allActions.find(a => a?.link && a.link.includes('+csgo_econ_action_preview'));
    if (!inspectAction) { failures.push({ listingId, aId, reason: 'no_inspect_action', actionsCount: allActions.length }); continue; }
    const norm = normalizeInspectLink(inspectAction.link, listingId, aId);
    if (norm.link) {
      return { inspectLink: norm.link, listingId, assetId: aId, source: 'steam_market_html' };
    }
    failures.push({ listingId, aId, reason: 'norm_failed', error: norm.error, raw: norm.raw, substituted: norm.substituted });
  }

  // Se não achou via listingsObj, tenta o primeiro asset direto
  for (const [aId, asset] of Object.entries(ctxAssets)) {
    const allActions = [
      ...(asset.market_actions || []),
      ...(asset.actions || []),
    ];
    const inspectAction = allActions.find(a => a?.link && a.link.includes('+csgo_econ_action_preview'));
    if (!inspectAction) continue;
    const norm = normalizeInspectLink(inspectAction.link, '0', aId);
    if (norm.link) {
      return { inspectLink: norm.link, listingId: '0', assetId: aId, source: 'steam_market_html_fallback' };
    }
  }

  diag.push({
    step: 'html_no_valid_action',
    listingsCount: Object.keys(listingsObj).length,
    assetsCount: assetIds.length,
    failures: failures.slice(0, 3),
  });
  return null;
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

  const diag = [];

  // Estratégia 1: endpoint /render
  let result = await tryRenderEndpoint(skinName, diag);

  // Estratégia 2: HTML scrape (se /render falhar)
  if (!result) {
    result = await tryHtmlScrape(skinName, diag);
  }

  if (!result) {
    console.warn('[inspect-link] todas estratégias falharam pra', skinName, JSON.stringify(diag));
    return { error: 'not_found', diag };
  }

  result.cachedAt = Date.now();
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
    if (result?.error) {
      return json(404, { error: 'not_found', message: 'Sem listagens no Steam Market pra esta skin', diag: result.diag });
    }
    return json(200, result);
  } catch (e) {
    console.error('[inspect-link]', e.message, e.stack);
    return json(500, { error: 'server_error', message: e.message });
  }
};

exports.findInspectLinkForSkin = findInspectLinkForSkin;
