// ═══ Gumax — NOWPayments IPN Webhook ═══
// Recebe notificações da NOWPayments quando uma fatura crypto muda de
// status: waiting → confirming → confirmed → finished | partially_paid | failed | expired
//
// Quando "finished" (pagamento confirmado on-chain), marca o pedido como
// PAID em Firestore — exatamente o mesmo flow que o webhook do Mercado Pago.
//
// Doc oficial: https://nowpayments.io/api/get-webhook
// Headers que NOWPayments envia:
//   - x-nowpayments-sig: HMAC-SHA512 do body usando IPN_SECRET (sorted JSON)
//
// Env vars:
//   NOWPAYMENTS_IPN_SECRET   (ex: 3IiXGqMzZgXzjOikWH9ZWbKo8bQL147/)

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-nowpayments-sig',
};

// NOWPayments assina o body com sortedJSON(payload) usando HMAC-SHA512.
// Recomputamos e comparamos com header.
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return false; }
  // sort keys recursivamente — NOWPayments faz isso antes de assinar
  function sortKeys(obj) {
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (obj && typeof obj === 'object') {
      return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
    }
    return obj;
  }
  const sortedStr = JSON.stringify(sortKeys(parsed));
  const expected = crypto.createHmac('sha512', secret).update(sortedStr).digest('hex');
  // timing-safe compare
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  const rawBody = event.body || '';
  const signature = event.headers?.['x-nowpayments-sig'] || event.headers?.['X-Nowpayments-Sig'] || '';
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;

  // Em produção a assinatura é OBRIGATÓRIA — se faltar secret ou bater errado, rejeita.
  if (!verifySignature(rawBody, signature, secret)) {
    console.warn('[Crypto webhook] signature mismatch — rejeitado');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid signature' }) };
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid json' }) }; }

  const orderId = payload.order_id;
  const status = payload.payment_status;
  const paymentId = payload.payment_id;
  const actuallyPaid = parseFloat(payload.actually_paid) || 0;
  const priceAmount = parseFloat(payload.price_amount) || 0;
  const payCurrency = payload.pay_currency;

  console.log(`[Crypto webhook] orderId=${orderId} status=${status} paymentId=${paymentId} ${actuallyPaid} ${payCurrency}`);

  if (!orderId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ignored: 'no order_id' }) };

  // Mapeia status NOWPayments → status interno do pedido
  // 'finished' = totalmente pago e confirmado on-chain
  // 'partially_paid' = pagou menos do que deveria (segura na manual review)
  // 'failed' / 'expired' = não rolou
  let internalStatus = null;
  if (status === 'finished' || status === 'confirmed') internalStatus = 'paid';
  else if (status === 'partially_paid') internalStatus = 'partial';
  else if (status === 'failed' || status === 'expired') internalStatus = 'failed';
  // outros (waiting, confirming, sending) — só logamos, não muda estado

  if (!internalStatus) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status, mapped: null }) };
  }

  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const orderRef = db.collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) {
      console.warn(`[Crypto webhook] order ${orderId} not found`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ignored: 'order not found' }) };
    }
    const cur = snap.data();
    // Idempotência: se já está paid, não regrava (evita race com webhook duplicado).
    if (cur.status === 'paid' && internalStatus === 'paid') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, idempotent: true }) };
    }

    const update = {
      status: internalStatus,
      cryptoStatus: status,
      cryptoPaymentId: paymentId,
      cryptoActuallyPaid: actuallyPaid,
      cryptoPayCurrency: payCurrency,
    };
    if (internalStatus === 'paid') update.paidAt = new Date().toISOString();
    await orderRef.update(update);
    console.log(`[Crypto webhook] order ${orderId} updated → ${internalStatus}`);

    // Notifica WhatsApp se virou paid (best effort)
    if (internalStatus === 'paid') {
      try {
        const wa = require('./whatsapp-notify');
        await wa.notifyOrderPaid({ ...cur, ...update, orderId });
      } catch (e) {
        console.warn('[Crypto webhook] WA notify err:', e.message);
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, orderId, status: internalStatus }) };
  } catch (e) {
    console.error('[Crypto webhook] firestore error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
