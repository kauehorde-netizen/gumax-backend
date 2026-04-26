// ═══ Gumax — Credits System ═══
// Endpoints:
//   GET  /api/credits/balance?uid=X     → { balance, subscriptionBalance, purchasedBalance, ... }
//   POST /api/credits/grant-initial     → grants 10 credits to new user (once)
//   POST /api/credits/consume           → debits credits atomically, logs tx
//   POST /api/credits/award             → admin-only grant (e.g. refund, promo)
//
// Modelo de saldo (dois baldes):
//   subscriptionBalance → créditos do plano, EXPIRAM no próximo ciclo
//   purchasedBalance    → créditos comprados/refund/promos, NUNCA expiram
//
// Prioridade ao gastar: subscription > purchased (quem tem plano queima o
// bucket mensal antes de tocar nos créditos comprados).
//
// Security model:
//   - Todas as escritas via Firebase Admin SDK (bypassa regras Firestore).
//   - Clientes mandam ID token do Firebase no header Authorization.
//   - /award requer ADMIN_API_KEY.

const admin = require('firebase-admin');

const INITIAL_CREDITS = parseInt(process.env.INITIAL_CREDITS || '10', 10);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

async function verifyIdToken(headers) {
  const auth = headers?.authorization || headers?.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7);
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (e) {
    console.log('[Credits] ID token verify failed:', e.message);
    return null;
  }
}

function requireAdmin(headers) {
  const k = headers?.['x-admin-key'] || headers?.['X-Admin-Key'];
  return k && k === process.env.ADMIN_API_KEY;
}

// Nova versão: valida via Firebase ID token + ADMIN_EMAILS ou ADMIN_UIDS env.
// Aceita admin via email (Google login) OU via UID (Steam login não tem email).
// Também olha users/{uid}.isAdmin === true como fallback.
async function requireAdminToken(headers) {
  const decoded = await verifyIdToken(headers);
  if (!decoded) return null;
  const email = (decoded.email || '').toLowerCase();
  const uid = decoded.uid || '';
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const adminUids = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (email && adminEmails.includes(email)) return decoded;
  if (uid && adminUids.includes(uid)) return decoded;
  // Fallback: olha flag no Firestore (admin pode marcar via console)
  try {
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (userDoc.exists && userDoc.data().isAdmin === true) return decoded;
  } catch (e) {}
  return null;
}

// Garante shape padrão num doc (migra docs legados que só tinham "balance")
function normalize(data) {
  const sub = typeof data.subscriptionBalance === 'number' ? data.subscriptionBalance : 0;
  const pur = typeof data.purchasedBalance === 'number'
    ? data.purchasedBalance
    : Math.max(0, (data.balance || 0) - sub); // migração: tudo vira "purchased"
  return {
    balance: sub + pur,
    subscriptionBalance: sub,
    purchasedBalance: pur,
    grantedInitial: !!data.grantedInitial,
    lifetime: data.lifetime || 0,
    purchased: data.purchased || 0,
    createdAt: data.createdAt,
    lastUpdated: data.lastUpdated,
    email: data.email || null,
  };
}

// ---------------- handlers ----------------

async function getBalance(uid) {
  const db = admin.firestore();

  // VIP: créditos ilimitados (admins, Gu, influencers liberados pelo admin).
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists && userDoc.data().unlimitedCredits === true) {
      return {
        balance: 999999, subscriptionBalance: 0, purchasedBalance: 999999,
        grantedInitial: true, lifetime: 0, purchased: 0,
        unlimited: true,
      };
    }
  } catch (e) {
    console.warn('[credits.getBalance] VIP check failed:', e.message);
  }

  const ref = db.collection('credits').doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    return {
      balance: 0, subscriptionBalance: 0, purchasedBalance: 0,
      grantedInitial: false, lifetime: 0, purchased: 0,
    };
  }
  return normalize(doc.data());
}

async function grantInitial(uid, email) {
  const db = admin.firestore();
  const ref = db.collection('credits').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? normalize(snap.data()) : null;

    if (cur && cur.grantedInitial) {
      return { granted: false, balance: cur.balance };
    }

    const now = new Date().toISOString();
    const newPurchased = (cur?.purchasedBalance || 0) + INITIAL_CREDITS;
    const newSub = cur?.subscriptionBalance || 0;

    tx.set(ref, {
      uid,
      email: email || null,
      balance: newPurchased + newSub,
      subscriptionBalance: newSub,
      purchasedBalance: newPurchased,
      grantedInitial: true,
      lifetime: (cur?.lifetime || 0) + INITIAL_CREDITS,
      purchased: cur?.purchased || 0,
      createdAt: cur?.createdAt || now,
      lastUpdated: now,
    }, { merge: true });

    const txRef = db.collection('credit_transactions').doc();
    tx.set(txRef, {
      uid,
      type: 'initial_grant',
      amount: INITIAL_CREDITS,
      bucket: 'purchased', // crédito inicial vai pro balde sem expiração
      balanceAfter: newPurchased + newSub,
      reason: 'Initial signup bonus',
      createdAt: now,
    });

    return { granted: true, balance: newPurchased + newSub, amount: INITIAL_CREDITS };
  });
}

/**
 * Debita créditos atomicamente com prioridade:
 *   1. subscriptionBalance (expira todo mês — queima primeiro)
 *   2. purchasedBalance    (nunca expira)
 * Retorna 402-like { ok: false, reason: 'insufficient_credits' } se não cobrir.
 */
async function consume(uid, amount, reason, meta = {}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be positive integer');
  }

  const db = admin.firestore();

  // ── VIP: usuários com flag unlimitedCredits=true (admins, Gu, influencers
  //    que ele liberou) NÃO consomem nada. Útil pra teste e cortesia.
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists && userDoc.data().unlimitedCredits === true) {
      // Loga a "consumo VIP" no histórico pra o Gu ver quem usou e quanto
      await db.collection('credit_transactions').add({
        uid,
        type: 'consume_vip',
        amount: 0,
        wouldHaveCost: amount,
        balanceAfter: 999999,
        reason: `VIP: ${reason}`,
        meta,
        createdAt: new Date().toISOString(),
      });
      return { ok: true, balance: 999999, consumed: 0, vip: true };
    }
  } catch (e) {
    console.warn('[credits.consume] VIP check failed (continuing normal flow):', e.message);
  }

  const ref = db.collection('credits').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? normalize(snap.data()) : normalize({});
    const total = cur.subscriptionBalance + cur.purchasedBalance;

    if (total < amount) {
      return { ok: false, reason: 'insufficient_credits', balance: total, needed: amount };
    }

    // Priorização: queima subscription primeiro
    const fromSub = Math.min(cur.subscriptionBalance, amount);
    const fromPur = amount - fromSub;
    const newSub = cur.subscriptionBalance - fromSub;
    const newPur = cur.purchasedBalance - fromPur;
    const now = new Date().toISOString();

    tx.set(ref, {
      balance: newSub + newPur,
      subscriptionBalance: newSub,
      purchasedBalance: newPur,
      lastUpdated: now,
    }, { merge: true });

    const txRef = db.collection('credit_transactions').doc();
    tx.set(txRef, {
      uid,
      type: 'consume',
      amount: -amount,
      fromSubscription: fromSub,
      fromPurchased: fromPur,
      balanceAfter: newSub + newPur,
      reason,
      meta,
      createdAt: now,
    });

    return { ok: true, balance: newSub + newPur, consumed: amount, fromSubscription: fromSub, fromPurchased: fromPur };
  });
}

/**
 * Award: credita no balde certo baseado em meta.bucket ou no reason.
 *   bucket: 'subscription' | 'purchased' (default: infere do reason)
 *   - reason começando com 'subscription' → bucket 'subscription'
 *   - reason começando com 'purchase'     → bucket 'purchased' + incrementa "purchased" counter
 *   - default                              → bucket 'purchased'
 */
async function award(uid, amount, reason, meta = {}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be positive integer');
  }

  const bucket = meta.bucket
    || (reason.startsWith('subscription') ? 'subscription'
        : reason.startsWith('purchase') ? 'purchased'
        : 'purchased');

  const db = admin.firestore();
  const ref = db.collection('credits').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? normalize(snap.data()) : normalize({});
    const now = new Date().toISOString();

    const update = {
      uid,
      lifetime: cur.lifetime + amount,
      lastUpdated: now,
    };
    if (!cur.createdAt) update.createdAt = now;

    if (bucket === 'subscription') {
      update.subscriptionBalance = cur.subscriptionBalance + amount;
      update.purchasedBalance = cur.purchasedBalance;
    } else {
      update.purchasedBalance = cur.purchasedBalance + amount;
      update.subscriptionBalance = cur.subscriptionBalance;
      if (reason.startsWith('purchase')) update.purchased = (cur.purchased || 0) + amount;
    }
    update.balance = update.subscriptionBalance + update.purchasedBalance;

    tx.set(ref, update, { merge: true });

    const txRef = db.collection('credit_transactions').doc();
    tx.set(txRef, {
      uid,
      type: reason.startsWith('purchase') ? 'purchase'
           : reason.startsWith('subscription') ? 'subscription_credit'
           : 'grant',
      amount,
      bucket,
      balanceAfter: update.balance,
      reason,
      meta,
      createdAt: now,
    });

    return { ok: true, balance: update.balance, awarded: amount, bucket };
  });
}

/**
 * Zera o balde de subscription (expiração mensal) e registra no log.
 * Chamado ANTES de creditar novo mês no distributeMonthlyCredits.
 */
async function expireSubscriptionBucket(uid) {
  const db = admin.firestore();
  const ref = db.collection('credits').doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { expired: 0 };
    const cur = normalize(snap.data());
    if (cur.subscriptionBalance <= 0) return { expired: 0 };

    const now = new Date().toISOString();
    tx.set(ref, {
      subscriptionBalance: 0,
      balance: cur.purchasedBalance,
      lastUpdated: now,
    }, { merge: true });

    const txRef = db.collection('credit_transactions').doc();
    tx.set(txRef, {
      uid,
      type: 'expire',
      amount: -cur.subscriptionBalance,
      bucket: 'subscription',
      balanceAfter: cur.purchasedBalance,
      reason: 'subscription_monthly_expiration',
      createdAt: now,
    });

    return { expired: cur.subscriptionBalance };
  });
}

// ---------------- handler entry ----------------

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const path = (event.path || event.rawPath || '').toLowerCase();
  const headers = event.headers || {};

  try {
    // --- GET /api/credits/balance ---
    if (event.httpMethod === 'GET' && path.includes('/balance')) {
      let uid = event.queryStringParameters?.uid;
      if (!uid) {
        const decoded = await verifyIdToken(headers);
        if (!decoded) return json(401, { error: 'Unauthorized' });
        uid = decoded.uid;
      }
      const data = await getBalance(uid);
      return json(200, data);
    }

    // --- POST ---
    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    const body = JSON.parse(event.body || '{}');

    if (path.includes('/grant-initial')) {
      const decoded = await verifyIdToken(headers);
      if (!decoded) return json(401, { error: 'Unauthorized' });
      const result = await grantInitial(decoded.uid, decoded.email);
      return json(200, result);
    }

    if (path.includes('/consume')) {
      const decoded = await verifyIdToken(headers);
      if (!decoded) return json(401, { error: 'Unauthorized' });
      const { amount, reason, meta } = body;
      if (!amount || !reason) {
        return json(400, { error: 'amount and reason are required' });
      }
      const result = await consume(decoded.uid, amount, reason, meta || {});
      if (!result.ok) return json(402, result);
      return json(200, result);
    }

    if (path.includes('/award')) {
      if (!requireAdmin(headers)) return json(401, { error: 'admin key required' });
      const { uid, amount, reason, meta } = body;
      if (!uid || !amount || !reason) {
        return json(400, { error: 'uid, amount, reason are required' });
      }
      const result = await award(uid, amount, reason, meta || {});
      return json(200, result);
    }

    // ── Admin: dar créditos manualmente pra um cliente específico (influencer, brinde) ──
    // POST /api/credits/admin/grant { uid, amount, reason }
    if (path.includes('/admin/grant')) {
      const adminUser = await requireAdminToken(headers);
      if (!adminUser) return json(401, { error: 'admin only' });
      const { uid, amount, reason } = body;
      if (!uid || !Number.isInteger(amount) || amount <= 0) {
        return json(400, { error: 'uid and positive integer amount required' });
      }
      const result = await award(uid, amount, reason || 'admin_grant', {
        bucket: 'purchased',
        grantedBy: adminUser.email,
      });
      return json(200, result);
    }

    // ── Admin: ativar/desativar créditos ilimitados (VIP) num cliente ──
    // POST /api/credits/admin/set-vip { uid, unlimited: true|false }
    if (path.includes('/admin/set-vip')) {
      const adminUser = await requireAdminToken(headers);
      if (!adminUser) return json(401, { error: 'admin only' });
      const { uid, unlimited } = body;
      if (!uid || typeof unlimited !== 'boolean') {
        return json(400, { error: 'uid and boolean unlimited required' });
      }
      const db = admin.firestore();
      await db.collection('users').doc(uid).set({
        unlimitedCredits: unlimited,
        unlimitedCreditsBy: adminUser.email,
        unlimitedCreditsAt: new Date().toISOString(),
      }, { merge: true });
      return json(200, { ok: true, uid, unlimited });
    }

    return json(404, { error: 'Unknown credits endpoint' });
  } catch (e) {
    console.error('[Credits]', e);
    return json(500, { error: e.message });
  }
};

// Exports para outros módulos reutilizarem (analysis.js, subscription.js, credits-purchase.js)
exports.getBalance = getBalance;
exports.consume = consume;
exports.award = award;
exports.grantInitial = grantInitial;
exports.expireSubscriptionBucket = expireSubscriptionBucket;
exports.verifyIdToken = verifyIdToken;
exports.INITIAL_CREDITS = INITIAL_CREDITS;
