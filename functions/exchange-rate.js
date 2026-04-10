// ═══ Gumax — Exchange Rate Endpoint ═══
// Returns CNY to BRL exchange rate with 60-minute cache

function rd(val) {
  return Math.round(val * 100) / 100;
}

async function fetchExchangeRate() {
  // Check cache (60 min)
  if (global._rateCache && global._rateCache.ts && Date.now() - global._rateCache.ts < 60 * 60 * 1000) {
    console.log('[ExchangeRate] Using cached rate');
    return {
      value: global._rateCache.value,
      source: 'cache',
      age: Math.floor((Date.now() - global._rateCache.ts) / 1000) + 's'
    };
  }

  try {
    console.log('[ExchangeRate] Fetching fresh rate...');
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', {
      timeout: 5000
    });

    const data = await response.json();
    const rate = data.rates?.BRL || 0.68;

    global._rateCache = {
      value: rate,
      ts: Date.now()
    };

    console.log(`[ExchangeRate] Fetched: CNY 1 = BRL ${rd(rate)}`);

    return {
      value: rd(rate),
      source: 'fresh',
      age: '0s'
    };
  } catch (e) {
    console.error('[ExchangeRate] Fetch error:', e.message);

    // Return cached value or fallback
    const cached = global._rateCache?.value || 0.68;
    console.log(`[ExchangeRate] Using fallback/cached: ${rd(cached)}`);

    return {
      value: rd(cached),
      source: global._rateCache ? 'cached' : 'fallback',
      age: global._rateCache ? Math.floor((Date.now() - global._rateCache.ts) / 1000) + 's' : 'unknown',
      error: e.message
    };
  }
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: H, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'GET only' }) };
  }

  try {
    const rateData = await fetchExchangeRate();

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        success: true,
        rate: rateData.value,
        from: 'CNY',
        to: 'BRL',
        timestamp: new Date().toISOString(),
        cache: {
          source: rateData.source,
          age: rateData.age
        }
      })
    };

  } catch (e) {
    console.error('[ExchangeRate] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
