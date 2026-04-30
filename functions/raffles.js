// ═══ Gumax — Sistema de Rifas ═══
// Apenas 1 rifa ativa por vez (raffles/active singleton — usamos doc id "active"
// pra rifa em andamento; rifas finalizadas migram pra raffles/{autoId}).
//
// Compra de bilhete:
//   1. Cliente clica "Comprar X bilhetes" (mín 2)
//   2. POST /api/raffles/buy { qty } → backend reserva qty números aleatórios
//      dos disponíveis, cria PIX no MP, salva raffleTickets/{id} status='pending'
//   3. Cliente paga PIX
//   4. MP webhook → POST /api/raffles/webhook → atualiza ticket pra paid +
//      incrementa raffles.soldTickets
//
// Sorteio (manual via admin):
//   1. POST /api/raffles/admin/draw → backend pega TODOS tickets pagos, sorteia
//      um aleatório (Math.random ponderado por número de bilhetes), marca rifa
//      como 'drawn' e cria registro no histórico.

const admin = require('firebase-admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};
function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// Verifica se usuário é admin (aceita email em ADMIN_EMAILS, UID em ADMIN_UIDS,
// ou flag isAdmin=true no Firestore — Steam login não tem email).
async function requireAdmin(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const email = (decoded.email || '').toLowerCase();
    const uid = decoded.uid || '';
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const adminUids = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (email && adminEmails.includes(email)) return decoded;
    if (uid && adminUids.includes(uid)) return decoded;
    // Fallback 1: doc users/{uid} com isAdmin=true
    try {
      const userDoc = await admin.firestore().collection('users').doc(uid).get();
      if (userDoc.exists && userDoc.data().isAdmin === true) return decoded;
    } catch (e) {}
    // Fallback 2: query users por email com isAdmin=true (Steam tem doc separado do Gmail)
    if (email) {
      try {
        const q = await admin.firestore().collection('users')
          .where('email', '==', email).where('isAdmin', '==', true).limit(1).get();
        if (!q.empty) return decoded;
      } catch (e) {}
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Verifica usuário comum logado (qualquer Steam user).
async function requireUser(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (e) {
    return null;
  }
}

// ── Libera tickets `pending` cujo `pendingExpiresAt` já passou. Decrementa
//    `reservedTickets` da rifa pra liberar os números pra outros clientes.
//    Chamada antes de qualquer leitura/escrita do grid pra manter consistência.
//    Idempotente — pode rodar várias vezes sem efeito colateral.
async function releaseExpiredTickets(raffleId = 'active') {
  const db = admin.firestore();
  const now = Date.now();
  // Busca tickets pending da rifa específica. Filtro por pendingExpiresAt
  // não pode ser inequality + outra inequality, então faz client-side.
  const snap = await db.collection('raffleTickets')
    .where('raffleId', '==', raffleId)
    .where('status', '==', 'pending')
    .get();

  const expired = [];
  snap.docs.forEach(d => {
    const t = d.data();
    const expiresAtMs = t.pendingExpiresAt?.toMillis ? t.pendingExpiresAt.toMillis() : (t.pendingExpiresAtMs || 0);
    if (expiresAtMs && expiresAtMs < now) expired.push({ id: d.id, qty: t.qty || (t.ticketNumbers || []).length });
  });

  if (!expired.length) return 0;

  // Marca cada um como 'expired' + decrementa reservedTickets na rifa.
  const totalQty = expired.reduce((s, e) => s + (e.qty || 0), 0);
  const batch = db.batch();
  for (const e of expired) {
    batch.update(db.collection('raffleTickets').doc(e.id), {
      status: 'expired',
      expiredAt: admin.firestore.FieldValue.serverTimestamp(),
      expiredReason: 'pending_ttl_5min',
    });
  }
  batch.update(db.collection('raffles').doc(raffleId), {
    reservedTickets: admin.firestore.FieldValue.increment(-totalQty),
  });
  await batch.commit();
  console.log(`[Raffles] released ${expired.length} expired tickets (${totalQty} numbers) from raffle ${raffleId}`);
  return expired.length;
}

// ── Sorteia qty números aleatórios ENTRE 1 e totalTickets que ainda
//    NÃO estão reservados (presentes em ticketsByNumber).
function pickRandomNumbers(qty, totalTickets, takenSet) {
  const available = [];
  for (let i = 1; i <= totalTickets; i++) {
    if (!takenSet.has(i)) available.push(i);
  }
  if (available.length < qty) return null;
  const picked = [];
  for (let i = 0; i < qty; i++) {
    const idx = Math.floor(Math.random() * available.length);
    picked.push(available.splice(idx, 1)[0]);
  }
  return picked.sort((a, b) => a - b);
}

// TTL da reserva: 5 min. Se o user não pagar nesse tempo, libera os números
// pra outros. Solicitado pelo Gu pra evitar números travados sem pagamento.
const RAFFLE_PENDING_TTL_MS = 5 * 60 * 1000;

// ── Cria PIX no Mercado Pago pra cobrança de bilhetes ──
async function createPixForRaffle({ totalBRL, description, externalRef, userEmail, metadata }) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!MP_TOKEN) throw new Error('MP_ACCESS_TOKEN not configured');
  // PIX expira em 5 min no MP também — depois disso o pagamento é rejeitado.
  // Formato ISO-8601 com timezone offset (MP exige).
  const expirationDate = new Date(Date.now() + RAFFLE_PENDING_TTL_MS);
  // MP quer formato tipo "2026-04-26T20:30:00.000-03:00"
  const isoExp = expirationDate.toISOString().replace('Z', '-00:00');
  const body = {
    transaction_amount: Math.round(totalBRL * 100) / 100,
    description,
    payment_method_id: 'pix',
    payer: { email: userEmail || 'cliente@gumaxskins.com', first_name: 'Gumax User' },
    external_reference: externalRef,
    metadata,
    date_of_expiration: isoExp,
  };
  const resp = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MP_TOKEN}`,
      'X-Idempotency-Key': `${externalRef}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('[Raffles] MP create error:', JSON.stringify(data));
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

// ═══════════════════════════ ENDPOINTS ═══════════════════════════

// GET /api/raffles/active → retorna rifa ativa + números já tomados (pública).
async function handleGetActive() {
  const db = admin.firestore();
  // Antes de listar, libera tickets pending expirados (>5min sem pagar).
  // Best-effort: se falhar, log e segue (vale a pena devolver o grid mesmo
  // levemente stale do que travar a página inteira por causa do cleanup).
  try { await releaseExpiredTickets('active'); }
  catch (e) { console.warn('[Raffles] releaseExpiredTickets falhou no GetActive:', e.message); }

  const doc = await db.collection('raffles').doc('active').get();
  if (!doc.exists) return json(200, { active: null });
  // Pega TODOS os números já reservados/pagos pra renderizar a cartela
  const ticketsSnap = await db.collection('raffleTickets').where('raffleId', '==', 'active').get();
  const taken = [];
  ticketsSnap.docs.forEach(d => {
    const t = d.data();
    if (t.status === 'paid' || t.status === 'pending') {
      (t.ticketNumbers || []).forEach(n => taken.push({ n, status: t.status }));
    }
  });
  return json(200, {
    active: { id: doc.id, ...doc.data() },
    takenNumbers: taken,
  });
}

// GET /api/raffles/history?limit=10 → últimas rifas finalizadas (pública).
async function handleGetHistory(event) {
  const db = admin.firestore();
  const limit = Math.min(50, parseInt(event.queryStringParameters?.limit, 10) || 10);
  const snap = await db.collection('raffles')
    .where('status', 'in', ['drawn', 'cancelled'])
    .orderBy('drawnAt', 'desc')
    .limit(limit)
    .get();
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return json(200, { items });
}

// GET /api/raffles/my-tickets → tickets do user (auth).
async function handleGetMyTickets(event) {
  const user = await requireUser(event);
  if (!user) return json(401, { error: 'unauthorized' });
  const db = admin.firestore();
  const snap = await db.collection('raffleTickets')
    .where('uid', '==', user.uid)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return json(200, { items });
}

// POST /api/raffles/buy { numbers? | qty } → reserva números + cria PIX (auth).
//   - numbers: array dos números escolhidos pelo cliente (ex: [3, 7, 12])
//   - qty:     fallback — se não passar numbers, sortea qty números aleatórios
async function handleBuy(event) {
  const user = await requireUser(event);
  if (!user) return json(401, { error: 'unauthorized', message: 'Faça login com Steam' });

  const body = JSON.parse(event.body || '{}');
  const requestedNumbers = Array.isArray(body.numbers)
    ? body.numbers.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0)
    : null;
  const qty = requestedNumbers ? requestedNumbers.length : parseInt(body.qty, 10);
  if (!qty || qty < 1) return json(400, { error: 'invalid_qty', message: 'Mínimo 1 bilhete por compra' });
  if (qty > 100) return json(400, { error: 'invalid_qty', message: 'Máximo 100 bilhetes por compra' });
  if (requestedNumbers && new Set(requestedNumbers).size !== requestedNumbers.length) {
    return json(400, { error: 'duplicate_numbers', message: 'Há números duplicados na seleção' });
  }

  const db = admin.firestore();

  // Busca dados do user pra validar profileComplete
  const userDoc = await db.collection('users').doc(user.uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  if (!userData.tradeLink || !userData.whatsapp) {
    return json(400, {
      error: 'profile_incomplete',
      message: 'Complete seu perfil (tradelink + WhatsApp) antes de comprar bilhetes',
    });
  }

  // Libera reservas expiradas ANTES da transação. Garante que números travados
  // por usuários que abandonaram o pagamento estejam disponíveis pra esse user.
  try { await releaseExpiredTickets('active'); }
  catch (e) { console.warn('[Raffles] releaseExpiredTickets falhou no Buy:', e.message); }

  const result = await db.runTransaction(async (tx) => {
    const raffleRef = db.collection('raffles').doc('active');
    const snap = await tx.get(raffleRef);
    if (!snap.exists) throw new Error('Nenhuma rifa ativa no momento');
    const raffle = snap.data();
    if (raffle.status !== 'active') throw new Error('Rifa não está mais ativa');

    const remaining = raffle.totalTickets - (raffle.soldTickets || 0) - (raffle.reservedTickets || 0);
    if (remaining < qty) {
      throw new Error(`Só restam ${remaining} bilhetes — ajuste a quantidade`);
    }

    // Pega TODOS os números já reservados/pagos
    const allTicketsSnap = await tx.get(
      db.collection('raffleTickets').where('raffleId', '==', 'active')
    );
    const taken = new Set();
    allTicketsSnap.docs.forEach(d => {
      const t = d.data();
      if (t.status === 'paid' || t.status === 'pending') {
        (t.ticketNumbers || []).forEach(n => taken.add(n));
      }
    });

    let numbers;
    if (requestedNumbers) {
      // Cliente escolheu números específicos. Valida cada um.
      for (const n of requestedNumbers) {
        if (n < 1 || n > raffle.totalTickets) {
          throw new Error(`Número ${n} fora do range (1-${raffle.totalTickets})`);
        }
        if (taken.has(n)) {
          throw new Error(`Número ${n} já foi escolhido por outro cliente. Atualize a página.`);
        }
      }
      numbers = [...requestedNumbers].sort((a, b) => a - b);
    } else {
      numbers = pickRandomNumbers(qty, raffle.totalTickets, taken);
      if (!numbers) throw new Error('Não foi possível reservar números — tente menos bilhetes');
    }

    const totalBRL = qty * raffle.pricePerTicket;
    const ticketRef = db.collection('raffleTickets').doc();

    // pendingExpiresAt: timestamp absoluto em ms. Tickets pending após esse
    // tempo são liberados por releaseExpiredTickets. 5 min — alinhado com o
    // date_of_expiration do PIX no MP.
    const pendingExpiresAtMs = Date.now() + RAFFLE_PENDING_TTL_MS;

    tx.set(ticketRef, {
      raffleId: 'active',
      raffleSnapshot: { name: raffle.name, skinName: raffle.skinName, skinImage: raffle.skinImage },
      uid: user.uid,
      steamId: userData.steamId || user.uid,
      steamName: userData.steamName || userData.fullName || '',
      whatsapp: userData.whatsapp,
      ticketNumbers: numbers,
      qty,
      pricePerTicket: raffle.pricePerTicket,
      totalPriceBRL: totalBRL,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      pendingExpiresAt: admin.firestore.Timestamp.fromMillis(pendingExpiresAtMs),
      pendingExpiresAtMs, // backup numérico pra leitura simples
    });

    // Reserva os números (incrementa reservedTickets pra outros não pegarem)
    tx.update(raffleRef, {
      reservedTickets: admin.firestore.FieldValue.increment(qty),
    });

    return { ticketRef, numbers, totalBRL, raffle };
  });

  // Cria PIX FORA da transação (chamada externa)
  try {
    const pix = await createPixForRaffle({
      totalBRL: result.totalBRL,
      description: `Gumax Rifa - ${result.raffle.name} (${result.numbers.length} bilhetes)`,
      externalRef: `raffle:${result.ticketRef.id}`,
      userEmail: userData.email,
      metadata: {
        type: 'raffle',
        ticketId: result.ticketRef.id,
        raffleId: 'active',
        uid: user.uid,
      },
    });
    // Salva paymentId no ticket
    await result.ticketRef.update({
      paymentId: pix.paymentId,
      qrCodeBase64: pix.qrCodeBase64,
      copyPaste: pix.copyPaste,
      expiresAt: pix.expiresAt,
    });
    return json(200, {
      ticketId: result.ticketRef.id,
      numbers: result.numbers,
      totalBRL: result.totalBRL,
      qrCodeBase64: pix.qrCodeBase64,
      copyPaste: pix.copyPaste,
      paymentId: pix.paymentId,
      // ms timestamp — frontend usa pra countdown de 5 min no modal de PIX
      pendingExpiresAtMs: Date.now() + RAFFLE_PENDING_TTL_MS,
    });
  } catch (e) {
    // Rollback: marca ticket como expirado e devolve reservedTickets
    await result.ticketRef.update({ status: 'expired' });
    await admin.firestore().collection('raffles').doc('active').update({
      reservedTickets: admin.firestore.FieldValue.increment(-result.numbers.length),
    });
    return json(500, { error: 'pix_failed', message: e.message });
  }
}

// POST /api/raffles/webhook (MP) — atualiza ticket pra paid quando PIX confirma.
async function handleWebhook(event) {
  const body = JSON.parse(event.body || '{}');
  const type = body.type || event.queryStringParameters?.type;
  const dataId = body.data?.id || event.queryStringParameters?.['data.id'];
  if (type !== 'payment' || !dataId) return json(200, { received: true });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` },
  });
  if (!resp.ok) return json(200, { received: true, skipped: 'mp fetch failed' });
  const pay = await resp.json();

  const ref = pay.external_reference || pay.metadata?.external_reference;
  if (!ref || !ref.startsWith('raffle:')) {
    return json(200, { received: true, skipped: 'not a raffle' });
  }
  const ticketId = ref.replace('raffle:', '');

  const db = admin.firestore();
  const ticketRef = db.collection('raffleTickets').doc(ticketId);
  const ticketDoc = await ticketRef.get();
  if (!ticketDoc.exists) return json(200, { received: true, skipped: 'ticket not found' });
  const ticket = ticketDoc.data();
  if (ticket.status === 'paid') return json(200, { received: true, already: true });

  if (pay.status === 'approved') {
    // Caso comum: ticket ainda pending → promove pra paid normalmente.
    // Caso edge: ticket virou expired no meio (TTL 5min estourou MAS user
    // pagou no MP). Nesse caso checa se os números ainda estão livres:
    //   - Livres → promove mesmo assim (re-reserva ao pagar)
    //   - Tomados por outro → flagra pra refund manual via admin
    const ticketWasExpired = ticket.status === 'expired';

    if (ticketWasExpired) {
      // Verifica se algum número desse ticket já foi reservado/pago por outro
      const sameRaffleSnap = await db.collection('raffleTickets')
        .where('raffleId', '==', ticket.raffleId)
        .where('status', 'in', ['paid', 'pending'])
        .get();
      const taken = new Set();
      sameRaffleSnap.docs.forEach(d => {
        if (d.id === ticketId) return;
        const other = d.data();
        (other.ticketNumbers || []).forEach(n => taken.add(n));
      });
      const conflict = (ticket.ticketNumbers || []).some(n => taken.has(n));
      if (conflict) {
        // Flagra pra refund manual — Gu vai precisar devolver via PIX/Stripe
        await ticketRef.update({
          status: 'paid_after_expire_conflict',
          paymentStatus: pay.status,
          needsManualRefund: true,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          conflictNote: 'User pagou após TTL 5min e números já tomados por outro. Refund manual.',
        });
        console.warn(`[Raffles] CONFLITO: ticket ${ticketId} pagou tarde, números tomados. Refund manual!`);
        return json(200, { received: true, conflict: true });
      }
      // Sem conflito — promove pra paid + re-reserva
      await db.runTransaction(async (tx) => {
        tx.update(ticketRef, {
          status: 'paid',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentStatus: pay.status,
          paidAfterExpire: true,
        });
        tx.update(db.collection('raffles').doc(ticket.raffleId || 'active'), {
          soldTickets: admin.firestore.FieldValue.increment(ticket.qty),
          // reservedTickets não muda — já foi decrementado quando expirou
        });
      });
      return json(200, { received: true, paid: true, latePaid: true });
    }

    // Caminho normal — pending → paid
    await db.runTransaction(async (tx) => {
      tx.update(ticketRef, {
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paymentStatus: pay.status,
      });
      const raffleRef = db.collection('raffles').doc('active');
      tx.update(raffleRef, {
        soldTickets: admin.firestore.FieldValue.increment(ticket.qty),
        reservedTickets: admin.firestore.FieldValue.increment(-ticket.qty),
      });
    });
    return json(200, { received: true, paid: true });
  }

  if (pay.status === 'rejected' || pay.status === 'cancelled') {
    // Devolve a reserva — números voltam pro pool
    await db.runTransaction(async (tx) => {
      tx.update(ticketRef, { status: 'expired', paymentStatus: pay.status });
      tx.update(db.collection('raffles').doc('active'), {
        reservedTickets: admin.firestore.FieldValue.increment(-ticket.qty),
      });
    });
  }
  return json(200, { received: true, status: pay.status });
}

// ─────────────────────────── ADMIN ───────────────────────────

// POST /api/raffles/admin/create
//   body: { name, skinName, skinImage, skinValueBRL, pricePerTicket, totalTickets, drawDate, videoUrl }
async function handleAdminCreate(event) {
  const adminUser = await requireAdmin(event);
  if (!adminUser) return json(401, { error: 'admin_only' });

  const body = JSON.parse(event.body || '{}');
  const required = ['name', 'skinName', 'pricePerTicket', 'totalTickets'];
  for (const k of required) {
    if (!body[k]) return json(400, { error: 'missing_field', field: k });
  }
  const total = parseInt(body.totalTickets, 10);
  const price = parseFloat(body.pricePerTicket);
  if (!total || total < 10 || total > 10000) return json(400, { error: 'invalid_total', message: 'totalTickets entre 10 e 10000' });
  if (!price || price < 1 || price > 1000) return json(400, { error: 'invalid_price', message: 'pricePerTicket entre R$1 e R$1000' });

  const db = admin.firestore();
  const existing = await db.collection('raffles').doc('active').get();
  if (existing.exists && existing.data().status === 'active') {
    return json(409, { error: 'active_exists', message: 'Já existe uma rifa ativa. Sorteie ou cancele antes de criar outra.' });
  }

  const raffle = {
    name: String(body.name).slice(0, 80),
    skinName: String(body.skinName).slice(0, 200),
    skinImage: body.skinImage || '',
    skinValueBRL: parseFloat(body.skinValueBRL) || 0,
    pricePerTicket: price,
    totalTickets: total,
    soldTickets: 0,
    reservedTickets: 0,
    status: 'active',
    drawDate: body.drawDate || null,
    videoUrl: body.videoUrl || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: adminUser.email,
  };
  await db.collection('raffles').doc('active').set(raffle);
  return json(200, { ok: true, raffle });
}

// POST /api/raffles/admin/draw → sorteia random entre tickets pagos.
async function handleAdminDraw(event) {
  const adminUser = await requireAdmin(event);
  if (!adminUser) return json(401, { error: 'admin_only' });

  const db = admin.firestore();
  const raffleRef = db.collection('raffles').doc('active');
  const raffleDoc = await raffleRef.get();
  if (!raffleDoc.exists) return json(404, { error: 'no_active_raffle' });
  const raffle = raffleDoc.data();
  if (raffle.status !== 'active') return json(409, { error: 'not_active', status: raffle.status });

  const ticketsSnap = await db.collection('raffleTickets')
    .where('raffleId', '==', 'active')
    .where('status', '==', 'paid')
    .get();
  if (ticketsSnap.empty) return json(409, { error: 'no_paid_tickets', message: 'Nenhum bilhete pago ainda' });

  // Cada bilhete vendido = 1 chance.
  // Constrói lista flat dos números → escolhe 1 random.
  const allNumbers = [];
  ticketsSnap.docs.forEach(d => {
    const t = d.data();
    (t.ticketNumbers || []).forEach(n => {
      allNumbers.push({ number: n, ticketId: d.id, uid: t.uid, steamId: t.steamId, steamName: t.steamName, whatsapp: t.whatsapp });
    });
  });
  const winnerIdx = Math.floor(Math.random() * allNumbers.length);
  const winner = allNumbers[winnerIdx];

  // Move rifa pra histórico (raffles/{autoId}) e limpa active
  const historyRef = db.collection('raffles').doc(); // autoId
  await db.runTransaction(async (tx) => {
    tx.set(historyRef, {
      ...raffle,
      status: 'drawn',
      winnerSteamId: winner.steamId,
      winnerUid: winner.uid,
      winnerSteamName: winner.steamName,
      winnerWhatsapp: winner.whatsapp,
      winningTicketNumber: winner.number,
      winningTicketId: winner.ticketId,
      drawnAt: admin.firestore.FieldValue.serverTimestamp(),
      drawnBy: adminUser.email,
      totalEntries: allNumbers.length,
    });
    tx.delete(raffleRef);
  });

  return json(200, {
    ok: true,
    winner: {
      steamId: winner.steamId,
      steamName: winner.steamName,
      whatsapp: winner.whatsapp,
      ticketNumber: winner.number,
    },
    historyId: historyRef.id,
  });
}

// POST /api/raffles/admin/cancel → cancela rifa ativa (sem refund automático).
async function handleAdminCancel(event) {
  const adminUser = await requireAdmin(event);
  if (!adminUser) return json(401, { error: 'admin_only' });

  const db = admin.firestore();
  const raffleRef = db.collection('raffles').doc('active');
  const raffleDoc = await raffleRef.get();
  if (!raffleDoc.exists) return json(404, { error: 'no_active_raffle' });
  const raffle = raffleDoc.data();

  const historyRef = db.collection('raffles').doc();
  await db.runTransaction(async (tx) => {
    tx.set(historyRef, {
      ...raffle,
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy: adminUser.email,
      drawnAt: admin.firestore.FieldValue.serverTimestamp(), // pra ordenação no history
    });
    tx.delete(raffleRef);
  });
  return json(200, { ok: true, historyId: historyRef.id });
}

// ═══════════════════════════ MAIN HANDLER ═══════════════════════════
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';
  const method = event.httpMethod;

  try {
    if (method === 'GET' && path.endsWith('/active'))      return await handleGetActive();
    if (method === 'GET' && path.endsWith('/history'))     return await handleGetHistory(event);
    if (method === 'GET' && path.endsWith('/my-tickets'))  return await handleGetMyTickets(event);
    if (method === 'POST' && path.endsWith('/buy'))        return await handleBuy(event);
    if (method === 'POST' && path.endsWith('/webhook'))    return await handleWebhook(event);
    if (method === 'POST' && path.endsWith('/admin/create')) return await handleAdminCreate(event);
    if (method === 'POST' && path.endsWith('/admin/draw'))   return await handleAdminDraw(event);
    if (method === 'POST' && path.endsWith('/admin/cancel')) return await handleAdminCancel(event);
    return json(404, { error: 'not_found' });
  } catch (e) {
    console.error('[Raffles] handler error:', e);
    return json(500, { error: 'server_error', message: e.message });
  }
};
