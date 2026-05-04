// v48-push: Web Push API helpers + handlers.
// Subscriptions ficam em users/{uid}/pushSubs/{subId}.
// Triggers (handleChallenge, handleAccept, handleConfirm) chamam sendPush(uid, payload).

const admin = require('firebase-admin');
let webpush = null;
try {
  webpush = require('web-push');
} catch (e) {
  console.warn('[push] lib web-push nao instalada — push desabilitado');
}

const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contato@gumaxskins.com';

let _vapidConfigured = false;
function configureVapidOnce() {
  if (_vapidConfigured || !webpush) return _vapidConfigured;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[push] VAPID_PUBLIC ou VAPID_PRIVATE não definidos — push desabilitado');
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  _vapidConfigured = true;
  console.log('[push] VAPID configurado');
  return true;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function json(code, body) { return { statusCode: code, headers: CORS, body: JSON.stringify(body) }; }

async function getAuth(event) {
  return await require('./lobby').getAuth(event).catch(() => null);
}

// ── POST /api/push/public-key — frontend pega a public key pra subscribe ──
async function handleGetPublicKey() {
  return json(200, { publicKey: VAPID_PUBLIC, enabled: !!VAPID_PUBLIC });
}

// ── POST /api/push/subscribe ─────────────────────────────────────────────
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
async function handleSubscribe(event) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return json(400, { error: 'missing_subscription_fields' });
  }
  const db = admin.firestore();
  // ID determinístico = hash do endpoint (idempotente, mesmo device não duplica)
  const subId = require('crypto').createHash('sha1').update(sub.endpoint).digest('hex').slice(0, 16);
  await db.collection('users').doc(user.uid).collection('pushSubs').doc(subId).set({
    endpoint: sub.endpoint,
    keys: sub.keys,
    userAgent: (event.headers?.['user-agent'] || event.headers?.['User-Agent'] || '').slice(0, 200),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`[push] subscribe uid=${user.uid} subId=${subId}`);
  return json(200, { ok: true, subId });
}

// ── POST /api/push/unsubscribe ───────────────────────────────────────────
// Body: { endpoint } (pra desinscrever este device especifico)
async function handleUnsubscribe(event) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body.endpoint) return json(400, { error: 'missing_endpoint' });
  const subId = require('crypto').createHash('sha1').update(body.endpoint).digest('hex').slice(0, 16);
  await admin.firestore().collection('users').doc(user.uid)
    .collection('pushSubs').doc(subId).delete().catch(() => {});
  return json(200, { ok: true });
}

// ── POST /api/push/test ──────────────────────────────────────────────────
// Manda push de teste pro proprio user (botao "Testar notificacao")
async function handleTestPush(event) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const result = await sendPushToUser(user.uid, {
    title: '🎮 GMAX LEAGUE',
    body: 'Notificações funcionando! Bons jogos.',
    icon: '/gmax-league-logo.png',
    url: '/lobbies.html',
    tag: 'test',
  });
  return json(200, { ok: true, sent: result.sent, failed: result.failed });
}

// ── Helper: manda push pra todos pushSubs de um uid ──────────────────────
// Usado pelos triggers (challenge, accept, confirm).
// Best-effort: nunca throw, retorna {sent, failed}.
// Auto-cleanup: se subscription retorna 410 Gone, deleta o doc.
async function sendPushToUser(uid, payload) {
  if (!configureVapidOnce()) return { sent: 0, failed: 0, skipped: true };
  const db = admin.firestore();
  let sent = 0, failed = 0;
  try {
    const snap = await db.collection('users').doc(uid).collection('pushSubs').get();
    if (snap.empty) return { sent: 0, failed: 0, noSubs: true };
    const json = JSON.stringify(payload);
    await Promise.all(snap.docs.map(async (d) => {
      const data = d.data();
      const sub = { endpoint: data.endpoint, keys: data.keys };
      try {
        await webpush.sendNotification(sub, json, { TTL: 60 });
        sent++;
        d.ref.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      } catch (err) {
        failed++;
        // 404/410: subscription inválida. Cleanup.
        if (err.statusCode === 404 || err.statusCode === 410) {
          d.ref.delete().catch(() => {});
          console.log(`[push] subscription expirada uid=${uid} subId=${d.id} — removida`);
        } else {
          console.warn(`[push] erro ao enviar uid=${uid}:`, err.statusCode, err.body || err.message);
        }
      }
    }));
  } catch (e) {
    console.warn('[push] sendPushToUser falhou:', e.message);
  }
  return { sent, failed };
}

// Helper: manda pra varios uids em paralelo
async function sendPushToUsers(uids, payload) {
  const results = await Promise.all(uids.map(uid => sendPushToUser(uid, payload)));
  const totalSent = results.reduce((s, r) => s + (r.sent || 0), 0);
  const totalFailed = results.reduce((s, r) => s + (r.failed || 0), 0);
  return { totalSent, totalFailed };
}

// ── Handler HTTP exportado pro server.js wireup ──────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const path = event.path || '';
  if (path.endsWith('/public-key') && event.httpMethod === 'GET') return handleGetPublicKey();
  if (path.endsWith('/subscribe') && event.httpMethod === 'POST') return handleSubscribe(event);
  if (path.endsWith('/unsubscribe') && event.httpMethod === 'POST') return handleUnsubscribe(event);
  if (path.endsWith('/test') && event.httpMethod === 'POST') return handleTestPush(event);
  return json(404, { error: 'route_not_found' });
};

// Exporta helpers pra outros modulos (lobby.js, match.js)
exports.sendPushToUser = sendPushToUser;
exports.sendPushToUsers = sendPushToUsers;
