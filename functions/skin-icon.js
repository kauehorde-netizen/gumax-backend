// ═══ Gumax — Skin Icon Endpoint ═══
// Returns Steam CDN icon URL for a given skin name
// Uses cache + Steam Community Market search

const https = require('https');

// Server-side icon cache (persists while server runs)
const iconCache = new Map();

function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 10000;
    const options = {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(opts.headers || {}),
      },
    };
    const req = https.get(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const rawName = body.name;
    if (!rawName) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'name required' }) };

    // Limpa o nome antes de buscar no Steam Market.
    // Sufixos como " - Ruby", " - Black Pearl", " - Phase 2" são adicionados por
    // outras DBs (Pricempire, CSGOFloat) mas Steam Market NÃO usa esses sufixos
    // no market_hash_name. Buscar com eles devolve match fuzzy errado (ex: caixa
    // contendo a skin ao invés da skin).
    const name = rawName.replace(/\s*-\s*(Ruby|Sapphire|Black Pearl|Emerald|Phase\s*[1-4]|Gamma\s*Phase\s*[1-4])\s*$/i, '').trim();

    // Check cache first (key by cleaned name)
    if (iconCache.has(name)) {
      const cached = iconCache.get(name);
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name, icon: cached.icon, type: cached.type, source: 'cache' }) };
    }

    console.log(`[SkinIcon] Looking up: ${name}${name !== rawName ? ' (cleaned from: ' + rawName + ')' : ''}`);

    // Method 0: SteamWebAPI items search com VALIDAÇÃO de tipo de retorno.
    // Se busca por knife retornar Case/Capsule, rejeita e tenta próximo método.
    try {
      const SWAPI_KEY = process.env.STEAMWEBAPI_KEY;
      if (SWAPI_KEY) {
        const encoded = encodeURIComponent(name);
        const url = `https://www.steamwebapi.com/steam/api/items?key=${SWAPI_KEY}&game=cs2&search=${encoded}&limit=3`;
        const res = await httpGet(url, { timeout: 6000 });
        if (res.status === 200) {
          const items = JSON.parse(res.body);
          if (Array.isArray(items) && items.length > 0) {
            // Valida: rejeita case/capsule quando não pedimos
            const askedBox = /\b(case|capsule|package)\b/i.test(name);
            for (const it of items) {
              const itName = it.markethashname || it.market_hash_name || it.name || '';
              const itType = (it.type || '').toLowerCase();
              const isBox = itType.includes('case') || itType.includes('capsule') ||
                            /\b(case|capsule|package|sticker capsule)\b/i.test(itName);
              if (isBox && !askedBox) continue;
              // Knife: tem que ter ★ se pedimos knife
              if (name.startsWith('★') && !itName.startsWith('★')) continue;
              let icon = it.image || it.icon_url || it.iconUrl || it.icon || '';
              if (icon && !icon.startsWith('http')) {
                icon = `https://community.akamai.steamstatic.com/economy/image/${icon}/256fx256f`;
              } else if (icon) {
                icon = icon.replace(/\/\d+fx\d+f$/, '/256fx256f').replace(/\/\d+x\d+$/, '/256x256');
              }
              if (icon) {
                iconCache.set(name, { icon, type: it.type || '' });
                console.log(`[SkinIcon] ✅ SteamWebAPI: ${name} → ${itName}`);
                return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name: itName, icon, type: it.type || '' }) };
              }
            }
          }
        }
      }
    } catch (e) { console.log(`[SkinIcon] SteamWebAPI error: ${e.message}`); }

    // Method 1: Steam Market /listings/{name}/render — MATCH EXATO pelo market_hash_name.
    // Mais confiável que search/ porque não há fuzzy matching errado.
    // Se o item EXISTE no Steam Market, retorna sempre o icon correto.
    try {
      const encodedName = encodeURIComponent(name);
      const url = `https://steamcommunity.com/market/listings/730/${encodedName}/render?currency=1&start=0&count=1&format=json`;
      const res = await httpGet(url, { timeout: 8000 });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        // assets contém { '730': { '2': { '<assetid>': { icon_url, ... } } } }
        const assets = data?.assets?.['730']?.['2'] || {};
        const firstAsset = Object.values(assets)[0];
        const iconHash = firstAsset?.icon_url || '';
        if (iconHash) {
          const icon = `https://community.akamai.steamstatic.com/economy/image/${iconHash}/256fx256f`;
          const type = firstAsset?.type || '';
          iconCache.set(name, { icon, type });
          console.log(`[SkinIcon] ✅ Market listings: ${name}`);
          return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name, icon, type }) };
        }
      } else if (res.status === 429) {
        console.log(`[SkinIcon] Rate limited`);
        return { statusCode: 200, headers: H, body: JSON.stringify({ success: false, error: 'Rate limited', retryable: true }) };
      } else if (res.status === 404) {
        console.log(`[SkinIcon] Item nao existe no Steam Market: ${name}`);
      }
    } catch (e) { console.log(`[SkinIcon] Market listings error: ${e.message}`); }

    // Method 2: Steam Market search (fallback fuzzy)
    try {
      const encoded = encodeURIComponent(name);
      const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&search_description=0&start=0&count=3&query=${encoded}`;
      const res = await httpGet(url, { timeout: 8000 });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.success && data.results && data.results.length > 0) {
          // Aceita primeiro resultado MAS rejeita explicitamente caixas/capsules
          for (const item of data.results) {
            const itemName = item.asset_description?.market_hash_name || item.hash_name || item.name || '';
            // Rejeita caixas/capsules quando NÃO pedimos uma
            const isBox = /\b(case|capsule|package|sticker capsule)\b/i.test(itemName);
            const askedBox = /\b(case|capsule|package)\b/i.test(name);
            if (isBox && !askedBox) continue;
            const iconHash = item.asset_description?.icon_url || '';
            if (iconHash) {
              const icon = `https://community.akamai.steamstatic.com/economy/image/${iconHash}/256fx256f`;
              iconCache.set(name, { icon, type: item.asset_description?.type || '' });
              console.log(`[SkinIcon] ✅ Market search: ${name} → ${itemName}`);
              return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name, icon }) };
            }
          }
        }
      }
    } catch (e) { console.log(`[SkinIcon] Market search error: ${e.message}`); }

    console.log(`[SkinIcon] ❌ Not found: ${name}`);
    return { statusCode: 200, headers: H, body: JSON.stringify({ success: false, error: 'Icon not found', retryable: true }) };

  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};

// Export cache for other functions to populate
exports.iconCache = iconCache;
