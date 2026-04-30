// ═══ Gumax — Check PIX Payment Status ═══
// Checks payment status via Mercado Pago API and updates order status

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

        // If we don't have paymentId from params, use the one from order
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
      } catch (e) {
        console.error('[CheckPix] Firestore error:', e.message);
        // Continue with payment check if Firestore fails
      }
    }

    if (!payment) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Payment not found' }) };
    }

    // Update order status if payment is approved
    if (orderId && orderData && payment.status === 'approved') {
      try {
        const admin = require('firebase-admin');
        const db = admin.firestore();

        if (orderData.status === 'pending' || orderData.status === 'processing') {
          await db.collection('orders').doc(orderId).update({
            status: 'paid',
            pixStatus: payment.status,
            paidAt: new Date().toISOString()
          });

          console.log(`[CheckPix] Order ${orderId} marked as paid`);

          // Notifica via WhatsApp (cliente + admin) — try/catch isolado pra
          // não derrubar a confirmação do pagamento se a notificação falhar.
          try {
            const wa = require('./whatsapp-notify');
            await wa.notifyOrderPaid({ ...orderData, orderId, status: 'paid' });
          } catch (e) {
            console.warn('[CheckPix] WhatsApp notify error:', e.message);
          }
        }
      } catch (e) {
        console.error('[CheckPix] Status update error:', e.message);
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
