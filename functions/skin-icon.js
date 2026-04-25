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

    // Method 0: SteamWebAPI items search (PRIMEIRO — mais confiável que Steam Market scraping).
    // Tem TODOS os items do CS2 incluindo Gamma Doppler phases, Crimson Web variants, etc.
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

    // Heurística pra detectar se um item retornado bate com o que pedimos:
    // - Pediu knife (★) → retorno tem que começar com ★ e NÃO ter "Case" no nome
    // - Pediu weapon (AK-47, AWP, etc) → retorno tem que conter o prefixo da arma
    // - Pediu sticker → retorno deve começar com "Sticker"
    function isResultRelevant(askedName, returnedName) {
      if (!returnedName) return false;
      const asked = askedName.toLowerCase();
      const returned = returnedName.toLowerCase();
      // Rejeita caixas/capsules quando pedimos arma/faca/luva
      if (/\b(case|capsule|package|sticker capsule)\b/i.test(returnedName) &&
          !/\b(case|capsule|package)\b/i.test(askedName)) return false;
      // Knife: ambos devem começar com ★
      if (asked.startsWith('★') && !returned.startsWith('★')) return false;
      // Sticker: ambos devem começar com "sticker"
      if (asked.startsWith('sticker |') && !returned.startsWith('sticker |')) return false;
      // Weapon prefix match: "AK-47 | Redline" → returned must start with "AK-47 |"
      const askedPrefix = asked.replace(/^★\s*/, '').replace(/^stattrak™\s*/, '').replace(/^souvenir\s+/, '').split(' |')[0];
      if (askedPrefix && !returned.includes(askedPrefix)) return false;
      return true;
    }

    // Method 1: Steam Community Market search com count=5 pra escolher o melhor match
    try {
      const encoded = encodeURIComponent(name);
      const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&search_description=0&start=0&count=5&query=${encoded}`;
      const res = await httpGet(url, { timeout: 8000 });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.success && data.results && data.results.length > 0) {
          // Procura entre os top 5 o que casa com o tipo pedido
          let pickedItem = null;
          for (const item of data.results) {
            const itemName = item.asset_description?.market_hash_name || item.hash_name || item.name || '';
            if (isResultRelevant(name, itemName)) {
              pickedItem = item;
              break;
            }
          }
          // Se nada matchou, NÃO retorna lixo — devolve null pra frontend cair em shimmer
          if (!pickedItem) {
            console.log(`[SkinIcon] ⚠️ ${data.results.length} resultados mas nenhum bate com "${name}" — retornando null`);
            iconCache.set(name, { icon: '', type: '' }); // negative cache pra não tentar de novo
            return { statusCode: 200, headers: H, body: JSON.stringify({ success: false, error: 'no relevant match' }) };
          }
          const iconHash = pickedItem.asset_description?.icon_url || '';
          if (iconHash) {
            const icon = `https://community.akamai.steamstatic.com/economy/image/${iconHash}/256fx256f`;
            const type = pickedItem.asset_description?.type || '';
            iconCache.set(name, { icon, type });
            console.log(`[SkinIcon] ✅ Market: ${name} → ${pickedItem.hash_name || name}`);
            return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, name: pickedItem.hash_name || name, icon, type }) };
          }
        }
      } else if (res.status === 429) {
        console.log(`[SkinIcon] Rate limited`);
        return { statusCode: 200, headers: H, body: JSON.stringify({ success: false, error: 'Rate limited', retryable: true }) };
      }
    } catch (e) { console.log(`[SkinIcon] Market error: ${e.message}`); }

    console.log(`[SkinIcon] ❌ Not found: ${name}`);
    return { statusCode: 200, headers: H, body: JSON.stringify({ success: false, error: 'Icon not found', retryable: true }) };

  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};

// Export cache for other functions to populate
exports.iconCache = iconCache;
