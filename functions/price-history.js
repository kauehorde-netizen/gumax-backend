// ═══ Gumax — Price History (internal) ═══
// Construímos nosso próprio histórico de preços fazendo um snapshot diário
// do catálogo Skinport + Steam Market. Isso nos dá tendência/variação
// sem depender da Pricempire.
//
// Estratégia:
//   - Job diário roda 1x/dia (default 03:00 UTC).
//   - Puxa Skinport bulk, salva {date, items: {name: min_price_usd}} em
//     `price_snapshots/{YYYY-MM-DD}`.
//   - Endpoint GET /api/price-history?name=X&days=30 reconstrói a série
//     buscando os últimos N snapshots do Firestore.
//
// Colunas (custo Firestore):
//   - ~25.000 skins × 365 dias × ~40 bytes/entry = ~360MB/ano
//   - Free tier: 1GB storage, 50k reads/dia, 20k writes/dia → folgado
//
// Em 7 dias de snapshots a tendência começa a ficar útil. Em 30 dias é
// comparável à Pricempire. Roda "em paralelo" mesmo quando a Pricempire
// está ativa, então o sistema tem fallback se a Pricempire cair.

const admin = require('firebase-admin');
const { fetchSkinportItems } = require('./skinport');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Snapshot diário ───────────────────────────────────────────────────────
// Chamado pelo cron in-process do server.js (e também via POST /api/price-history/snapshot
// autenticado com ADMIN_API_KEY pra rodar manualmente).
async function snapshotDailyPrices() {
  const db = admin.firestore();
  const date = todayISO();
  const ref = db.collection('price_snapshots').doc(date);

  // Se já rodou hoje, skip (idempotente)
  const existing = await ref.get();
  if (existing.exists && existing.data()?.complete) {
    return { date, skipped: true, reason: 'already_complete' };
  }

  const items = await fetchSkinportItems();
  const names = Object.keys(items);
  if (names.length === 0) return { date, skipped: true, reason: 'no_skinport_data' };

  // Firestore document tem limite de 1MB. 25k skins × ~40 bytes = 1MB exato.
  // Vamos segmentar em chunks de 5000 pra ter margem.
  const CHUNK_SIZE = 5000;
  let totalWritten = 0;

  for (let i = 0; i < names.length; i += CHUNK_SIZE) {
    const chunk = names.slice(i, i + CHUNK_SIZE);
    const chunkIdx = Math.floor(i / CHUNK_SIZE);
    const chunkRef = db.collection('price_snapshots').doc(date).collection('chunks').doc(`${chunkIdx}`);
    const payload = {};
    for (const n of chunk) {
      const it = items[n];
      if (it && it.min_price != null) {
        payload[n] = { p: it.min_price, q: it.quantity || 0 };
      }
    }
    await chunkRef.set({ items: payload, count: Object.keys(payload).length }, { merge: false });
    totalWritten += Object.keys(payload).length;
  }

  await ref.set({
    date,
    source: 'skinport',
    itemsCount: totalWritten,
    chunks: Math.ceil(names.length / CHUNK_SIZE),
    complete: true,
    createdAt: new Date().toISOString(),
  }, { merge: true });

  console.log(`[PriceHistory] snapshot ${date}: ${totalWritten} items in ${Math.ceil(names.length / CHUNK_SIZE)} chunks`);
  return { date, written: totalWritten };
}

// ── Leitura do histórico de uma skin específica ───────────────────────────
// Faz N reads (um por dia) — razoavelmente barato dentro do free tier do Firestore.
async function getHistoryForSkin(skinName, days = 30) {
  const db = admin.firestore();
  const result = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);

    // Procura em cada chunk até achar a skin. Como o hash é o nome completo,
    // buscamos em todos os chunks do snapshot daquele dia em paralelo.
    try {
      const chunks = await db.collection('price_snapshots').doc(date).collection('chunks').get();
      for (const chunkDoc of chunks.docs) {
        const items = chunkDoc.data()?.items || {};
        if (items[skinName]) {
          result.push({
            date,
            price_usd: items[skinName].p,
            quantity: items[skinName].q || 0,
          });
          break;
        }
      }
    } catch (e) {
      // Se não achou o snapshot daquele dia, continua
    }
  }

  return result;
}

// Classifica tendência a partir do histórico próprio (mesmo formato que analysis.js espera)
function classifyInternalTrend(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const prices = points.map(p => p.price_usd).filter(p => p > 0);
  if (prices.length < 3) return null;

  const recent = prices.slice(-7);
  const older = prices.slice(0, 7);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const pct = ((recentAvg - olderAvg) / olderAvg) * 100;

  let direction = 'stable';
  if (pct > 4) direction = 'up';
  else if (pct < -4) direction = 'down';

  return {
    direction,
    pctChange7d: Math.round(pct * 10) / 10,
    recentAvg: Math.round(recentAvg * 100) / 100,
    olderAvg: Math.round(olderAvg * 100) / 100,
    points: prices.length,
    source: 'internal_skinport',
  };
}

// ── Handler HTTP ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const path = event.path || '';

  // GET /api/price-history?name=X&days=30
  if (event.httpMethod === 'GET' && path.endsWith('/price-history')) {
    const q = event.queryStringParameters || {};
    const name = q.name;
    const days = Math.min(90, Math.max(1, parseInt(q.days, 10) || 30));
    if (!name) return json(400, { error: 'name is required' });

    const points = await getHistoryForSkin(name, days);
    const trend = classifyInternalTrend(points);
    return json(200, { name, days, count: points.length, points, trend });
  }

  // POST /api/price-history/snapshot — admin-only
  if (event.httpMethod === 'POST' && path.endsWith('/snapshot')) {
    const key = event.headers?.['x-admin-key'];
    if (!key || key !== process.env.ADMIN_API_KEY) {
      return json(401, { error: 'admin key required' });
    }
    try {
      const result = await snapshotDailyPrices();
      return json(200, result);
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  return json(405, { error: 'Method not allowed' });
};

exports.snapshotDailyPrices = snapshotDailyPrices;
exports.getHistoryForSkin = getHistoryForSkin;
exports.classifyInternalTrend = classifyInternalTrend;
