// ═══ Gumax — Admin Endpoints ═══
// Manages inventory, margins, and orders
// Requires ADMIN_API_KEY authentication

function verifyAdminKey(headers) {
  const authHeader = headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  return token === process.env.ADMIN_API_KEY;
}

function rd(val) {
  return Math.round(val * 100) / 100;
}

async function getFirestore() {
  try {
    const admin = require('firebase-admin');
    return admin.firestore();
  } catch (e) {
    throw new Error('Firebase not initialized');
  }
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: H, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'POST only' }) };
  }

  // Verify admin key
  if (!verifyAdminKey(event.headers)) {
    return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const action = event.path?.split('/').pop() || body.action;

    const db = await getFirestore();

    // ═══ UPDATE MARGINS ═══
    if (action === 'update-margins') {
      const { margin, categoryMargins } = body;

      if (typeof margin !== 'number' || margin < 0 || margin > 100) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'margin must be 0-100' }) };
      }

      const updateData = { margin };

      if (categoryMargins && typeof categoryMargins === 'object') {
        updateData.categoryMargins = categoryMargins;
      }

      await db.collection('config').doc('store').update(updateData);

      console.log('[Admin] Updated margins:', updateData);

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          message: 'Margins updated',
          data: updateData
        })
      };
    }

    // ═══ ADD STOCK ═══
    if (action === 'add-stock') {
      const { name, wear, float, buyPrice, sellPrice, iconUrl, type, rarity } = body;

      if (!name || !buyPrice) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'name and buyPrice required' }) };
      }

      const stockId = name.replace(/\s+/g, '_') + '_' + Date.now();
      const stockData = {
        name: name,
        wear: wear || 'Factory New',
        float: float || null,
        buyPrice: rd(buyPrice),
        sellPrice: rd(sellPrice || buyPrice * 1.15),
        iconUrl: iconUrl || '',
        type: type || 'Weapon Skin',
        rarity: rarity || 'Common',
        addedAt: new Date().toISOString(),
        addedBy: 'admin'
      };

      await db.collection('stock').doc(stockId).set(stockData);

      console.log('[Admin] Added stock:', stockId, stockData);

      return {
        statusCode: 201,
        headers: H,
        body: JSON.stringify({
          success: true,
          message: 'Item added to stock',
          itemId: stockId,
          data: stockData
        })
      };
    }

    // ═══ REMOVE STOCK ═══
    if (action === 'remove-stock') {
      const { itemId } = body;

      if (!itemId) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'itemId required' }) };
      }

      await db.collection('stock').doc(itemId).delete();

      console.log('[Admin] Removed stock:', itemId);

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          message: 'Item removed from stock',
          itemId: itemId
        })
      };
    }

    // ═══ LIST ORDERS ═══
    if (action === 'orders') {
      const { status, steamId, limit = 50, offset = 0 } = body;

      let query = db.collection('orders');

      if (status) {
        query = query.where('status', '==', status);
      }

      if (steamId) {
        query = query.where('user.steamId', '==', steamId);
      }

      query = query.orderBy('createdAt', 'desc').limit(limit).offset(offset);

      const snapshot = await query.get();
      const orders = [];

      snapshot.forEach(doc => {
        orders.push({
          orderId: doc.id,
          ...doc.data()
        });
      });

      console.log(`[Admin] Listed ${orders.length} orders (status: ${status || 'all'}, offset: ${offset})`);

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          orders: orders,
          count: orders.length,
          limit: limit,
          offset: offset
        })
      };
    }

    // ═══ UPDATE ORDER STATUS ═══
    if (action === 'update-order-status') {
      const { orderId, status, notes } = body;

      if (!orderId || !status) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'orderId and status required' }) };
      }

      const validStatuses = ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Invalid status: ' + status }) };
      }

      const orderRef = db.collection('orders').doc(orderId);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Order not found' }) };
      }

      const updateData = { status };

      if (status === 'delivered') {
        updateData.deliveredAt = new Date().toISOString();
      }

      if (status === 'paid') {
        updateData.paidAt = new Date().toISOString();
      }

      if (notes) {
        updateData.notes = notes;
      }

      await orderRef.update(updateData);

      console.log('[Admin] Updated order', orderId, 'to', status);

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          message: 'Order updated',
          orderId: orderId,
          status: status,
          data: updateData
        })
      };
    }

    // ═══ GET STOCK LIST ═══
    if (action === 'stock') {
      const { limit = 100, offset = 0 } = body;

      const snapshot = await db.collection('stock')
        .orderBy('addedAt', 'desc')
        .limit(limit)
        .offset(offset)
        .get();

      const items = [];

      snapshot.forEach(doc => {
        items.push({
          itemId: doc.id,
          ...doc.data()
        });
      });

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          items: items,
          count: items.length,
          limit: limit,
          offset: offset
        })
      };
    }

    // ═══ GET STORE CONFIG ═══
    if (action === 'config') {
      const configDoc = await db.collection('config').doc('store').get();
      const config = configDoc.data() || {};

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          config: config
        })
      };
    }

    // ═══ UPDATE STORE CONFIG ═══
    if (action === 'update-config') {
      const { name, logo, whatsapp, instagram, deliveryFullTime, deliveryNormalTime } = body;

      const updateData = {};

      if (name) updateData.name = name;
      if (logo) updateData.logo = logo;
      if (whatsapp) updateData.whatsapp = whatsapp;
      if (instagram) updateData.instagram = instagram;
      if (deliveryFullTime !== undefined) updateData.deliveryFullTime = deliveryFullTime;
      if (deliveryNormalTime !== undefined) updateData.deliveryNormalTime = deliveryNormalTime;

      if (Object.keys(updateData).length === 0) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'No fields to update' }) };
      }

      await db.collection('config').doc('store').update(updateData);

      console.log('[Admin] Updated config:', updateData);

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          message: 'Config updated',
          data: updateData
        })
      };
    }

    // ═══ GET PRICING CONFIG ═══
    if (action === 'get-pricing') {
      const { getPricingConfig } = require('./pricing');
      const { fetchExchangeRate, getRateCache } = require('./exchange-rate');
      const [cfg, googleRate] = await Promise.all([
        getPricingConfig(true),
        fetchExchangeRate().catch(() => 0),
      ]);
      const cache = getRateCache();
      const baseRate = googleRate > 0 ? googleRate : cfg.fallbackRate;
      const saleFactor = cfg.mode === 'percent'
        ? baseRate * (1 + (cfg.marginPct || 0) / 100)
        : baseRate + (cfg.surchargeBRL || 0);
      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          config: cfg,
          currentFactor: saleFactor,
          googleRate,
          rateSource: cache.source,
          preview: {
            youpinCNY: 100,
            originalBRL: Math.round(100 * baseRate * 100) / 100,
            saleBRL: Math.round(100 * saleFactor * 100) / 100,
          },
        }),
      };
    }

    // ═══ UPDATE PRICING CONFIG ═══
    // body: { mode?, surchargeBRL?, marginPct? }
    if (action === 'update-pricing') {
      const { setPricingConfig } = require('./pricing');
      const { mode, surchargeBRL, marginPct } = body;
      try {
        const cfg = await setPricingConfig({ mode, surchargeBRL, marginPct }, 'admin');
        console.log('[Admin] Updated pricing:', cfg);
        return {
          statusCode: 200,
          headers: H,
          body: JSON.stringify({ success: true, config: cfg }),
        };
      } catch (e) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: e.message }) };
      }
    }

    // ═══ BUYBACK — LIST TRANSACTIONS ═══
    // Retorna todas as transações (ou filtradas por status).
    if (action === 'buyback-list') {
      const { status, limit = 50, type } = body;
      let query = db.collection('transactions');
      if (status) query = query.where('status', '==', status);
      if (type) query = query.where('type', '==', type);
      query = query.orderBy('createdAt', 'desc').limit(Math.min(200, limit));
      const snapshot = await query.get();
      const transactions = [];
      snapshot.forEach(d => transactions.push({ id: d.id, ...d.data() }));
      return {
        statusCode: 200, headers: H,
        body: JSON.stringify({ success: true, count: transactions.length, transactions }),
      };
    }

    // ═══ BUYBACK — UPDATE TRANSACTION STATUS ═══
    // body: { txId, status, note? }
    // Status válidos:
    //   WAITING_USER_TRADE    → aguardando user enviar trade
    //   WAITING_USER_PIX      → aguardando user pagar PIX (upgrade)
    //   TRADE_SENT            → Gu enviou trade pro user (upgrade/downgrade)
    //   WAITING_TRADE_PROTECTION → skin chegou, contando 8 dias
    //   READY_TO_SETTLE       → 8 dias passaram, pronto pra finalizar
    //   COMPLETED             → tudo finalizado
    //   CANCELED              → cancelado
    //   BLOCKED               → bloqueado (suspeita de fraude)
    if (action === 'buyback-update-status') {
      const { txId, status, note } = body;
      if (!txId || !status) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'txId e status obrigatórios' }) };
      }
      const VALID = [
        'WAITING_USER_TRADE', 'WAITING_USER_PIX', 'TRADE_SENT',
        'WAITING_TRADE_PROTECTION', 'READY_TO_SETTLE',
        'COMPLETED', 'CANCELED', 'BLOCKED',
      ];
      if (!VALID.includes(status)) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'status inválido' }) };
      }

      const ref = db.collection('transactions').doc(txId);
      const snap = await ref.get();
      if (!snap.exists) {
        return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'transação não encontrada' }) };
      }
      const prev = snap.data();
      const now = new Date().toISOString();
      const patch = { status, updatedAt: now };

      // Side-effects por status
      if (status === 'WAITING_TRADE_PROTECTION') {
        // Começa a contagem de 8 dias
        patch.tradeAcceptedAt = now;
        patch.tradeProtectionEndsAt = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
      }
      if (status === 'COMPLETED') {
        if (prev.type === 'sell' || prev.type === 'downgrade') {
          patch.pixOutSentAt = now;
        }
      }

      // Append statusHistory
      const history = Array.isArray(prev.statusHistory) ? prev.statusHistory : [];
      history.push({ from: prev.status, to: status, at: now, by: 'admin', note: note || '' });
      patch.statusHistory = history;

      await ref.update(patch);
      console.log(`[Admin Buyback] ${txId} ${prev.status} → ${status}`);
      return {
        statusCode: 200, headers: H,
        body: JSON.stringify({ success: true, id: txId, ...prev, ...patch }),
      };
    }

    // ═══ GET ORDER STATS ═══
    if (action === 'stats') {
      // Get orders from last 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const snapshot = await db.collection('orders')
        .where('createdAt', '>=', thirtyDaysAgo)
        .get();

      let totalRevenue = 0;
      let totalOrders = 0;
      const statusCounts = {};

      snapshot.forEach(doc => {
        const order = doc.data();
        totalOrders++;
        totalRevenue += order.total || 0;

        if (!statusCounts[order.status]) {
          statusCounts[order.status] = 0;
        }
        statusCounts[order.status]++;
      });

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          success: true,
          stats: {
            period: '30 days',
            totalOrders: totalOrders,
            totalRevenue: rd(totalRevenue),
            averageOrderValue: totalOrders > 0 ? rd(totalRevenue / totalOrders) : 0,
            statusBreakdown: statusCounts
          }
        })
      };
    }

    return {
      statusCode: 400,
      headers: H,
      body: JSON.stringify({ error: 'Unknown action: ' + action })
    };

  } catch (e) {
    console.error('[Admin] Error:', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
