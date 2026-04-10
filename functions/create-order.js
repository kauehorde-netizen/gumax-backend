// ═══ Gumax — Create Order Endpoint ═══
// Creates order in Firestore + generates PIX payment via Mercado Pago

const https = require('https');

function httpPost(url, postData, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(postData);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = https.request(options, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve({ status: r.statusCode, body }));
      r.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function generateOrderId() {
  return 'ORD_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function rd(val) {
  return Math.round(val * 100) / 100;
}

async function createPixPayment(amount, orderId, email) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) {
    throw new Error('MP_ACCESS_TOKEN not configured');
  }

  const payment = {
    transaction_amount: rd(amount),
    description: `Gumax Skins - Pedido ${orderId}`,
    payment_method_id: 'pix',
    payer: {
      email: email,
      first_name: 'Gumax Customer'
    },
    metadata: {
      orderId: orderId
    }
  };

  const response = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MP_TOKEN}`,
      'X-Idempotency-Key': `${orderId}-${Date.now()}`
    },
    body: JSON.stringify(payment)
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[CreateOrder] MP Error:', JSON.stringify(data));
    throw new Error(data.message || 'Failed to create PIX payment');
  }

  const txData = data.point_of_interaction?.transaction_data;

  return {
    paymentId: data.id,
    status: data.status,
    qrCode: txData?.qr_code || null,
    qrCodeBase64: txData?.qr_code_base64 || null,
    copyPaste: txData?.qr_code || null,
    expiresAt: data.date_of_expiration || null
  };
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: H, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { items, user } = body;

    // Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Items required' }) };
    }

    if (!user || !user.steamId || !user.email) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'User with steamId and email required' }) };
    }

    // Calculate total
    let total = 0;
    for (const item of items) {
      if (!item.price || !item.qty) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Each item must have price and qty' }) };
      }
      total += item.price * item.qty;
    }

    total = rd(total);

    if (total <= 0) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Order total must be positive' }) };
    }

    // Generate order ID
    const orderId = generateOrderId();

    // Create PIX payment
    let pixPayment;
    try {
      pixPayment = await createPixPayment(total, orderId, user.email);
    } catch (e) {
      console.error('[CreateOrder] PIX error:', e.message);
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Failed to create payment: ' + e.message }) };
    }

    // Save order to Firestore
    try {
      const admin = require('firebase-admin');
      const db = admin.firestore();

      const orderData = {
        orderId: orderId,
        items: items,
        user: {
          steamId: user.steamId,
          name: user.name || 'Anonymous',
          email: user.email,
          whatsapp: user.whatsapp || '',
          tradeLink: user.tradeLink || ''
        },
        total: total,
        pixPaymentId: pixPayment.paymentId,
        pixStatus: pixPayment.status,
        status: 'pending', // pending, paid, processing, shipped, delivered
        createdAt: new Date().toISOString(),
        paidAt: null,
        deliveredAt: null,
        notes: ''
      };

      await db.collection('orders').doc(orderId).set(orderData);

      // Also add to user's orders list
      const userRef = db.collection('users').doc(user.steamId);
      await userRef.update({
        orders: admin.firestore.FieldValue.arrayUnion(orderId)
      }).catch(() => {
        // User doesn't exist yet, will be created on login
      });

      console.log(`[CreateOrder] Created order: ${orderId} - Total: R$ ${total}`);
    } catch (e) {
      console.error('[CreateOrder] Firestore error:', e.message);
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Failed to save order: ' + e.message }) };
    }

    // Return response
    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        success: true,
        orderId: orderId,
        total: total,
        pixQrCode: pixPayment.qrCode,
        pixQrCodeBase64: pixPayment.qrCodeBase64,
        pixCopyPaste: pixPayment.copyPaste,
        expiresAt: pixPayment.expiresAt,
        status: pixPayment.status
      })
    };

  } catch (e) {
    console.error('[CreateOrder] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
