// ═══ Gumax — Lobby (Matchmaker entre amigos) ═══
//
// Sala 5 slots. Owner cria, outros entram via lista pública.
// Quando 2 lobbies cheios (5/5) se desafiam e ambos aceitam, vira /matches/{id}
// que roda o flow de confirmação → pick/ban → start servidor RCON → connect.
//
// MVP: público fechado dos amigos do Gu (~30 pessoas), sem ELO, sem chat,
// sem stats — esses entram em fases posteriores.
//
// Schema Firestore:
//   lobbies/{lobbyId}
//     ownerId, ownerName, ownerAvatar
//     status: 'open' | 'full' | 'challenged' | 'in_match'
//     slots: [{uid, steamId, name, avatar, joinedAt}, ...]  // 5 slots, null = vazio
//     challengedBy: lobbyId | null    // se outra sala desafiou esta
//     challengeExpiresAt: ms          // 30s pra aceitar
//     matchId: matchId | null         // após desafio aceito
//     createdAt, updatedAt
//
// Endpoints (rotas em server.js → /api/lobby/*):
//   POST   /create
//   GET    /list                 → todas open + full
//   GET    /:id                  → estado da sala (polling)
//   GET    /mine                 → lobby do user logado (se houver)
//   POST   /:id/join
//   POST   /:id/leave
//   POST   /:id/kick {targetUid} → só owner
//   POST   /:id/challenge {target}
//   POST   /:id/accept-challenge
//   POST   /:id/decline-challenge

const admin = require('firebase-admin');

// Helper local pra verificar Firebase ID token. Mesmo padrão usado em
// credits.js / raffles.js / analysis.js (steam-auth.js NÃO exporta esse helper).
async function verifyIdToken(headers) {
  const auth = headers?.authorization || headers?.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7);
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (e) {
    console.log('[Lobby] ID token verify failed:', e.message);
    return null;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};
function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// TTL do lobby idle: 30min. Se ninguém interage, limpamos pra liberar a lista.
const LOBBY_IDLE_TTL_MS = 30 * 60 * 1000;
// TTL do desafio: 30s. Se a outra sala não aceitar nesse tempo, expira.
const CHALLENGE_TTL_MS = 30 * 1000;

// Garante user está logado. Retorna {uid, displayName, photoURL, steamId} ou null.
async function getAuth(event) {
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return null;
  // Carrega dados do user no Firestore (steamId, steamName, avatar)
  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(decoded.uid).get();
  const u = userDoc.exists ? userDoc.data() : {};
  return {
    uid: decoded.uid,
    name: u.steamName || u.fullName || decoded.name || 'Player',
    avatar: u.steamAvatar || u.photoURL || decoded.picture || '',
    steamId: u.steamId || decoded.uid,
  };
}

// Limpa lobbies idle (sem update há >30min). Idempotente. Chamado em listLobbies
// e antes de operações importantes pra manter a lista limpa.
async function cleanupStaleLobbies() {
  const db = admin.firestore();
  const cutoff = Date.now() - LOBBY_IDLE_TTL_MS;
  const snap = await db.collection('lobbies')
    .where('updatedAt', '<', admin.firestore.Timestamp.fromMillis(cutoff))
    .where('status', 'in', ['open', 'full'])
    .get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

// ───── POST /create — cria lobby novo (5 slots, owner ocupa o slot 0) ─────
async function handleCreate(event) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });

  const db = admin.firestore();
  // User só pode estar em UM lobby por vez. Procura existing.
  const existing = await db.collection('lobbies')
    .where('memberUids', 'array-contains', user.uid)
    .limit(1).get();
  if (!existing.empty) {
    return json(409, { error: 'already_in_lobby', lobbyId: existing.docs[0].id });
  }

  const body = JSON.parse(event.body || '{}');
  const name = (body.name || `Sala do ${user.name}`).slice(0, 40);

  const lobbyRef = db.collection('lobbies').doc();
  const slot0 = { uid: user.uid, steamId: user.steamId, name: user.name, avatar: user.avatar, joinedAt: admin.firestore.FieldValue.serverTimestamp() };
  await lobbyRef.set({
    name,
    ownerId: user.uid,
    ownerName: user.name,
    ownerAvatar: user.avatar,
    status: 'open',
    slots: [slot0, null, null, null, null],
    memberUids: [user.uid],  // pra query 'array-contains'
    challengedBy: null,
    matchId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return json(200, { lobbyId: lobbyRef.id });
}

// ───── GET /list — todas salas abertas + cheias (sem em_match/finished) ───
async function handleList() {
  await cleanupStaleLobbies(); // best effort
  const db = admin.firestore();
  const snap = await db.collection('lobbies')
    .where('status', 'in', ['open', 'full', 'challenged'])
    .orderBy('updatedAt', 'desc')
    .limit(50)
    .get();
  const lobbies = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name,
      ownerName: data.ownerName,
      ownerAvatar: data.ownerAvatar,
      status: data.status,
      slots: data.slots,
      filled: (data.slots || []).filter(s => s != null).length,
      challengedBy: data.challengedBy,
      matchId: data.matchId,
    };
  });
  return json(200, { count: lobbies.length, lobbies });
}

// ───── GET /:id — estado da sala (polling) ──────────────────────────────
async function handleGetOne(event, lobbyId) {
  const db = admin.firestore();
  const doc = await db.collection('lobbies').doc(lobbyId).get();
  if (!doc.exists) return json(404, { error: 'not_found' });
  return json(200, { id: doc.id, ...doc.data() });
}

// ───── GET /mine — lobby do user logado (se houver) ─────────────────────
async function handleGetMine(event) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const db = admin.firestore();
  const snap = await db.collection('lobbies')
    .where('memberUids', 'array-contains', user.uid)
    .limit(1).get();
  if (snap.empty) return json(200, { lobby: null });
  return json(200, { lobby: { id: snap.docs[0].id, ...snap.docs[0].data() } });
}

// ───── POST /:id/join ────────────────────────────────────────────────────
async function handleJoin(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const db = admin.firestore();

  // User só pode estar em 1 lobby
  const existing = await db.collection('lobbies')
    .where('memberUids', 'array-contains', user.uid)
    .limit(1).get();
  if (!existing.empty) {
    return json(409, { error: 'already_in_lobby', lobbyId: existing.docs[0].id });
  }

  // Adiciona ao primeiro slot vazio (transação pra evitar race conditions)
  await db.runTransaction(async (tx) => {
    const ref = db.collection('lobbies').doc(lobbyId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('lobby_not_found');
    const data = snap.data();
    if (data.status === 'in_match') throw new Error('lobby_in_match');
    const slots = [...(data.slots || [null,null,null,null,null])];
    const emptyIdx = slots.findIndex(s => s == null);
    if (emptyIdx === -1) throw new Error('lobby_full');
    slots[emptyIdx] = {
      uid: user.uid, steamId: user.steamId, name: user.name, avatar: user.avatar,
      joinedAt: admin.firestore.Timestamp.now(),
    };
    const filled = slots.filter(s => s != null).length;
    tx.update(ref, {
      slots,
      memberUids: admin.firestore.FieldValue.arrayUnion(user.uid),
      status: filled === 5 ? 'full' : 'open',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }).catch(e => {
    if (e.message === 'lobby_not_found') return null;
    throw e;
  });

  return json(200, { lobbyId });
}

// ───── POST /:id/leave ───────────────────────────────────────────────────
async function handleLeave(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const db = admin.firestore();

  await db.runTransaction(async (tx) => {
    const ref = db.collection('lobbies').doc(lobbyId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    const slots = (data.slots || []).map(s => s && s.uid === user.uid ? null : s);
    // Se o owner saiu, deleta o lobby (alternativa: passar ownership pro próximo)
    if (data.ownerId === user.uid) {
      tx.delete(ref);
      return;
    }
    // Se ficou vazio, deleta também
    if (slots.every(s => s == null)) {
      tx.delete(ref);
      return;
    }
    tx.update(ref, {
      slots,
      memberUids: admin.firestore.FieldValue.arrayRemove(user.uid),
      status: 'open',  // se estava 'full', volta pra 'open'
      challengedBy: null, // cancela qualquer desafio pendente
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return json(200, { ok: true });
}

// ───── POST /:id/kick {targetUid} — só owner ─────────────────────────────
async function handleKick(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const body = JSON.parse(event.body || '{}');
  if (!body.targetUid) return json(400, { error: 'missing_targetUid' });
  if (body.targetUid === user.uid) return json(400, { error: 'cant_kick_self' });

  const db = admin.firestore();
  await db.runTransaction(async (tx) => {
    const ref = db.collection('lobbies').doc(lobbyId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('not_found');
    const data = snap.data();
    if (data.ownerId !== user.uid) throw new Error('not_owner');
    const slots = (data.slots || []).map(s => s && s.uid === body.targetUid ? null : s);
    tx.update(ref, {
      slots,
      memberUids: admin.firestore.FieldValue.arrayRemove(body.targetUid),
      status: 'open',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }).catch(e => {
    if (e.message === 'not_owner') throw new Error('only owner can kick');
    throw e;
  });
  return json(200, { ok: true });
}

// ───── POST /:id/challenge {targetLobbyId} ───────────────────────────────
// Sala A (cheia) desafia sala B (cheia). Marca challengedBy em B.
// B precisa aceitar em 30s. Apenas owner desafia.
async function handleChallenge(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const body = JSON.parse(event.body || '{}');
  if (!body.targetLobbyId) return json(400, { error: 'missing_targetLobbyId' });

  const db = admin.firestore();
  const myRef = db.collection('lobbies').doc(lobbyId);
  const targetRef = db.collection('lobbies').doc(body.targetLobbyId);

  await db.runTransaction(async (tx) => {
    const [mine, target] = await Promise.all([tx.get(myRef), tx.get(targetRef)]);
    if (!mine.exists || !target.exists) throw new Error('lobby_not_found');
    const me = mine.data();
    const tgt = target.data();
    if (me.ownerId !== user.uid) throw new Error('not_owner');
    if (me.status !== 'full') throw new Error('my_lobby_not_full');
    if (tgt.status !== 'full') throw new Error('target_not_full');
    if (tgt.challengedBy) throw new Error('target_already_challenged');

    tx.update(targetRef, {
      challengedBy: lobbyId,
      challengeExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CHALLENGE_TTL_MS),
      status: 'challenged',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(myRef, {
      status: 'challenged',
      challengeTo: body.targetLobbyId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return json(200, { ok: true, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

// ───── POST /:id/accept-challenge ────────────────────────────────────────
// Owner da sala desafiada aceita → cria match e ambas viram in_match.
async function handleAcceptChallenge(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });

  const db = admin.firestore();
  const myRef = db.collection('lobbies').doc(lobbyId);

  let matchId = null;
  await db.runTransaction(async (tx) => {
    const mine = await tx.get(myRef);
    if (!mine.exists) throw new Error('not_found');
    const me = mine.data();
    if (me.ownerId !== user.uid) throw new Error('not_owner');
    if (!me.challengedBy) throw new Error('no_pending_challenge');
    if (me.challengeExpiresAt?.toMillis && me.challengeExpiresAt.toMillis() < Date.now()) {
      throw new Error('challenge_expired');
    }

    const otherRef = db.collection('lobbies').doc(me.challengedBy);
    const other = await tx.get(otherRef);
    if (!other.exists) throw new Error('other_lobby_gone');

    // Cria o match — IDs dos dois lobbies + 10 jogadores
    const matchRef = db.collection('matches').doc();
    matchId = matchRef.id;
    const teamA = (other.data().slots || []).filter(Boolean);
    const teamB = (me.slots || []).filter(Boolean);
    tx.set(matchRef, {
      lobbyA: me.challengedBy,
      lobbyB: lobbyId,
      teamA, teamB,
      status: 'confirming',
      // Cada jogador precisa confirmar em 90s. Default = false.
      confirmations: [...teamA, ...teamB].reduce((acc, p) => { acc[p.uid] = false; return acc; }, {}),
      confirmExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 90 * 1000),
      mapVeto: {
        pool: ['de_mirage','de_inferno','de_dust2','de_nuke','de_anubis','de_ancient','de_train'],
        actions: [],
        activeTeam: 'A',
        finalMap: null,
      },
      serverInfo: null,
      stats: {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(myRef, {
      status: 'in_match', matchId,
      challengedBy: null, challengeExpiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(otherRef, {
      status: 'in_match', matchId,
      challengeTo: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return json(200, { ok: true, matchId });
}

// ───── POST /:id/decline-challenge ───────────────────────────────────────
async function handleDeclineChallenge(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const db = admin.firestore();
  const myRef = db.collection('lobbies').doc(lobbyId);
  await db.runTransaction(async (tx) => {
    const mine = await tx.get(myRef);
    if (!mine.exists) throw new Error('not_found');
    const me = mine.data();
    if (me.ownerId !== user.uid) throw new Error('not_owner');
    if (!me.challengedBy) return;
    const otherRef = db.collection('lobbies').doc(me.challengedBy);
    tx.update(otherRef, {
      status: 'full', challengeTo: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(myRef, {
      status: 'full', challengedBy: null, challengeExpiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return json(200, { ok: true });
}

// ─── Handler HTTP ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';
  // Rota /api/lobby/list (GET)
  if (event.httpMethod === 'GET' && path.endsWith('/list')) return handleList();
  // Rota /api/lobby/mine (GET)
  if (event.httpMethod === 'GET' && path.endsWith('/mine')) return handleGetMine(event);
  // Rota /api/lobby/create (POST)
  if (event.httpMethod === 'POST' && path.endsWith('/create')) return handleCreate(event);

  // Rotas com lobbyId — extrai do path /api/lobby/{id}/{action}
  const m = path.match(/\/api\/lobby\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return json(404, { error: 'route_not_found', path });
  const lobbyId = m[1];
  const action = m[2] || '';

  if (event.httpMethod === 'GET' && !action) return handleGetOne(event, lobbyId);
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  switch (action) {
    case 'join':              return handleJoin(event, lobbyId);
    case 'leave':             return handleLeave(event, lobbyId);
    case 'kick':              return handleKick(event, lobbyId);
    case 'challenge':         return handleChallenge(event, lobbyId);
    case 'accept-challenge':  return handleAcceptChallenge(event, lobbyId);
    case 'decline-challenge': return handleDeclineChallenge(event, lobbyId);
    default: return json(404, { error: 'unknown_action', action });
  }
};

exports.cleanupStaleLobbies = cleanupStaleLobbies;
