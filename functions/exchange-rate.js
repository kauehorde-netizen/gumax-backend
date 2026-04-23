// ═══ Gumax — Exchange Rate CNY → BRL ═══════════════════════════
// Portado do FlowSkins: Google Finance (valor exato que o usuário vê no Google)
// → Wise → AwesomeAPI → Frankfurter → open.er-api como fallbacks.
// Cache 5 min (Google atualiza ~1x/min).
//
// Uso:
//   const { fetchExchangeRate } = require('./functions/exchange-rate');
//   const rate = await fetchExchangeRate();  // número (ex: 0.7423)
//
// Endpoint HTTP: GET /api/exchange-rate → { rate, source, age }

const https = require('https');
const zlib = require('zlib');

const RATE_TTL = 5 * 60 * 1000; // 5 min
let rateCache = { value: 0, ts: 0, source: 'default' };

function rd4(v) { return Math.round(v * 10000) / 10000; }

// GET tolerante: segue redirect, trata gzip/deflate/brotli, timeout 9s.
function httpGet(url, opts = {}) {
  const timeout = opts.timeout || 9000;
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      ...opts.headers,
    };
    const req = https.get(url, { headers }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const loc = r.headers.location.startsWith('http')
          ? r.headers.location
          : new URL(r.headers.location, url).toString();
        r.resume();
        return httpGet(loc, opts).then(resolve).catch(reject);
      }
      let stream = r;
      const enc = (r.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = r.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = r.pipe(zlib.createInflate());
      else if (enc === 'br') stream = r.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchExchangeRate() {
  const now = Date.now();
  if (rateCache.value > 0 && (now - rateCache.ts) < RATE_TTL) return rateCache.value;

  // 1) Google Finance — valor exato da cotação que o usuário vê no Google
  try {
    const x = await httpGet('https://www.google.com/finance/quote/CNY-BRL', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    if (x.status === 200 && x.body) {
      // Google embute em data-last-price="0.7312"
      const m = x.body.match(/data-last-price="([0-9]+\.?[0-9]*)"/);
      if (m && m[1]) {
        const rate = parseFloat(m[1]);
        if (rate > 0 && rate < 5) {
          rateCache = { value: rate, ts: now, source: 'google' };
          console.log(`[Rate] Google Finance: CNY→BRL = ${rate}`);
          return rate;
        }
      }
      // Fallback regex pra outra variação de markup do Google
      const m2 = x.body.match(/class="YMlKec fxKbKc">([0-9]+[.,][0-9]+)</);
      if (m2 && m2[1]) {
        const rate = parseFloat(m2[1].replace(',', '.'));
        if (rate > 0 && rate < 5) {
          rateCache = { value: rate, ts: now, source: 'google' };
          console.log(`[Rate] Google Finance (v2): CNY→BRL = ${rate}`);
          return rate;
        }
      }
    }
  } catch (e) { console.error('[Rate] Google:', e.message); }

  // 2) Wise API — mid-market
  try {
    const x = await httpGet('https://api.wise.com/v1/rates?source=CNY&target=BRL', { timeout: 5000 });
    if (x.status === 200) {
      const arr = JSON.parse(x.body);
      if (Array.isArray(arr) && arr.length > 0 && arr[0].rate) {
        const rate = rd4(arr[0].rate);
        if (rate > 0) {
          rateCache = { value: rate, ts: now, source: 'wise' };
          console.log(`[Rate] Wise: CNY→BRL = ${rate}`);
          return rate;
        }
      }
    }
  } catch (e) { console.error('[Rate] Wise:', e.message); }

  // 3) AwesomeAPI — BR, real-time. Pega o menor de low/bid (mais próximo do Google)
  try {
    const x = await httpGet('https://economia.awesomeapi.com.br/json/last/CNY-BRL', { timeout: 5000 });
    if (x.status === 200) {
      const d = JSON.parse(x.body);
      if (d.CNYBRL) {
        const low = parseFloat(d.CNYBRL.low || d.CNYBRL.bid);
        const bid = parseFloat(d.CNYBRL.bid);
        const rate = Math.min(low, bid);
        if (rate > 0) {
          rateCache = { value: rd4(rate), ts: now, source: 'awesomeapi' };
          console.log(`[Rate] AwesomeAPI: CNY→BRL = ${rate} (low=${low} bid=${bid})`);
          return rateCache.value;
        }
      }
    }
  } catch (e) { console.error('[Rate] AwesomeAPI:', e.message); }

  // 4) Frankfurter — ECB free
  try {
    const x = await httpGet('https://api.frankfurter.dev/v1/latest?from=CNY&to=BRL', { timeout: 5000 });
    if (x.status === 200) {
      const d = JSON.parse(x.body);
      if (d.rates && d.rates.BRL) {
        const rate = rd4(d.rates.BRL);
        rateCache = { value: rate, ts: now, source: 'frankfurter' };
        console.log(`[Rate] Frankfurter: CNY→BRL = ${rate}`);
        return rate;
      }
    }
  } catch (e) { console.error('[Rate] Frankfurter:', e.message); }

  // 5) open.er-api — último recurso
  try {
    const x = await httpGet('https://open.er-api.com/v6/latest/CNY', { timeout: 5000 });
    if (x.status === 200) {
      const d = JSON.parse(x.body);
      if (d.rates && d.rates.BRL) {
        rateCache = { value: d.rates.BRL, ts: now, source: 'open-er-api' };
        console.log(`[Rate] open.er-api: CNY→BRL = ${d.rates.BRL}`);
        return rateCache.value;
      }
    }
  } catch (e) { console.error('[Rate] open.er-api:', e.message); }

  // Fallback final: 0.78 (valor que o Gu trabalha)
  return rateCache.value > 0 ? rateCache.value : 0.78;
}

function getRateCache() {
  return { value: rateCache.value, ts: rateCache.ts, source: rateCache.source };
}

// ── Handler HTTP ────────────────────────────────────────────────
const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };
  }
  try {
    const rate = await fetchExchangeRate();
    const c = getRateCache();
    const age = c.ts ? Math.floor((Date.now() - c.ts) / 1000) + 's' : 'fresh';
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        rate,
        from: 'CNY',
        to: 'BRL',
        source: c.source,
        age,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

exports.fetchExchangeRate = fetchExchangeRate;
exports.getRateCache = getRateCache;
