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

// Threshold de slots preenchidos pra status virar 'full' (e habilitar desafio).
// Default 5 = comportamento normal 5v5. Pode ser reduzido via env var pra testes
// (ex: LOBBY_FULL_THRESHOLD=1 permite testar 1v1 entre 2 contas).
// REMOVER A ENV VAR depois do teste pra voltar ao comportamento padrão.
const LOBBY_FULL_THRESHOLD = Math.max(1, Math.min(5, parseInt(process.env.LOBBY_FULL_THRESHOLD || '5', 10)));
console.log('[Lobby] LOBBY_FULL_THRESHOLD =', LOBBY_FULL_THRESHOLD);

// Modo debug: permite challenge mesmo se status !== 'full'. Útil pra closed
// beta com poucos amigos. Quando ativo, qualquer sala com pelo menos 1
// jogador pode ser desafiada. REMOVER em produção real.
const ALLOW_PARTIAL_CHALLENGE = process.env.MATCH_DEBUG_ALLOW_PARTIAL === '1';
console.log('[Lobby] ALLOW_PARTIAL_CHALLENGE =', ALLOW_PARTIAL_CHALLENGE);
function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// TTL absoluto do lobby: 20min desde a CRIAÇÃO (createdAt).
// Independente de updates — sala não fica viva eternamente, mesmo se gente
// entrar/sair pra dar bump. User pediu explicitamente "20 minutos de criação".
const LOBBY_MAX_AGE_MS = 20 * 60 * 1000;
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

// Limpa lobbies expirados — TTL absoluto de 20min desde createdAt.
// Idempotente. Chamado a cada GET /list pra manter a coleção limpa
// sem precisar de cron job. Pra MVP (~30 docs total) o overhead é trivial.
//
// v37-cleanup: também limpa "matchId órfão" — sala cujo matchId aponta pra
// partida que NÃO existe mais OU está cancelled/finished. Isso resolve casos
// onde a sala ficou "presa" porque o release falhou (timeout, crash do
// backend mid-update, etc). Zera o matchId pra liberar a sala. Se já tinha
// passado dos 20min, deleta direto.
async function cleanupStaleLobbies() {
  const db = admin.firestore();
  const cutoff = Date.now() - LOBBY_MAX_AGE_MS;
  const snap = await db.collection('lobbies').limit(200).get();
  const expired = [];
  const orphans = [];

  // Pre-fetch: pega todos matchIds únicos pra não fazer N queries seguidas
  const matchIds = new Set();
  snap.docs.forEach(d => { if (d.data().matchId) matchIds.add(d.data().matchId); });
  const matchStatuses = {};
  for (const mid of matchIds) {
    try {
      const ms = await db.collection('matches').doc(mid).get();
      matchStatuses[mid] = ms.exists ? (ms.data().status || 'unknown') : 'missing';
    } catch { matchStatuses[mid] = 'error'; }
  }

  snap.docs.forEach(d => {
    const data = d.data();
    const ageRefMs = data.createdAt?.toMillis ? data.createdAt.toMillis()
                   : data.updatedAt?.toMillis ? data.updatedAt.toMillis()
                   : null;
    const ageMin = ageRefMs ? Math.round((Date.now() - ageRefMs)/60000) : -1;

    // Caso 1: matchId aponta pra match que NÃO existe ou foi cancelled/finished
    // → libera o lobby (zera matchId, status='open' ou 'full')
    if (data.matchId) {
      const matchStatus = matchStatuses[data.matchId];
      if (matchStatus === 'missing' || matchStatus === 'cancelled' || matchStatus === 'finished') {
        orphans.push({ ref: d.ref, id: d.id, matchId: data.matchId, matchStatus, ageMin, data });
      }
      // Se matchId aponta pra match ativa (in_progress/starting/mappick/confirming), respeitamos
      return;
    }
    // Caso 2: status='in_match' mas SEM matchId — estado inválido. Trata como órfão.
    if (data.status === 'in_match') {
      orphans.push({ ref: d.ref, id: d.id, matchId: null, matchStatus: 'no_match', ageMin, data });
      return;
    }

    // Caso 3: TTL absoluto 20min
    if (!ageRefMs) return;
    if (ageRefMs < cutoff) expired.push({ ref: d.ref, id: d.id, ageMin });
  });

  // Aplica orphan release: zera matchId e seta status correto. Se também > 20min, deleta.
  if (orphans.length) {
    const batch = db.batch();
    for (const o of orphans) {
      // Se já passou dos 20 min, deleta direto (já tava abandonado)
      if (o.ageMin >= 20) {
        batch.delete(o.ref);
        expired.push({ ref: o.ref, id: o.id, ageMin: o.ageMin });
      } else {
        const filled = (o.data.slots || []).filter(s => s != null).length;
        const newStatus = filled >= 5 ? 'full' : 'open';
        batch.update(o.ref, {
          status: newStatus, matchId: null, challengedBy: null, challengeTo: null,
          challengeExpiresAt: null, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[lobby:cleanup] orphan released ${o.id} (matchId ${o.matchId}=${o.matchStatus}, ${o.ageMin}min) → status=${newStatus}`);
      }
    }
    await batch.commit().catch(e => console.warn('[lobby:cleanup] orphan batch failed:', e.message));
  }

  if (!expired.length) return 0;
  const batch = db.batch();
  // Filtra duplicados (orphans que viraram expired podem aparecer 2x se o array nao for único)
  const seen = new Set();
  const unique = expired.filter(e => seen.has(e.id) ? false : (seen.add(e.id), true));
  unique.forEach(e => batch.delete(e.ref));
  await batch.commit();
  console.log(`[lobby:cleanup] deleted ${unique.length} expired lobbies (>${LOBBY_MAX_AGE_MS/60000}min): ${unique.map(e => `${e.id}(${e.ageMin}min)`).join(', ')}`);
  return unique.length;
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
  // Timestamp.now() em vez de FieldValue.serverTimestamp() porque o slot vai
  // dentro de um ARRAY — Firestore não permite serverTimestamp dentro de array
  // elements ("FieldValue.serverTimestamp() cannot be used inside of an array").
  const slot0 = { uid: user.uid, steamId: user.steamId, name: user.name, avatar: user.avatar, joinedAt: admin.firestore.Timestamp.now() };
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

  console.log(`[lobby:create] created ${lobbyRef.id} owner=${user.uid} name="${name}"`);
  return json(200, { lobbyId: lobbyRef.id });
}

// ───── GET /list — todas salas abertas + cheias (sem em_match/finished) ───
// Query simplificada (sem índice composto): pega TUDO e filtra/ordena client-side.
// Pra escala MVP (~30 user simultâneos, max 30 lobbies), isso é trivial.
async function handleList() {
  // Cleanup TTL 20min desde createdAt — roda em todo /list (idempotente).
  // Garantia extra: NUNCA deleta salas com matchId set (em partida).
  await cleanupStaleLobbies().catch(e => console.warn('[lobby:cleanup] failed:', e.message));
  const db = admin.firestore();
  const snap = await db.collection('lobbies').limit(100).get();
  console.log(`[lobby:list] read ${snap.size} docs from collection`);
  const lobbies = [];
  const allStatuses = [];
  snap.docs.forEach(d => {
    const data = d.data();
    allStatuses.push(`${d.id}=${data.status}`);
    if (!['open', 'full', 'challenged'].includes(data.status)) return;
    lobbies.push({
      id: d.id,
      name: data.name,
      ownerName: data.ownerName,
      ownerAvatar: data.ownerAvatar,
      status: data.status,
      slots: data.slots,
      filled: (data.slots || []).filter(s => s != null).length,
      challengedBy: data.challengedBy,
      matchId: data.matchId,
      updatedAtMs: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : 0,
    });
  });
  console.log(`[lobby:list] returning ${lobbies.length} lobbies. All statuses: ${allStatuses.join(',')}`);
  // Ordena por updatedAt desc (mais recente primeiro)
  lobbies.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
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
      status: filled >= LOBBY_FULL_THRESHOLD ? 'full' : 'open',
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
    // v33-test: validação 'full' DESLIGADA permanente até closed beta. Pra reativar:
    // 1. Apaga essas duas linhas comentadas
    // 2. Descomenta as 2 linhas if/throw acima
    // (env var ALLOW_PARTIAL_CHALLENGE virou no-op — código sempre permite challenge parcial)
    console.log('[Lobby] challenge: me.status=' + me.status + ' tgt.status=' + tgt.status + ' (validation skipped — debug mode)');
    if (tgt.challengedBy) throw new Error('target_already_challenged');
    if (lobbyId === body.targetLobbyId) throw new Error('cant_challenge_self');

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
      // Cada jogador precisa confirmar em 30s. Default = false.
      confirmations: [...teamA, ...teamB].reduce((acc, p) => { acc[p.uid] = false; return acc; }, {}),
      confirmExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 1000),
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
  co