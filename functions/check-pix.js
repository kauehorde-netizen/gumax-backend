// ═══ Gumax — Check PIX/Card Payment Status ═══
// Checks payment status via Mercado Pago API and updates order status.
// Funciona pra PIX (via pixPaymentId direto) E pra Cartão Checkout Pro
// (consulta merchant_orders pela preferenceId — Checkout Pro não tem
// paymentId direto, fica embutido em merchant_orders).

// Helper: consulta Checkout Pro Card pela preferenceId.
// Retorna { status, payment } onde status pode ser 'approved', 'pending', etc.
async function checkCheckoutProByPreference(preferenceId, MP_TOKEN) {
  // GET /merchant_orders/search?preference_id=XXX
  const r = await fetch(`https://api.mercadopago.com/merchant_orders/search?preference_id=${encodeURIComponent(preferenceId)}`, {
    headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`MP merchant_orders failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const orders = data.elements || [];
  // Procura o merchant_order com status diferente de 'opened' (já tem pagamento)
  // ou pega o primeiro com payments[] não vazio.
  let approvedPayment = null;
  let lastPayment = null;
  for (const mo of orders) {
    for (const p of (mo.payments || [])) {
      lastPayment = p;
      if (p.status === 'approved') { approvedPayment = p; break; }
    }
    if (approvedPayment) break;
  }
  if (approvedPayment) {
    return { status: 'approved', payment: approvedPayment, source: 'checkout_pro' };
  }
  if (lastPayment) {
    return { status: lastPayment.status, payment: lastPayment, source: 'checkout_pro' };
  }
  return { status: 'pending', payment: null, source: 'checkout_pro' };
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: H, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'MP_ACCESS_TOKEN not configured' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { paymentId, orderId } = body;

    if (!paymentId && !orderId) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing paymentId or orderId' }) };
    }

    // Fetch payment status from Mercado Pago
    let payment = null;

    if (paymentId) {
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
      });

      const data = await response.json();

      if (!response.ok) {
        return { statusCode: response.status, headers: H, body: JSON.stringify({ error: data.message || 'Error fetching payment' }) };
      }

      payment = data;
    }

    // If we have orderId, get payment info from Firestore
    let orderData = null;
    if (orderId) {
      try {
        const admin = require('firebase-admin');
        const db = admin.firestore();
        const orderDoc = await db.collection('orders').doc(orderId).get();

        if (!orderDoc.exists) {
          return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Order not found' }) };
        }

        orderData = orderDoc.data();

        // PIX path — paymentId direto na order
        if (!paymentId && orderData.pixPaymentId) {
          const response = await fetch(`https://api.mercadopago.com/v1/payments/${orderData.pixPaymentId}`, {
            headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
          });
          const data = await response.json();
          if (!response.ok) {
            return { statusCode: response.status, headers: H, body: JSON.stringify({ error: data.message || 'Error fetching payment' }) };
          }
          payment = data;
        }

        // Checkout Pro Card path — não tem paymentId direto, consulta merchant_orders
        // pela preferenceId. Esse caminho é a CHAVE pra admin saber se cliente
        // pagou no cartão (porque o webhook pode não ter chegado).
        if (!payment && !paymentId && orderData.preferenceId) {
          try {
            const result = await checkCheckoutProByPreference(orderData.preferenceId, MP_TOKEN);
            if (result.payment) {
              payment = result.payment;
            } else {
              // Sem pagamento ainda — retorna status 'pending' explícito
              payment = { id: null, status: result.status, _source: 'checkout_pro_no_payment' };
            }
          } catch (e) {
            console.error('[CheckPayment] Checkout Pro lookup error:', e.message);
            return { statusCode: 502, headers: H, body: JSON.stringify({ error: 'MP Checkout Pro error: ' + e.message }) };
          }
        }
      } catch (e) {
        console.error('[CheckPix] Firestore error:', e.message);
        // Continue with payment check if Firestore fails
      }
    }

    if (!payment) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Payment not found' }) };
    }

    // Update order status if payment is approved (works for both PIX and Card Checkout Pro)
    if (orderId && orderData && payment.status === 'approved') {
      try {
        const admin = require('firebase-admin');
        const db = admin.firestore();

        if (orderData.status === 'pending' || orderData.status === 'processing') {
          const update = {
            status: 'paid',
            paidAt: new Date().toISOString(),
          };
          // Marca o campo certo dependendo do método (PIX vs Card)
          if (orderData.pixPaymentId) update.pixStatus = payment.status;
          if (orderData.preferenceId) update.cardStatus = payment.status;
          if (payment.id) update.mpPaymentId = String(payment.id);

          await db.collection('orders').doc(orderId).update(update);

          console.log(`[CheckPayment] Order ${orderId} marked as paid (method=${orderData.paymentMethod || 'pix'})`);

          // Notifica via WhatsApp (cliente + admin) — try/catch isolado pra
          // não derrubar a confirmação do pagamento se a notificação falhar.
          try {
            const wa = require('./whatsapp-notify');
            await wa.notifyOrderPaid({ ...orderData, orderId, status: 'paid' });
          } catch (e) {
            console.warn('[CheckPayment] WhatsApp notify error:', e.message);
          }
        }
      } catch (e) {
        console.error('[CheckPayment] Status update error:', e.message);
        // Don't fail response if update fails
      }
    }

    // Return payment and order status
    const response = {
      paymentId: payment.id,
      status: payment.status,
      statusDetail: payment.status_detail,
      transactionAmount: payment.transaction_amount,
      orderId: orderId || null,
      orderStatus: orderData?.status || null,
      description: payment.description || '',
      createdAt: payment.date_created || null,
      approvedAt: payment.date_approved || null
    };

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify(response)
    };

  } catch (err) {
    console.error('[CheckPix] Error:', err.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Internal error: ' + err.message }) };
  }
};
