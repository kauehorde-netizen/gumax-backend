// ═══ Gumax Skins Backend — Express Server ═══
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Firebase Admin Init ──
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : {
        project_id: process.env.FIREBASE_PROJECT_ID || 'gumax-skins',
        client_email: process.env.FIREBASE_CLIENT_EMAIL || '',
        private_key: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      };
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || 'gumax-skins',
  });
  console.log('[Firebase] Admin SDK initialized for project:', serviceAccount.project_id || 'gumax-skins');
}

// ── Rate Limiter (in-memory, no dependency) ──
const rateLimits = new Map();
function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const key = ip + ':' + req.path;
    const now = Date.now();
    if (!rateLimits.has(key)) rateLimits.set(key, []);
    const hits = rateLimits.get(key).filter(t => t > now - windowMs);
    if (hits.length >= maxRequests) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again later.', retryAfter: Math.ceil(windowMs / 1000) });
    }
    hits.push(now);
    rateLimits.set(key, hits);
    next();
  };
}

// Clean up old entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimits.entries()) {
    const valid = hits.filter(t => t > now - 300000);
    if (valid.length === 0) rateLimits.delete(key);
    else rateLimits.set(key, valid);
  }
}, 300000);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Security headers ──
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Gumax Skins API', uptime: process.uptime() }));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  cache: {
    catalog: !!global._catalogCache?.data,
    items: global._catalogCache?.data ? global._catalogCache.data.length : 0,
    age: global._catalogCache?.ts ? Math.floor((Date.now() - global._catalogCache.ts) / 1000) + 's' : 'empty',
  }
}));

// ── Wrapper: converts Express req/res to handler format ──
function wrapHandler(handler) {
  return async (req, res) => {
    try {
      const event = {
        httpMethod: req.method,
        path: req.path,
        body: JSON.stringify(req.body),
        queryStringParameters: req.query,
        headers: req.headers,
      };
      const result = await handler(event);
      // Set headers
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (k.toLowerCase() !== 'access-control-allow-origin') res.setHeader(k, v);
        }
      }
      res.status(result.statusCode || 200);
      if (typeof result.body === 'string') {
        try { res.json(JSON.parse(result.body)); }
        catch { res.send(result.body); }
      } else {
        res.json(result.body);
      }
    } catch (e) {
      console.error(`[${req.path}] Error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

// ── Load all function handlers ──
const catalogHandler = require('./functions/catalog').handler;
const skinDetailHandler = require('./functions/skin-detail').handler;
const skinIconHandler = require('./functions/skin-icon').handler;
const youpinProxyHandler = require('./functions/youpin-proxy').handler;
const steamAuthHandler = require('./functions/steam-auth').handler;
const createOrderHandler = require('./functions/create-order').handler;
const checkPixHandler = require('./functions/check-pix').handler;
const exchangeRateHandler = require('./functions/exchange-rate').handler;
const adminHandler = require('./functions/admin').handler;
const creditsHandler = require('./functions/credits').handler;
const analysisHandler = require('./functions/analysis').handler;
const subscriptionHandler = require('./functions/subscription').handler;
const creditsPurchaseHandler = require('./functions/credits-purchase').handler;
const pricempireHandler = require('./functions/pricempire').handler;
const steamMarketHandler = require('./functions/steam-market').handler;
const priceHistoryHandler = require('./functions/price-history').handler;
// Módulos opcionais: se o arquivo não foi deployado ainda, desabilita a rota em vez de crashar
let steamInventoryHandler = null;
try {
  steamInventoryHandler = require('./functions/steam-inventory').handler;
} catch (e) {
  console.warn('[server] steam-inventory not available — route will be disabled:', e.message);
}
const { processShieldRefunds } = require('./functions/analysis');
const { distributeMonthlyCredits } = require('./functions/subscription');
const { snapshotDailyPrices } = require('./functions/price-history');

// ── Routes (with rate limiting) ──

// Catalog: 30 requests per minute per IP
app.post('/api/catalog', rateLimit(60000, 30), wrapHandler(catalogHandler));
app.options('/api/catalog', (req, res) => res.sendStatus(204));

// Skin detail: 30 per minute
app.post('/api/skin-detail', rateLimit(60000, 30), wrapHandler(skinDetailHandler));
app.options('/api/skin-detail', (req, res) => res.sendStatus(204));

// Skin icon: 60 per minute (used heavily for grids)
app.post('/api/skin-icon', rateLimit(60000, 60), wrapHandler(skinIconHandler));
app.options('/api/skin-icon', (req, res) => res.sendStatus(204));

// Youpin proxy: 30 per minute
app.post('/api/youpin-proxy', rateLimit(60000, 30), wrapHandler(youpinProxyHandler));
app.get('/api/youpin/top-sellers', rateLimit(60000, 60), wrapHandler(youpinProxyHandler));
app.options('/api/youpin-proxy', (req, res) => res.sendStatus(204));
app.options('/api/youpin/*', (req, res) => res.sendStatus(204));

// Steam auth: 20 per minute
app.get('/api/steam-auth', rateLimit(60000, 20), wrapHandler(steamAuthHandler));
app.post('/api/steam-auth', rateLimit(60000, 20), wrapHandler(steamAuthHandler));
app.get('/api/steam-auth/callback', rateLimit(60000, 20), wrapHandler(steamAuthHandler));
app.options('/api/steam-auth', (req, res) => res.sendStatus(204));

// Create order: 10 per minute
app.post('/api/create-order', rateLimit(60000, 10), wrapHandler(createOrderHandler));
app.options('/api/create-order', (req, res) => res.sendStatus(204));

// Check PIX: 20 per minute
app.post('/api/check-pix', rateLimit(60000, 20), wrapHandler(checkPixHandler));
app.options('/api/check-pix', (req, res) => res.sendStatus(204));

// Exchange rate: 30 per minute
app.get('/api/exchange-rate', rateLimit(60000, 30), wrapHandler(exchangeRateHandler));
app.options('/api/exchange-rate', (req, res) => res.sendStatus(204));

// Credits endpoints: authenticated per user; moderate rate limits
app.get('/api/credits/balance', rateLimit(60000, 60), wrapHandler(creditsHandler));
app.post('/api/credits/balance', rateLimit(60000, 60), wrapHandler(creditsHandler));
app.post('/api/credits/grant-initial', rateLimit(60000, 5), wrapHandler(creditsHandler));
app.post('/api/credits/consume', rateLimit(60000, 60), wrapHandler(creditsHandler));
app.post('/api/credits/award', rateLimit(60000, 20), wrapHandler(creditsHandler));
app.options('/api/credits/*', (req, res) => res.sendStatus(204));

// Skin analysis: paid tiers debit credits atomically; cache 15min
app.post('/api/analysis', rateLimit(60000, 30), wrapHandler(analysisHandler));
app.options('/api/analysis', (req, res) => res.sendStatus(204));

// ── Subscription (Gumax Pro) ──
app.get('/api/subscription/plans', rateLimit(60000, 60), wrapHandler(subscriptionHandler));
app.get('/api/subscription/status', rateLimit(60000, 60), wrapHandler(subscriptionHandler));
app.post('/api/subscription/create', rateLimit(60000, 10), wrapHandler(subscriptionHandler));
app.post('/api/subscription/cancel', rateLimit(60000, 10), wrapHandler(subscriptionHandler));
app.post('/api/subscription/webhook', wrapHandler(subscriptionHandler)); // sem rate limit — MP
app.post('/api/subscription/distribute', rateLimit(60000, 5), wrapHandler(subscriptionHandler));
app.options('/api/subscription/*', (req, res) => res.sendStatus(204));

// ── Credit purchases (pacotes avulsos via PIX) ──
app.get('/api/credits/packages', rateLimit(60000, 60), wrapHandler(creditsPurchaseHandler));
app.post('/api/credits/purchase', rateLimit(60000, 20), wrapHandler(creditsPurchaseHandler));
app.post('/api/credits/purchase/webhook', wrapHandler(creditsPurchaseHandler)); // sem rate limit — MP
app.options('/api/credits/purchase', (req, res) => res.sendStatus(204));

// ── Pricempire API (fonte canônica de preços, base Youpin) ──
app.get('/api/pricempire/items', rateLimit(60000, 20), wrapHandler(pricempireHandler));
app.get('/api/pricempire/suggest', rateLimit(60000, 60), wrapHandler(pricempireHandler));
app.post('/api/pricempire/item', rateLimit(60000, 60), wrapHandler(pricempireHandler));
app.options('/api/pricempire/*', (req, res) => res.sendStatus(204));

// Aliases legados — redirecionam rotas /api/skinport/* pra pricempire pra não quebrar chamadas antigas
app.get('/api/skinport/items', rateLimit(60000, 20), wrapHandler(pricempireHandler));
app.get('/api/skinport/suggest', rateLimit(60000, 60), wrapHandler(pricempireHandler));
app.post('/api/skinport/item', rateLimit(60000, 60), wrapHandler(pricempireHandler));

// ── Steam Market (cacheado 24h) ──
app.post('/api/steam-market/price', rateLimit(60000, 30), wrapHandler(steamMarketHandler));
app.options('/api/steam-market/*', (req, res) => res.sendStatus(204));

// ── Price History (snapshots próprios) ──
app.get('/api/price-history', rateLimit(60000, 30), wrapHandler(priceHistoryHandler));
app.post('/api/price-history/snapshot', rateLimit(60000, 2), wrapHandler(priceHistoryHandler));
app.options('/api/price-history', (req, res) => res.sendStatus(204));

// ── Gumax Shield cron (admin-only trigger) ──
app.post('/api/shield/process', rateLimit(60000, 5), async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'admin key required' });
  try {
    const result = await processShieldRefunds();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: sync de inventário Steam (pesado — 3 por minuto)
if (steamInventoryHandler) {
  app.post('/api/admin/sync-inventory', rateLimit(60000, 3), wrapHandler(steamInventoryHandler));
  app.options('/api/admin/sync-inventory', (req, res) => res.sendStatus(204));
} else {
  app.post('/api/admin/sync-inventory', (req, res) => res.status(503).json({ error: 'steam-inventory module not deployed' }));
}

// Admin endpoints: 20 per minute (requires API key)
app.post('/api/admin/update-margins', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/add-stock', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/remove-stock', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/orders', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/update-order-status', rateLimit(60000, 20), wrapHandler(adminHandler));
app.options('/api/admin/*', (req, res) => res.sendStatus(204));

// Image proxy: 100 per minute (used for displaying skins)
app.get('/api/proxy-image', rateLimit(60000, 100), async (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes('steamstatic.com')) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const https = require('https');
    https.get(url, (imgRes) => {
      res.set('Content-Type', imgRes.headers['content-type'] || 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      imgRes.pipe(res);
    }).on('error', (e) => res.status(500).json({ error: e.message }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Background jobs ──
// Shield: roda a cada hora pra processar refunds de janelas expiradas
// Subscription: roda a cada 6h pra distribuir 200 créditos a quem chegou na data
setInterval(async () => {
  try {
    const r = await processShieldRefunds();
    if (r.processed > 0) console.log(`[Shield] processed=${r.processed} refunded=${r.refunded}`);
  } catch (e) { console.error('[Shield cron]', e.message); }
}, 60 * 60 * 1000); // 1h

setInterval(async () => {
  try {
    const r = await distributeMonthlyCredits();
    if (r.total > 0) console.log(`[Subscription] distributed=${r.distributed}/${r.total}`);
  } catch (e) { console.error('[Subscription cron]', e.message); }
}, 6 * 60 * 60 * 1000); // 6h

// Price History: snapshot diário do catálogo Skinport → Firestore.
// Rodamos 1x/dia às ~03h UTC; se o servidor reiniciar, roda de novo no próximo tick.
// O snapshot é idempotente (skipa se já existe completo naquela data).
function scheduleDailySnapshot() {
  const runSnapshot = async () => {
    try {
      const r = await snapshotDailyPrices();
      console.log('[PriceHistory]', r);
    } catch (e) { console.error('[PriceHistory cron]', e.message); }
  };
  // Primeira execução: em 5 min (dá tempo do server quentar), depois a cada 24h
  setTimeout(() => {
    runSnapshot();
    setInterval(runSnapshot, 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);
}
scheduleDailySnapshot();

// ── Start server ──
app.listen(PORT, () => {
  console.log(`[Server] Gumax Skins API running on port ${PORT}`);
  console.log(`[Server] Routes: /api/catalog, /api/skin-detail, /api/skin-icon, /api/create-order, /api/check-pix`);
  console.log(`[Server] Credits: /api/credits/* , /api/analysis , /api/subscription/*`);
  console.log(`[Server] Pricing: /api/skinport/* , /api/steam-market/* , /api/price-history`);
  console.log(`[Server] Admin: /api/admin/update-margins, /api/admin/add-stock, /api/admin/orders, /api/shield/process`);
});
