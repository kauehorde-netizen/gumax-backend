// ═══ Gumax — Youpin Proxy ═══
// Proxy para API pública do Youpin898
// Contorna CORS e Cloudflare fazendo request server-side

const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Top-sellers: usa Pricempire (fonte canônica que o Gumax paga) filtrando pelo
// preço Youpin — que é a base de custos reais das skins chinesas que o Gu revende.
// Retorna items com imagem da Steam CDN (via hash do icon).
// Cache 1h em memória.
const TOP_CACHE_TTL = 60 * 60 * 1000;
async function fetchYoupinTopSellers(limit = 50) {
  // Cache hit — só vale se tiver dados (nunca devolve cache vazio,
  // pra evitar erro temporário do Pricempire envenenar o cache por 1h).
  if (global._youpinTopCache && Date.now() - global._youpinTopCache.ts < TOP_CACHE_TTL
      && global._youpinTopCache.limit >= limit
      && global._youpinTopCache.data?.length > 0) {
    return global._youpinTopCache.data.slice(0, limit);
  }

  // ── Caminho 1: CSPriceAPI (preferido — preço Youpin + Buff + saleBRL calculado)
  let all = [];
  try {
    const { getTopSellers } = require('./cspriceapi');
    const top = await getTopSellers(limit);
    all = top.map(it => ({
      name: it.name,
      price_cny: it.price_cny,
      steam_price_cny: it.steam_price_cny,
      originalBRL: it.originalBRL,
      saleBRL: it.saleBRL,
      onSale: it.onSale || it.platforms,
      total: it.total || it.platforms,
      iconUrl: it.iconUrl,
      tradeable: true,
      rarity: it.rarity,
      type: it.type,
      source: 'cspriceapi',
    }));
  } catch (e) {
    console.error('[Top sellers] cspriceapi error:', e.message);
  }

  // ── Caminho 2 (FALLBACK): direto no YouPin898 quando CSPriceAPI falha/vazia
  // Garante que a home/categorias funcionam mesmo sem CSPRICEAPI_KEY configurada.
  if (all.length === 0) {
    console.warn('[Top sellers] cspriceapi vazia — caindo pro fetchYoupinTopSellersDirect');
    try {
      const direct = await fetchYoupinTopSellersDirect(limit);
      // Calcula preço BRL com fator + resolve imagem via ByMykel
      let factor = 0.78, baseFactor = 0.78;
      try {
        const { getConversionFactor, getBaseFactor } = require('./pricing');
        [factor, baseFactor] = await Promise.all([getConversionFactor(), getBaseFactor()]);
      } catch (e) {
        console.warn('[Top sellers] pricing module err — usando fator 0.78:', e.message);
      }
      let bymykelMap = null;
      try {
        const { loadBymykelImages } = require('./cspriceapi');
        bymykelMap = await loadBymykelImages();
      } catch {}
      const { resolveImageFromBymykel } = (() => {
        try { return require('./cspriceapi'); } catch { return {}; }
      })();
      all = direct.map(it => {
        // YouPin retorna iconUrl como hash Steam — montamos a URL completa
        let iconUrl = it.iconUrl || '';
        if (iconUrl && !iconUrl.startsWith('http') && !iconUrl.includes('/')) {
          iconUrl = `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}/256fx256f`;
        }
        // Se imagem do YouPin veio vazia, tenta ByMykel pelo nome
        if (!iconUrl && bymykelMap && resolveImageFromBymykel) {
          iconUrl = resolveImageFromBymykel(bymykelMap, it.name) || '';
        }
        const cny = it.price_cny || 0;
        const saleBRL = cny > 0 ? Math.round(cny * factor * 100) / 100 : 0;
        const originalBRL = cny > 0 ? Math.round(cny * 1.35 * baseFactor * 100) / 100 : 0;
        return {
          name: it.name,
          price_cny: cny,
          steam_price_cny: cny * 1.35,
          originalBRL,
          saleBRL,
          onSale: it.onSale || 0,
          total: it.total || 0,
          iconUrl,
          tradeable: it.tradeable !== false,
          rarity: '',
          type: '',
          source: 'youpin_direct',
        };
      });
      console.log(`[Top sellers] fallback YouPin direto: ${all.length} items`);
    } catch (e) {
      console.error('[Top sellers] YouPin direct fallback err:', e.message);
    }
  }

  // Pós-processamento universal: aplica image fallback (StatTrak via Normal)
  if (all.length > 0) {
    try {
      const { loadBymykelImages, applyImageFallbackPublic } = require('./cspriceapi');
      const bymykelMap = await loadBymykelImages().catch(() => null);
      if (applyImageFallbackPublic) applyImageFallbackPublic(all, bymykelMap, 'top-sellers-merged');
    } catch {}
    global._youpinTopCache = { data: all, ts: Date.now(), limit };
  } else {
    console.warn('[Top sellers] AMBOS caminhos falharam — sem itens');
  }
  return all;
}

// Força reset do cache. Útil quando Pricempire teve erro e cacheou vazio.
function clearYoupinTopCache() {
  global._youpinTopCache = null;
}
exports.clearYoupinTopCache = clearYoupinTopCache;

// Mantido pra compatibilidade — caso a gente queira futuramente voltar a usar Youpin
async function fetchYoupinTopSellersDirect(limit = 50) {
  const pageSize = 40;
  const pages = Math.ceil(limit / pageSize);
  const all = [];
  for (let page = 1; page <= pages; page++) {
    try {
      const postData = JSON.stringify({
        listType: '30', gameId: '730', keyWords: '', pageIndex: page, pageSize, sortType: '1', listSortType: '2',
      });
      const result = await new Promise((resolve) => {
        const options = {
          hostname: 'api.youpin898.com', port: 443, path: '/api/homepage/es/template/GetCsGoPagedList',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Referer': 'https://www.youpin898.com/', 'Accept': 'application/json',
            'Origin': 'https://www.youpin898.com',
          },
          timeout: 10000,
        };
        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            try { resolve(JSON.parse(body)?.Data || []); } catch { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.write(postData); req.end();
      });
      for (const i of result) {
        all.push({
          name: i.CommodityName || '', price_cny: parseFloat(i.SellMinPrice) || parseFloat(i.Price) || 0,
          onSale: i.OnSaleCount || 0, total: i.TotalCount || 0, iconUrl: i.IconUrl || '',
          tradeable: i.Tradable !== false,
        });
      }
      if (result.length < pageSize) break;
    } catch { break; }
  }
  return all.slice(0, limit);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  // GET /api/youpin/top-sellers?limit=200 (cap pra cobrir 4 páginas × 40 + sobra após dedupe)
  // Aceita ?refresh=1 pra forçar bypass do cache (útil quando o cache envenenou).
  if (event.httpMethod === 'GET' && path.endsWith('/top-sellers')) {
    const q = event.queryStringParameters || {};
    const limit = Math.min(300, Math.max(1, parseInt(q.limit, 10) || 50));
    if (q.refresh === '1') {
      clearYoupinTopCache();
      console.log('[Top sellers] cache invalidado por ?refresh=1');
    }
    try {
      const items = await fetchYoupinTopSellers(limit);
      return json(200, { count: items.length, items, cachedAt: global._youpinTopCache?.ts || null });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  try {
    const body = JSON.parse(event.body || '{}');
    const { item, items } = body;

    // Single item mode
    if (item) {
      const result = await queryYoupin(item);
      return json(200, result);
    }

    // Batch mode (up to 20 items)
    if (items && Array.isArray(items)) {
      const batch = items.slice(0, 20);
      const results = {};
      for (let i = 0; i < batch.length; i += 10) {
        const chunk = batch.slice(i, i + 10);
        const promises = chunk.map(name => queryYoupin(name).catch(e => ({ item: name, price: 0, error: e.message })));
        const responses = await Promise.all(promises);
        for (const r of responses) {
          results[r.item] = { price: r.price || 0, quantity: r.quantity || 0 };
        }
      }
      return json(200, { prices: results, count: Object.keys(results).length });
    }

    return json(400, { error: 'Send {item: "name"} or {items: ["name1", "name2"]}' });
  } catch (e) {
    console.error('[youpin-proxy] Error:', e.message);
    return json(500, { error: e.message });
  }
};

exports.fetchYoupinTopSellers = fetchYoupinTopSellers;

async function queryYoupin(itemName) {
  const postData = JSON.stringify({
    listType: "30",
    gameId: "730",
    keyWords: itemName,
    pageIndex: 1,
    pageSize: 10,
    sortType: "1",
    listSortType: "2"
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.youpin898.com',
      port: 443,
      path: '/api/homepage/es/template/GetCsGoPagedList',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.youpin898.com/',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.youpin898.com',
      },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.log(`[Youpin] HTTP ${res.statusCode} for "${itemName}": ${body.substring(0, 200)}`);
            return resolve({ item: itemName, price: 0, quantity: 0, status: res.statusCode });
          }
          const data = JSON.parse(body);
          if (data.Code === 0 && data.Data && data.Data.length > 0) {
            // Exact match by CommodityName (case-insensitive)
            const nameLower = itemName.toLowerCase();
            let match = data.Data.find(i => (i.CommodityName || '').toLowerCase() === nameLower);

            // If no exact match, try matching without the exterior
            if (!match) {
              const baseNameLower = nameLower.replace(/\s*\([^)]*\)\s*$/, '');
              match = data.Data.find(i => {
                const cn = (i.CommodityName || '').toLowerCase();
                return cn === nameLower || cn.startsWith(baseNameLower);
              });
            }

            // Only use first result if its name is very similar
            if (!match) {
              const first = data.Data[0];
              const firstLower = (first.CommodityName || '').toLowerCase();
              // Must contain the key parts of the name
              const parts = nameLower.split('|').map(s => s.trim().split('(')[0].trim());
              const allPartsMatch = parts.every(p => firstLower.includes(p));
              if (allPartsMatch) match = first;
            }

            if (!match) {
              console.log(`[Youpin] "${itemName}" → no exact match in ${data.Data.length} results (first: "${data.Data[0].CommodityName}")`);
              return resolve({ item: itemName, price: 0, quantity: 0 });
            }

            // SellMinPrice = cheapest listing (most accurate)
            // Price = may be average/reference price
            const price = parseFloat(match.SellMinPrice) || parseFloat(match.Price) || 0;
            const quantity = match.OnSaleCount || match.TotalCount || 0;
            console.log(`[Youpin] "${itemName}" → ¥${price} (${quantity} listings, matched: "${match.CommodityName}")`);
            resolve({
              item: itemName,
              price,
              quantity,
              commodityName: match.CommodityName,
              iconUrl: match.IconUrl || '',
            });
          } else {
            console.log(`[Youpin] "${itemName}" → not found (Code=${data.Code})`);
            resolve({ item: itemName, price: 0, quantity: 0 });
          }
        } catch (e) {
          console.log(`[Youpin] Parse error for "${itemName}": ${e.message}`);
          resolve({ item: itemName, price: 0, quantity: 0 });
        }
      });
      res.on('error', e => resolve({ item: itemName, price: 0, error: e.message }));
    });

    req.on('error', e => resolve({ item: itemName, price: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ item: itemName, price: 0, error: 'timeout' }); });
    req.write(postData);
    req.end();
  });
}

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}
