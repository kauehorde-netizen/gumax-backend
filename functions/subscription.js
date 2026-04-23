// ═══ Gumax — Subscription System ═══
// Gumax Pro recurring plans (Mercado Pago Preapproval API).
//
// Endpoints:
//   GET  /api/subscription/plans         → catálogo público dos 4 planos
//   GET  /api/subscription/status        → status da assinatura do usuário logado
//   POST /api/subscription/create        → cria um preapproval no MP
//   POST /api/subscription/cancel        → cancela a assinatura ativa
//   POST /api/subscription/webhook       → webhook do Mercado Pago (preapproval + payment)
//   POST /api/subscription/distribute    → cron mensal (libera 200 créditos)
//
// Modelo: assinatura dura billingCycleDays e cobra no boleto/PIX via MP.
// A cada 30 dias a função `distribute` credita 200 créditos "subscription"
// no saldo do usuário. Nunca libera tudo de uma vez — se plano é anual,
// ainda assim recebe 200/mês.
//
// Créditos de assinatura têm prioridade sobre comprados ao gastar, e
// expiram no próximo ciclo mensal (ver credits.js).

const admin = require('firebase-admin');
const { verifyIdToken } = require('./credits');

// ── Catálogo de planos ──
// ATENÇÃO: pegue esses IDs (preapproval_plan_id) no painel do Mercado Pago
// depois de criar os planos pela primeira vez (via dashboard ou /preapproval_plan).
// Por enquanto deixamos só as regras de billing.
const PLANS = {
  mensal: {
    id: 'mensal',
    name: 'Gumax Pro Mensal',
    priceBRL: 29.90,
    billingCycleDays: 30,
    creditsPerMonth: 200,
    totalMonths: 1,
    description: 'Renova todo mês. Cancele quando quiser.',
  },
  trimestral: {
    id: 'trimestral',
    name: 'Gumax Pro Trimestral',
    priceBRL: 79.90,
    billingCycleDays: 90,
    creditsPerMonth: 200,
    totalMonths: 3,
    description: 'Economize ~11% vs mensal. Renova a cada 3 meses.',
    savingsPct: 11,
  },
  semestral: {
    id: 'semestral',
    name: 'Gumax Pro Semestral',
    priceBRL: 149.90,
    billingCycleDays: 180,
    creditsPerMonth: 200,
    totalMonths: 6,
    description: 'Economize ~16% vs mensal. Renova a cada 6 meses.',
    savingsPct: 16,
  },
  anual: {
    id: 'anual',
    name: 'Gumax Pro Anual',
    priceBRL: 279.90,
    billingCycleDays: 365,
    creditsPerMonth: 200,
    totalMonths: 12,
    description: 'Economize ~22% vs mensal. Melhor custo-benefício.',
    savingsPct: 22,
    popular: true,
  },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};
function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// ── Util ──
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// ── Mercado Pago Preapproval ──
async function mpCreatePreapproval(plan, userEmail, userId, returnUrl) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) throw new Error('MP_ACCESS_TOKEN not configured');

  const body = {
    reason: plan.name,
    external_reference: `sub_${userId}_${Date.now()}`,
    payer_email: userEmail,
    back_url: returnUrl || 'https://market.gumaxskins.com/analise.html?sub=ok',
    auto_recurring: {
      frequency: plan.billingCycleDays,
      frequency_type: 'days',
      transaction_amount: plan.priceBRL,
      currency_id: 'BRL',
    },
    status: 'pending',
  };

  const resp = await fetch('https://api.mercadopago.com/preapproval', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MP_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('[Subscription] MP preapproval error:', JSON.stringify(data));
    throw new Error(data.message || 'Falha ao criar assinatura no Mercado Pago');
  }
  return data;
}

async function mpCancelPreapproval(preapprovalId) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const resp = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MP_TOKEN}` },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  return resp.ok;
}

async function mpGetPreapproval(preapprovalId) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const resp = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

// ── Firestore helpers ──
async function getActiveSubscription(uid) {
  const db = admin.firestore();
  const snap = await db.collection('subscriptions')
    .where('userId', '==', uid)
    .where('status', 'in', ['active', 'pending'])
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function saveSubscription(data) {
  const db = admin.firestore();
  const ref = data.id ? db.collection('subscriptions').doc(data.id) : db.collection('subscriptions').doc();
  const now = new Date().toISOString();
  const clean = { ...data, id: ref.id, updatedAt: now };
  if (!data.createdAt) clean.createdAt = now;
  await ref.set(clean, { merge: true });
  return clean;
}

// ── Distribuição mensal de créditos ──
// Chamado por um cron diário (ex: Scheduled Task). Para cada assinatura active
// cujo nextCreditDistribution <= hoje, libera 200 créditos de tipo
// "subscription" (que expiram no próximo ciclo) e reagenda para +30 dias.
async function distributeMonthlyCredits() {
  const db = admin.firestore();
  const { award, expireSubscriptionBucket } = require('./credits');
  const now = new Date();
  const nowIso = now.toISOString();

  const snap = await db.collection('subscriptions')
    .where('status', '==', 'active')
    .where('nextCreditDistribution', '<=', nowIso)
    .get();

  let distributed = 0;
  for (const doc of snap.docs) {
    const sub = doc.data();
    try {
      // 1) Expira créditos de assinatura NÃO consumidos do ciclo anterior
      await expireSubscriptionBucket(sub.userId);
      // 2) Libera 200 créditos novos (bucket subscription)
      await award(
        sub.userId,
        sub.creditsPerMonth || 200,
        `subscription_monthly:${sub.planType}`,
        { subscriptionId: doc.id, bucket: 'subscription' }
      );
      await doc.ref.update({
        lastCreditDistribution: nowIso,
        nextCreditDistribution: addDays(now, 30).toISOString(),
        updatedAt: nowIso,
      });
      distributed++;
    } catch (e) {
      console.error('[Subscription] distribute error for', doc.id, e.message);
    }
  }

  return { distributed, total: snap.size };
}

// ── Webhook (MP Preapproval + Payment) ──
async function handleWebhook(event) {
  const body = JSON.parse(event.body || '{}');
  const type = body.type || event.queryStringParameters?.type;
  const dataId = body.data?.id || event.queryStringParameters?.['data.id'];

  console.log('[Subscription Webhook]', type, dataId);

  if (!type || !dataId) return json(200, { received: true });

  const db = admin.firestore();

  // --- preapproval event: status mudou (authorized, cancelled, paused) ---
  if (type === 'preapproval' || type === 'subscription_preapproval') {
    const preapproval = await mpGetPreapproval(dataId);
    if (!preapproval) return json(200, { received: true, skipped: 'preapproval not found' });

    const extRef = preapproval.external_reference || '';
    const snap = await db.collection('subscriptions')
      .where('externalReference', '==', extRef)
      .limit(1)
      .get();
    if (snap.empty) return json(200, { received: true, skipped: 'no local subscription' });

    const doc = snap.docs[0];
    const sub = doc.data();
    const mpStatus = preapproval.status; // pending | authorized | paused | cancelled

    let localStatus = sub.status;
    if (mpStatus === 'authorized') localStatus = 'active';
    else if (mpStatus === 'cancelled') localStatus = 'canceled';
    else if (mpStatus === 'paused') localStatus = 'paused';

    const update = {
      status: localStatus,
      mpStatus,
      updatedAt: new Date().toISOString(),
    };

    // Quando ativa pela primeira vez: libera o primeiro mês já
    if (localStatus === 'active' && !sub.firstActivationAt) {
      const { award } = require('./credits');
      await award(
        sub.userId,
        sub.creditsPerMonth || 200,
        `subscription_first:${sub.planType}`,
        { subscriptionId: doc.id, bucket: 'subscription' }
      );
      update.firstActivationAt = new Date().toISOString();
      update.lastCreditDistribution = new Date().toISOString();
      update.nextCreditDistribution = addDays(new Date(), 30).toISOString();
    }

    await doc.ref.update(update);
    return json(200, { received: true, subscription: doc.id, status: localStatus });
  }

  // --- payment event: pode ser assinatura OU compra avulsa de créditos ---
  // (usamos UMA URL só no MP — esse webhook roteia internamente)
  if (type === 'payment') {
    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    if (!resp.ok) return json(200, { received: true });
    const pay = await resp.json();

    // Fan-out: é compra avulsa de créditos? (metadata bucket ou external_reference existe em credit_purchases)
    const isBucketPurchase = pay.metadata?.bucket === 'credit_purchase';
    const extRef = pay.external_reference;
    let isCreditPurchase = isBucketPurchase;
    if (!isCreditPurchase && extRef) {
      try {
        const purchaseDoc = await db.collection('credit_purchases').doc(extRef).get();
        if (purchaseDoc.exists) isCreditPurchase = true;
      } catch {}
    }
    if (isCreditPurchase) {
      const { handleWebhook: creditsPurchaseWebhook } = require('./credits-purchase');
      return await creditsPurchaseWebhook(event);
    }

    // Senão, processa como payment de assinatura (preapproval_id presente)
    const preapprovalId = pay.metadata?.preapproval_id || pay.preapproval_id;
    if (preapprovalId && pay.status === 'approved') {
      const snap = await db.collection('subscriptions')
        .where('mpPreapprovalId', '==', preapprovalId)
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        await doc.ref.update({
          lastPaymentAt: new Date().toISOString(),
          lastPaymentId: pay.id,
          status: 'active',
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return json(200, { received: true, payment: pay.id, status: pay.status });
  }

  return json(200, { received: true, ignored: type });
}

// ── Handler principal ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const path = (event.path || event.rawPath || '').toLowerCase();

  try {
    // GET /api/subscription/plans (público)
    if (path.includes('/plans') && event.httpMethod === 'GET') {
      return json(200, {
        plans: Object.values(PLANS).map(p => ({
          id: p.id,
          name: p.name,
          priceBRL: p.priceBRL,
          creditsPerMonth: p.creditsPerMonth,
          billingCycleDays: p.billingCycleDays,
          totalMonths: p.totalMonths,
          description: p.description,
          savingsPct: p.savingsPct || 0,
          popular: !!p.popular,
        })),
      });
    }

    // POST /api/subscription/webhook (sem auth — MP chama direto)
    if (path.includes('/webhook')) {
      return await handleWebhook(event);
    }

    // POST /api/subscription/distribute (cron admin)
    if (path.includes('/distribute')) {
      const key = event.headers?.['x-admin-key'] || event.headers?.['X-Admin-Key'];
      if (key !== process.env.ADMIN_API_KEY) return json(401, { error: 'admin key required' });
      const result = await distributeMonthlyCredits();
      return json(200, result);
    }

    // Todos os demais exigem auth
    const decoded = await verifyIdToken(event.headers);
    if (!decoded) return json(401, { error: 'Unauthorized' });
    const uid = decoded.uid;

    // GET /api/subscription/status
    if (path.includes('/status') && event.httpMethod === 'GET') {
      const sub = await getActiveSubscription(uid);
      if (!sub) return json(200, { active: false });
      const plan = PLANS[sub.planType];
      return json(200, {
        active: sub.status === 'active',
        status: sub.status,
        planType: sub.planType,
        planName: plan?.name || sub.planType,
        priceBRL: plan?.priceBRL || sub.priceBRL,
        creditsPerMonth: sub.creditsPerMonth,
        nextBillingDate: sub.nextBillingDate,
        nextCreditDistribution: sub.nextCreditDistribution,
        lastCreditDistribution: sub.lastCreditDistribution,
        startedAt: sub.firstActivationAt || sub.createdAt,
        initCheckoutUrl: sub.initCheckoutUrl || null,
      });
    }

    // POST /api/subscription/create
    if (path.includes('/create') && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { planType, returnUrl } = body;
      const plan = PLANS[planType];
      if (!plan) return json(400, { error: 'Invalid planType. Use: mensal | trimestral | semestral | anual' });

      // Se já existe uma active/pending, devolve ela em vez de criar outra
      const existing = await getActiveSubscription(uid);
      if (existing && existing.status === 'active') {
        return json(200, { existing: true, subscription: existing });
      }

      const preapproval = await mpCreatePreapproval(plan, decoded.email, uid, returnUrl);
      const now = new Date();
      const nextBilling = addDays(now, plan.billingCycleDays).toISOString();

      const sub = await saveSubscription({
        userId: uid,
        userEmail: decoded.email,
        planType: plan.id,
        status: 'pending',
        mpPreapprovalId: preapproval.id,
        externalReference: preapproval.external_reference,
        initCheckoutUrl: preapproval.init_point,
        priceBRL: plan.priceBRL,
        creditsPerMonth: plan.creditsPerMonth,
        billingCycleDays: plan.billingCycleDays,
        totalMonths: plan.totalMonths,
        nextBillingDate: nextBilling,
        nextCreditDistribution: null, // definido quando status virar active (webhook)
        lastCreditDistribution: null,
        firstActivationAt: null,
      });

      return json(200, {
        subscription: sub,
        checkoutUrl: preapproval.init_point,
        preapprovalId: preapproval.id,
      });
    }

    // POST /api/subscription/cancel
    if (path.includes('/cancel') && event.httpMethod === 'POST') {
      const sub = await getActiveSubscription(uid);
      if (!sub) return json(404, { error: 'no active subscription' });
      if (sub.mpPreapprovalId) {
        await mpCancelPreapproval(sub.mpPreapprovalId);
      }
      await admin.firestore().collection('subscriptions').doc(sub.id).update({
        status: 'canceled',
        canceledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return json(200, { canceled: true, subscriptionId: sub.id });
    }

    return json(404, { error: 'Unknown subscription endpoint' });
  } catch (e) {
    console.error('[Subscription]', e);
    return json(500, { error: e.message });
  }
};

exports.PLANS = PLANS;
exports.distributeMonthlyCredits = distributeMonthlyCredits;
