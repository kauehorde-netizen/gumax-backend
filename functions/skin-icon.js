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
    const name = body.name;
    if (!name) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'name required' }) };

    // Check cache first
    if (iconCache.has(name)) {
      const cached = iconCache.get(name);
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name, icon: cached.icon, type: cached.type, source: 'cache' }) };
    }

    console.log(`[SkinIcon] Looking up: ${name}`);

    // Method 1: Steam Community Market search
    try {
      const encoded = encodeURIComponent(name);
      const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&search_description=0&start=0&count=1&query=${encoded}`;
      const res = await httpGet(url, { timeout: 8000 });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.success && data.results && data.results.length > 0) {
          const item = data.results[0];
          const iconHash = item.asset_description?.icon_url || '';
          if (iconHash) {
            const icon = `https://community.akamai.steamstatic.com/economy/image/${iconHash}/256fx256f`;
            const type = item.asset_description?.type || '';
            iconCache.set(name, { icon, type });
            console.log(`[SkinIcon] ✅ Market: ${name}`);
            return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name: item.hash_name || name, icon, type }) };
          }
        }
      } else if (res.status === 429) {
        console.log(`[SkinIcon] Rate limited, will retry later`);
        return { statusCode: 200, headers: H, body: JSON.stringify({ success: false, error: 'Rate limited, retry later', retryable: true }) };
      }
    } catch (e) { console.log(`[SkinIcon] Market error: ${e.message}`); }

    // Method 2: SteamWebAPI items search (fallback)
    try {
      const SWAPI_KEY = process.env.STEAMWEBAPI_KEY;
      if (SWAPI_KEY) {
        const encoded = encodeURIComponent(name);
        const url = `https://www.steamwebapi.com/steam/api/items?key=${SWAPI_KEY}&game=cs2&search=${encoded}&limit=1`;
        const res = await httpGet(url, { timeout: 6000 });
        if (res.status === 200) {
          const items = JSON.parse(res.body);
          if (Array.isArray(items) && items.length > 0) {
            const it = items[0];
            let icon = it.image || it.icon_url || it.iconUrl || it.icon || '';
            if (icon && !icon.startsWith('http')) {
              icon = `https://community.akamai.steamstatic.com/economy/image/${icon}/256fx256f`;
            } else if (icon) {
              icon = icon.replace(/\/\d+fx\d+f$/, '/256fx256f').replace(/\/\d+x\d+$/, '/256x256');
            }
            if (icon) {
              const type = it.type || '';
              iconCache.set(name, { icon, type });
              console.log(`[SkinIcon] ✅ SteamWebAPI: ${name}`);
              return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name: it.markethashname || name, icon, type }) };
            }
          }
        }
      }
    } catch (e) { console.log(`[SkinIcon] SteamWebAPI error: ${e.message}`); }

    console.log(`[SkinIcon] ❌ Not found: ${name}`);
    return { statusCode: 200, headers: H, body: JSON.stringify({ success: false, error: 'Icon not found', retryable: true }) };

  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};

// Export cache for other functions to populate
exports.iconCache = iconCache;
