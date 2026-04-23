// ═══ Gumax — Youpin Proxy ═══
// Proxy para API pública do Youpin898
// Contorna CORS e Cloudflare fazendo request server-side

const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Top-sellers: página o GetCsGoPagedList SEM keyWords, ordenando por vendas.
// Cacheado em memória por 1h pra reduzir carga.
const TOP_CACHE_TTL = 60 * 60 * 1000;
async function fetchYoupinTopSellers(limit = 50) {
  if (global._youpinTopCache && Date.now() - global._youpinTopCache.ts < TOP_CACHE_TTL
      && global._youpinTopCache.limit >= limit) {
    return global._youpinTopCache.data.slice(0, limit);
  }

  const pageSize = 40;
  const pages = Math.ceil(limit / pageSize);
  const all = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const postData = JSON.stringify({
        listType: '30',
        gameId: '730',
        keyWords: '',
        pageIndex: page,
        pageSize,
        sortType: '1',    // 1 = order by popularity/volume
        listSortType: '2',
      });

      const result = await new Promise((resolve) => {
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
            'Origin': 'https://www.youpin898.com',
          },
          timeout: 10000,
        };
        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              resolve(data?.Data || []);
            } catch { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.write(postData);
        req.end();
      });

      for (const i of result) {
        all.push({
          name: i.CommodityName || '',
          price_cny: parseFloat(i.SellMinPrice) || parseFloat(i.Price) || 0,
          onSale: i.OnSaleCount || 0,
          total: i.TotalCount || 0,
          iconUrl: i.IconUrl || '',
          tradeable: i.Tradable !== false,
        });
      }
      if (result.length < pageSize) break; // fim
    } catch (e) {
      console.log('[Youpin top] page', page, e.message);
      break;
    }
  }

  global._youpinTopCache = { data: all, ts: Date.now(), limit };
  return all.slice(0, limit);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  // GET /api/youpin/top-sellers?limit=50
  if (event.httpMethod === 'GET' && path.endsWith('/top-sellers')) {
    const q = event.queryStringParameters || {};
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 50));
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
