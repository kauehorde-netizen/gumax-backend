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

// ── Checkout Pro (cartão de crédito/débito + outros métodos) ──
// Cria uma "preference" no Mercado Pago que gera URL hospedada
// pelo MP (init_point). Usuário é redirecionado pra essa URL,
// preenche cartão lá (PCI-compliant), e MP redireciona de volta.
//
// Vantagem: zero código de cartão no frontend, MP cuida de
// validação, 3DS, fraude, etc.
async function createCheckoutProPreference(amount, orderId, items, user, returnBaseUrl) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) throw new Error('MP_ACCESS_TOKEN not configured');

  // Items do MP exigem unit_price > 0; se total for muito baixo (< R$ 1)
  // o MP pode rejeitar. Fallback: cria 1 item agregado.
  const mpItems = items.length === 1
    ? [{
        title: items[0].name || 'Skin Gumax',
        description: items[0].name || 'Skin CS2',
        quantity: items[0].qty || 1,
        unit_price: rd(items[0].price || amount),
        currency_id: 'BRL',
      }]
    : [{
        title: `Gumax Skins - Pedido ${orderId}`,
        description: `${items.length} skins`,
        quantity: 1,
        unit_price: rd(amount),
        currency_id: 'BRL',
      }];

  const preference = {
    items: mpItems,
    payer: {
      email: user.email,
      name: user.name || 'Gumax Customer',
    },
    external_reference: orderId,
    metadata: { orderId },
    // URLs de retorno após pagamento (configurar dominio publico)
    back_urls: {
      success: `${returnBaseUrl}/index.html?order=${orderId}&status=success`,
      failure: `${returnBaseUrl}/index.html?order=${orderId}&status=failure`,
      pending: `${returnBaseUrl}/index.html?order=${orderId}&status=pending`,
    },
    auto_return: 'approved',
    // Remove métodos pra deixar só cartão (PIX já tem flow próprio)
    payment_methods: {
      excluded_payment_types: [
        { id: 'ticket' },          // boleto
        { id: 'bank_transfer' },   // PIX (já temos flow direto)
      ],
      installments: 12,
    },
    statement_descriptor: 'GUMAX SKINS',
  };

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MP_TOKEN}`,
    },
    body: JSON.stringify(preference),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[CreateOrder] MP Preference error:', JSON.stringify(data));
    throw new Error(data.message || 'Failed to create checkout preference');
  }

  return {
    preferenceId: data.id,
    initPoint: data.init_point,        // URL produção
    sandboxInitPoint: data.sandbox_init_point, // URL teste
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
    const { items, user, paymentMethod = 'pix' } = body;

    // Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Items required' }) };
    }

    if (!user || !user.steamId || !user.email) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'User with steamId and email required' }) };
    }

    if (!['pix', 'card'].includes(paymentMethod)) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'paymentMethod must be pix or card' }) };
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

    // ── Roteia por método de pagamento ──
    let payment;
    if (paymentMethod === 'pix') {
      try {
        payment = await createPixPayment(total, orderId, user.email);
      } catch (e) {
        console.error('[CreateOrder] PIX error:', e.message);
        return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Failed to create payment: ' + e.message }) };
      }
    } else if (paymentMethod === 'card') {
      // URL pública do site pra MP redirecionar de volta após pagamento
      const returnBaseUrl = process.env.PUBLIC_SITE_URL || 'https://market.gumaxskins.com';
      try {
        payment = await createCheckoutProPreference(total, orderId, items, user, returnBaseUrl);
      } catch (e) {
        console.error('[CreateOrder] Card preference error:', e.message);
        return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Failed to create card checkout: ' + e.message }) };
      }
    }

    // Save order to Firestore
    try {
      const admin = require('firebase-admin');
      const db = admin.firestore();

      const orderData = {
        orderId: orderId,
        items: items,
        paymentMethod,
        user: {
          steamId: user.steamId,
          name: user.name || 'Anonymous',
          email: user.email,
          whatsapp: user.whatsapp || '',
          tradeLink: user.tradeLink || ''
        },
        total: total,
        // PIX fields
        pixPaymentId: payment.paymentId || null,
        pixStatus: payment.status || null,
        // Card / Checkout Pro fields
        preferenceId: payment.preferenceId || null,
        initPoint: payment.initPoint || null,
        status: 'pending', // pending, paid, processing, shipped, delivered
        createdAt: new Date().toISOString(),
        paidAt: null,
        deliveredAt: null,
        notes: ''
      };

      await db.collection('orders').doc(orderId).set(orderData);

      // Also add to user's orders list (pelo Firebase UID, não steamId — UID é a chave do users/)
      const userRef = db.collection('users').doc(user.uid || user.steamId);
      await userRef.update({
        orders: admin.firestore.FieldValue.arrayUnion(orderId)
      }).catch(() => {
        // User doesn't exist yet, will be created on login
      });

      console.log(`[CreateOrder] Created ${paymentMethod} order: ${orderId} - R$ ${total}`);
    } catch (e) {
      console.error('[CreateOrder] Firestore error:', e.message);
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Failed to save order: ' + e.message }) };
    }

    // Return response — campos diferentes por método
    const responseBody = {
      success: true,
      orderId,
      total,
      paymentMethod,
    };
    if (paymentMethod === 'pix') {
      Object.assign(responseBody, {
        pixQrCode: payment.qrCode,
        pixQrCodeBase64: payment.qrCodeBase64,
        pixCopyPaste: payment.copyPaste,
        expiresAt: payment.expiresAt,
        paymentId: payment.paymentId,
        status: payment.status,
      });
    } else {
      Object.assign(responseBody, {
        preferenceId: payment.preferenceId,
        initPoint: payment.initPoint,             // URL pra redirecionar
        sandboxInitPoint: payment.sandboxInitPoint,
      });
    }

    return { statusCode: 200, headers: H, body: JSON.stringify(responseBody) };

  } catch (e) {
    console.error('[CreateOrder] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
