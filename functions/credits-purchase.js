// ═══ Gumax — Credit Package Purchase (PIX one-shot) ═══
// Endpoints:
//   GET  /api/credits/packages         → catálogo público
//   POST /api/credits/purchase         → cria cobrança PIX de um pacote
//   POST /api/credits/purchase/webhook → MP chama quando pagamento muda de status
//
// Pacotes avulsos (créditos que NUNCA expiram, só somam no saldo).

const admin = require('firebase-admin');
const { verifyIdToken, award } = require('./credits');

const PACKAGES = {
  p50:  { id: 'p50',  credits: 50,   priceBRL: 9.90,  description: 'Teste rápido' },
  p150: { id: 'p150', credits: 150,  priceBRL: 24.90, description: 'Mais popular', popular: true },
  p400: { id: 'p400', credits: 400,  priceBRL: 49.90, description: 'Melhor custo-benefício' },
  p1000:{ id: 'p1000',credits: 1000, priceBRL: 99.90, description: 'Power user' },
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

// ── Cria pagamento PIX no Mercado Pago ──
async function createPixForPackage(pkg, userEmail, purchaseId) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) throw new Error('MP_ACCESS_TOKEN not configured');

  const body = {
    transaction_amount: pkg.priceBRL,
    description: `Gumax Skins - ${pkg.credits} créditos`,
    payment_method_id: 'pix',
    payer: { email: userEmail, first_name: 'Gumax User' },
    external_reference: purchaseId,
    metadata: { purchaseId, bucket: 'credit_purchase', credits: pkg.credits, packageId: pkg.id },
  };

  const resp = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MP_TOKEN}`,
      'X-Idempotency-Key': `${purchaseId}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('[CreditsPurchase] MP error:', JSON.stringify(data));
    throw new Error(data.message || 'Falha ao criar PIX');
  }
  const tx = data.point_of_interaction?.transaction_data;
  return {
    paymentId: data.id,
    status: data.status,
    qrCode: tx?.qr_code || null,
    qrCodeBase64: tx?.qr_code_base64 || null,
    copyPaste: tx?.qr_code || null,
    expiresAt: data.date_of_expiration || null,
  };
}

async function handleWebhook(event) {
  const body = JSON.parse(event.body || '{}');
  const type = body.type || event.queryStringParameters?.type;
  const dataId = body.data?.id || event.queryStringParameters?.['data.id'];
  if (type !== 'payment' || !dataId) return json(200, { received: true });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` },
  });
  if (!resp.ok) return json(200, { received: true });
  const pay = await resp.json();

  const purchaseId = pay.external_reference || pay.metadata?.purchaseId;
  if (!purchaseId) return json(200, { received: true, skipped: 'no purchaseId' });

  const db = admin.firestore();
  const ref = db.collection('credit_purchases').doc(purchaseId);
  const doc = await ref.get();
  if (!doc.exists) return json(200, { received: true, skipped: 'unknown purchase' });
  const purchase = doc.data();

  // Idempotente: se já foi creditado, nem toca
  if (purchase.status === 'paid' && purchase.creditedAt) {
    return json(200, { received: true, already: true });
  }

  if (pay.status === 'approved') {
    await award(purchase.uid, purchase.credits, `purchase:${purchase.packageId}`, {
      purchaseId, paymentId: pay.id, bucket: 'purchased',
    });
    await ref.update({
      status: 'paid',
      paidAt: new Date().toISOString(),
      creditedAt: new Date().toISOString(),
      paymentStatus: pay.status,
    });
    return json(200, { received: true, credited: purchase.credits });
  }

  // Falha / cancelamento
  if (pay.status === 'rejected' || pay.status === 'cancelled') {
    await ref.update({
      status: pay.status === 'rejected' ? 'failed' : 'canceled',
      paymentStatus: pay.status,
      updatedAt: new Date().toISOString(),
    });
  }
  return json(200, { received: true, status: pay.status });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const path = (event.path || event.rawPath || '').toLowerCase();

  try {
    // GET /api/credits/packages
    if (path.includes('/packages') && event.httpMethod === 'GET') {
      return json(200, { packages: Object.values(PACKAGES) });
    }

    // POST /api/credits/purchase/webhook
    if (path.includes('/webhook')) {
      return await handleWebhook(event);
    }

    // POST /api/credits/purchase
    if (path.includes('/purchase') && event.httpMethod === 'POST') {
      const decoded = await verifyIdToken(event.headers);
      if (!decoded) return json(401, { error: 'Unauthorized' });

      const body = JSON.parse(event.body || '{}');
      const pkg = PACKAGES[body.packageId];
      if (!pkg) return json(400, { error: 'Invalid packageId' });

      const db = admin.firestore();
      const purchaseRef = db.collection('credit_purchases').doc();
      const purchaseId = purchaseRef.id;

      const pix = await createPixForPackage(pkg, decoded.email, purchaseId);

      await purchaseRef.set({
        id: purchaseId,
        uid: decoded.uid,
        email: decoded.email,
        packageId: pkg.id,
        credits: pkg.credits,
        priceBRL: pkg.priceBRL,
        status: 'pending',
        paymentId: pix.paymentId,
        paymentStatus: pix.status,
        createdAt: new Date().toISOString(),
      });

      return json(200, {
        purchaseId,
        credits: pkg.credits,
        priceBRL: pkg.priceBRL,
        paymentId: pix.paymentId,
        qrCode: pix.qrCode,
        qrCodeBase64: pix.qrCodeBase64,
        copyPaste: pix.copyPaste,
        expiresAt: pix.expiresAt,
      });
    }

    return json(404, { error: 'Unknown purchase endpoint' });
  } catch (e) {
    console.error('[CreditsPurchase]', e);
    return json(500, { error: e.message });
  }
};

exports.PACKAGES = PACKAGES;
