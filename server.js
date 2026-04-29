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
// Todos os handlers agora são carregados com tolerância a falha.
// Se um módulo tiver dep faltando (ex: pricempire.js não deployado), só essa rota 503'a.
const catalogMod         = safeRequire('./functions/catalog', 'catalog');
const skinDetailMod      = safeRequire('./functions/skin-detail', 'skin-detail');
const skinIconMod        = safeRequire('./functions/skin-icon', 'skin-icon');
const youpinProxyMod     = safeRequire('./functions/youpin-proxy', 'youpin-proxy');
const steamAuthMod       = safeRequire('./functions/steam-auth', 'steam-auth');
const createOrderMod     = safeRequire('./functions/create-order', 'create-order');
const checkPixMod        = safeRequire('./functions/check-pix', 'check-pix');
const exchangeRateMod    = safeRequire('./functions/exchange-rate', 'exchange-rate');
const adminMod           = safeRequire('./functions/admin', 'admin');
const creditsMod         = safeRequire('./functions/credits', 'credits');
const analysisMod        = safeRequire('./functions/analysis', 'analysis');
const subscriptionMod    = safeRequire('./functions/subscription', 'subscription');
const creditsPurchaseMod = safeRequire('./functions/credits-purchase', 'credits-purchase');
const buybackMod         = safeRequire('./functions/buyback', 'buyback');
const floatInspectorMod  = safeRequire('./functions/float-inspector', 'float-inspector');
const rafflesMod         = safeRequire('./functions/raffles', 'raffles');
const inspectLinkMod     = safeRequire('./functions/inspect-link', 'inspect-link');
const lobbyMod           = safeRequire('./functions/lobby', 'lobby');
const matchMod           = safeRequire('./functions/match', 'match');

const catalogHandler         = catalogMod?.handler     || disabledRoute('catalog');
const skinDetailHandler      = skinDetailMod?.handler  || disabledRoute('skin-detail');
const skinIconHandler        = skinIconMod?.handler    || disabledRoute('skin-icon');
const youpinProxyHandler     = youpinProxyMod?.handler || disabledRoute('youpin-proxy');
const steamAuthHandler       = steamAuthMod?.handler   || disabledRoute('steam-auth');
const createOrderHandler     = createOrderMod?.handler || disabledRoute('create-order');
const checkPixHandler        = checkPixMod?.handler    || disabledRoute('check-pix');
const exchangeRateHandler    = exchangeRateMod?.handler || disabledRoute('exchange-rate');
const adminHandler           = adminMod?.handler       || disabledRoute('admin');
const creditsHandler         = creditsMod?.handler     || disabledRoute('credits');
const analysisHandler        = analysisMod?.handler    || disabledRoute('analysis');
const subscriptionHandler    = subscriptionMod?.handler || disabledRoute('subscription');
const creditsPurchaseHandler = creditsPurchaseMod?.handler || disabledRoute('credits-purchase');
const buybackHandler         = buybackMod?.handler     || disabledRoute('buyback');
const floatInspectorHandler  = floatInspectorMod?.handler || disabledRoute('float-inspector');
const rafflesHandler         = rafflesMod?.handler     || disabledRoute('raffles');
const inspectLinkHandler     = inspectLinkMod?.handler || disabledRoute('inspect-link');
const lobbyHandler           = lobbyMod?.handler       || disabledRoute('lobby');
const matchHandler           = matchMod?.handler       || disabledRoute('match');
// Módulos novos: envolvidos em try/catch pra tolerância a deploys parciais.
// Se qualquer arquivo falhar, só a rota dependente é desabilitada (503 em vez de crash total).
function safeRequire(path, label) {
  try {
    return require(path);
  } catch (e) {
    console.warn(`[server] ${label} not available: ${e.message}`);
    return null;
  }
}
// MIGRAÇÃO: pricempire.js → cspriceapi.js (CSPriceAPI Trader Pro).
// O cspriceapi.js exporta as MESMAS funções que pricempire.js (getTopSellers,
// getPricempireItem, etc) + novas Pro features (float-ranged, buyorder, analyzeOverpay).
// Tenta carregar cspriceapi primeiro; se falhar (ex: arquivo não deployado ainda),
// cai pra pricempire pra rollback automático.
const cspriceMod        = safeRequire('./functions/cspriceapi', 'cspriceapi');
const pricempireMod     = cspriceMod || safeRequire('./functions/pricempire', 'pricempire');
const steamMarketMod    = safeRequire('./functions/steam-market', 'steam-market');
const priceHistoryMod   = safeRequire('./functions/price-history', 'price-history');
const steamInventoryMod = safeRequire('./functions/steam-inventory', 'steam-inventory');
const pricempireHandler     = pricempireMod?.handler     || disabledRoute('pricempire');
const steamMarketHandler    = steamMarketMod?.handler    || disabledRoute('steam-market');
const priceHistoryHandler   = priceHistoryMod?.handler   || disabledRoute('price-history');
const steamInventoryHandler = steamInventoryMod?.handler || disabledRoute('steam-inventory');

// Retorna um handler no formato event (compatível com wrapHandler) que sempre devolve 503
function disabledRoute(name) {
  return async () => ({
    statusCode: 503,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: `${name} module not deployed` }),
  });
}
const processShieldRefunds = analysisMod?.processShieldRefunds || (async () => ({ processed: 0, refunded: 0, skipped: 'analysis_not_loaded' }));
const distributeMonthlyCredits = subscriptionMod?.distributeMonthlyCredits || (async () => ({ total: 0, distributed: 0, skipped: 'subscription_not_loaded' }));
const snapshotDailyPrices = priceHistoryMod?.snapshotDailyPrices || (async () => ({ skipped: 'price_history_not_loaded' }));

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
app.post('/api/credits/admin/grant',   rateLimit(60000, 30), wrapHandler(creditsHandler));
app.post('/api/credits/admin/set-vip', rateLimit(60000, 30), wrapHandler(creditsHandler));
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

// ── Rifas (sistema de bilhetes com PIX MP) ──
app.get('/api/raffles/active',     rateLimit(60000, 120), wrapHandler(rafflesHandler));
app.get('/api/raffles/history',    rateLimit(60000, 60),  wrapHandler(rafflesHandler));
app.get('/api/raffles/my-tickets', rateLimit(60000, 60),  wrapHandler(rafflesHandler));
app.post('/api/raffles/buy',       rateLimit(60000, 20),  wrapHandler(rafflesHandler));
app.post('/api/raffles/webhook',   wrapHandler(rafflesHandler)); // sem rate limit — MP
app.post('/api/raffles/admin/create', rateLimit(60000, 5), wrapHandler(rafflesHandler));
app.post('/api/raffles/admin/draw',   rateLimit(60000, 5), wrapHandler(rafflesHandler));
app.post('/api/raffles/admin/cancel', rateLimit(60000, 5), wrapHandler(rafflesHandler));
app.options('/api/raffles/*', (req, res) => res.sendStatus(204));

// ── Lobby (matchmaker entre amigos — sala 5 slots, desafio, match) ──
// Todas as rotas auth-gated (login Steam obrigatório). Polling ~3s no frontend.
app.get('/api/lobby/list',  rateLimit(60000, 60), wrapHandler(lobbyHandler));
app.get('/api/lobby/mine',  rateLimit(60000, 60), wrapHandler(lobbyHandler));
app.post('/api/lobby/create', rateLimit(60000, 10), wrapHandler(lobbyHandler));
// Rotas com :id — Express precisa pattern explícito pra wrapHandler funcionar
app.get('/api/lobby/:id',                rateLimit(60000, 120), wrapHandler(lobbyHandler));
app.post('/api/lobby/:id/join',          rateLimit(60000, 30), wrapHandler(lobbyHandler));
app.post('/api/lobby/:id/leave',         rateLimit(60000, 30), wrapHandler(lobbyHandler));
app.post('/api/lobby/:id/kick',          rateLimit(60000, 20), wrapHandler(lobbyHandler));
app.post('/api/lobby/:id/challenge',     rateLimit(60000, 20), wrapHandler(lobbyHandler));
app.post('/api/lobby/:id/accept-challenge',  rateLimit(60000, 20), wrapHandler(lobbyHandler));
app.post('/api/lobby/:id/decline-challenge', rateLimit(60000, 20), wrapHandler(lobbyHandler));
app.options('/api/lobby/*', (req, res) => res.sendStatus(204));

// ── Match (após desafio aceito) ──
app.post('/api/match/webhook',  rateLimit(60000, 60),  wrapHandler(matchHandler)); // sem auth — secret no header
app.get('/api/match/ranking',   rateLimit(60000, 60),  wrapHandler(matchHandler));
app.get('/api/match/players',   rateLimit(60000, 120), wrapHandler(matchHandler)); // batch stats (level/KDR) pra lobbies
app.get('/api/match/player/:steamId', rateLimit(60000, 60), wrapHandler(matchHandler)); // perfil completo do player
app.get('/api/match/:id',       rateLimit(60000, 120), wrapHandler(matchHandler));
app.get('/api/match/:id/matchzy-config', rateLimit(60000, 30), wrapHandler(matchHandler)); // público pro MatchZy
app.post('/api/match/:id/confirm', rateLimit(60000, 30), wrapHandler(matchHandler));
app.post('/api/match/:id/veto',    rateLimit(60000, 30), wrapHandler(matchHandler));
app.post('/api/match/:id/abort',   rateLimit(60000, 30), wrapHandler(matchHandler)); // v36-nopass: cancela match preso (any player)
app.post('/api/match/:id/guard-validate', rateLimit(60000, 60), wrapHandler(matchHandler)); // GUARD desktop client → recebe IP/porta secretos
app.options('/api/match/*', (req, res) => res.sendStatus(204));

// ── Inspect link resolver (busca link genérico do Steam Market pra skins sem ownership) ──
app.get('/api/inspect-link', rateLimit(60000, 30), wrapHandler(inspectLinkHandler));

// ── Pricempire API (rotas mantidas, fonte canônica é cspriceapi.js agora) ──
app.get('/api/pricempire/items', rateLimit(60000, 20), wrapHandler(pricempireHandler));
app.get('/api/pricempire/suggest', rateLimit(60000, 60), wrapHandler(pricempireHandler));
app.get('/api/pricempire/search', rateLimit(60000, 60), wrapHandler(pricempireHandler));
app.get('/api/pricempire/by-category', rateLimit(60000, 30), wrapHandler(pricempireHandler));
app.post('/api/pricempire/item', rateLimit(60000, 60), wrapHandler(pricempireHandler));
// Trader Pro features (CSPriceAPI): float ranged + youpin buyorder + análise overpay
app.get('/api/pricempire/float-ranged', rateLimit(60000, 60), wrapHandler(pricempireHandler));
app.get('/api/pricempire/buyorder', rateLimit(60000, 60), wrapHandler(pricempireHandler));
app.get('/api/pricempire/bluegem-sales', rateLimit(60000, 60), wrapHandler(pricempireHandler)); // histórico vendas por pattern
app.post('/api/pricempire/analyze-overpay', rateLimit(60000, 30), wrapHandler(pricempireHandler));

// Float inspector (float exato + pattern via SteamWebAPI.com)
app.get('/api/inspect-float', rateLimit(60000, 60), wrapHandler(floatInspectorHandler));
app.post('/api/inspect-float/batch', rateLimit(60000, 10), wrapHandler(floatInspectorHandler));
app.post('/api/inspect-float/sync', rateLimit(60000, 5), wrapHandler(floatInspectorHandler));
app.options('/api/inspect-float*', (req, res) => res.sendStatus(204));

// Buyback (Vender/Upgrade/Downgrade)
app.post('/api/buyback/quote', rateLimit(60000, 60), wrapHandler(buybackHandler));
app.post('/api/buyback/create', rateLimit(60000, 10), wrapHandler(buybackHandler));
app.get('/api/buyback/my', rateLimit(60000, 30), wrapHandler(buybackHandler));
app.options('/api/buyback/*', (req, res) => res.sendStatus(204));
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
app.post('/api/admin/sync-inventory', rateLimit(60000, 3), wrapHandler(steamInventoryHandler || disabledRoute('steam-inventory')));
app.options('/api/admin/sync-inventory', (req, res) => res.sendStatus(204));

// Leitura pública do inventário Steam (qualquer user pode ver próprio inventário pra vender)
app.get('/api/steam-inventory', rateLimit(60000, 20), wrapHandler(steamInventoryHandler || disabledRoute('steam-inventory')));
app.options('/api/steam-inventory', (req, res) => res.sendStatus(204));

// Admin endpoints: 20 per minute (requires API key)
app.post('/api/admin/update-margins', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/add-stock', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/remove-stock', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/orders', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/update-order-status', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/get-pricing', rateLimit(60000, 30), wrapHandler(adminHandler));
app.post('/api/admin/update-pricing', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/get-stock-pricing', rateLimit(60000, 30), wrapHandler(adminHandler));
app.post('/api/admin/update-stock-pricing', rateLimit(60000, 20), wrapHandler(adminHandler));
app.post('/api/admin/buyback-list', rateLimit(60000, 60), wrapHandler(adminHandler));
app.post('/api/admin/buyback-update-status', rateLimit(60000, 30), wrapHandler(adminHandler));
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

// Pricempire: pré-carrega e persiste catálogo + top-sellers do dia.
// Roda:
//   - 30s depois do boot (aquece cache logo que o server sobe)
//   - Todo dia às 05:00 BRT (catálogo fresco pro primeiro usuário da manhã)
//   - Fallback a cada 12h (pra garantir que o pior caso é 12h stale)
function schedulePricempirePrewarm() {
  const prewarm = async () => {
    try {
      const mod = pricempireMod;
      if (!mod || !mod.fetchPricempireItems) return;
      const start = Date.now();
      const items = await mod.fetchPricempireItems();
      console.log(`[Pricempire prewarm] ${Object.keys(items).length} items in ${Date.now() - start}ms`);
      // Pre-aquece também o top-sellers (chamada mais comum da home)
      if (mod.getTopSellers) {
        const topStart = Date.now();
        const top = await mod.getTopSellers(50).catch(() => []);
        console.log(`[Pricempire prewarm] top-sellers ${top.length} items in ${Date.now() - topStart}ms`);
      }
    } catch (e) { console.error('[Pricempire prewarm]', e.message); }
  };

  // Calcula quantos ms faltam até a próxima 05:00 BRT (America/Sao_Paulo = UTC-3)
  function msUntilNext5amBRT() {
    const now = new Date();
    // BRT = UTC-3
    const nowBRT = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const target = new Date(nowBRT);
    target.setUTCHours(5, 0, 0, 0);
    if (target.getTime() <= nowBRT.getTime()) {
      // Já passou hoje, agenda pra amanhã
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - nowBRT.getTime();
  }

  // Prewarm imediato (30s após boot)
  setTimeout(prewarm, 30 * 1000);

  // Agenda o primeiro prewarm das 05:00 BRT e depois a cada 24h
  const msUntil5am = msUntilNext5amBRT();
  console.log(`[Pricempire prewarm] próximo às 05:00 BRT em ${Math.round(msUntil5am / 60000)} min`);
  setTimeout(() => {
    prewarm();
    setInterval(prewarm, 24 * 60 * 60 * 1000);
  }, msUntil5am);

  // Fallback a cada 12h (caso algum ciclo falhe)
  setInterval(prewarm, 12 * 60 * 60 * 1000);
}
schedulePricempirePrewarm();

// Exchange rate: pré-aquece no boot + refresh a cada 5 min.
// Assim a primeira request de preço não precisa esperar o Google Finance.
function scheduleExchangeRateRefresh() {
  const exchangeMod = safeRequire('./functions/exchange-rate', 'exchange-rate');
  if (!exchangeMod || !exchangeMod.fetchExchangeRate) return;
  const refresh = async () => {
    try {
      const rate = await exchangeMod.fetchExchangeRate();
      const cache = exchangeMod.getRateCache();
      console.log(`[Rate cron] CNY→BRL=${rate} (source=${cache.source})`);
    } catch (e) { console.error('[Rate cron]', e.message); }
  };
  setTimeout(refresh, 10 * 1000);          // 10s após boot
  setInterval(refresh, 5 * 60 * 1000);     // a cada 5 min
}
scheduleExchangeRateRefresh();

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
