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
// v48-multi-challenge: cap de challenges simultaneos por sala (anti-spam)
const MAX_OUTGOING_CHALLENGES = 10;

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

// v38-throttle: cache de execução pra reduzir reads do Firestore.
// Antes o cleanup rodava em TODA chamada de /list (~150 reads cada). Com
// polling de 6s e 5 users abertos = 75 cleanups/min × 150 = 11k reads/min.
// Agora roda no MÁXIMO 1x por minuto. Estado é in-memory na instância do
// Railway — em deploy/restart reseta, sem problema.
let _lastCleanupAt = 0;
const CLEANUP_COOLDOWN_MS = 40 * 1000;

// Limpa lobbies expirados — TTL absoluto de 20min desde createdAt.
// Idempotente. Chamado por GET /list (com throttle de 60s).
//
// v37-cleanup: também limpa "matchId órfão" — sala cujo matchId aponta pra
// partida que NÃO existe mais OU está cancelled/finished. Isso resolve casos
// onde a sala ficou "presa" porque o release falhou (timeout, crash do
// backend mid-update, etc). Zera o matchId pra liberar a sala. Se já tinha
// passado dos 20min, deleta direto.
async function cleanupStaleLobbies() {
  // v38-throttle: pula se rodou há menos de 60s
  if (Date.now() - _lastCleanupAt < CLEANUP_COOLDOWN_MS) return 0;
  _lastCleanupAt = Date.now();

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

  // v48-challenge-expire: limpa challenges que estouraram o TTL (30s).
  // Antes: se ninguem aceitava, o desafiante ficava em "Aguardando resposta"
  // eternamente. Agora ambos os lados sao zerados num batch.
  // Usa o snap JA carregado — zero read extra.
  const now = Date.now();
  const lobbiesById = {};
  snap.docs.forEach(d => { lobbiesById[d.id] = d; });
  const expiredChallenges = [];
  const handledIds = new Set();
  snap.docs.forEach(d => {
    if (handledIds.has(d.id)) return;
    const data = d.data();
    const expMs = data.challengeExpiresAt?.toMillis ? data.challengeExpiresAt.toMillis() : null;
    if (data.challengedBy && expMs && expMs < now) {
      // d = sala TARGET (challenged). challengedBy = ID da sala CHALLENGER.
      expiredChallenges.push({ targetRef: d.ref, targetId: d.id, challengerId: data.challengedBy });
      handledIds.add(d.id);
      handledIds.add(data.challengedBy);
    }
  });
  // Cobre tambem o caso onde so o challenger tem challengeTo mas o target
  // nao tem challengedBy (estado meio-bugado de versao anterior).
  snap.docs.forEach(d => {
    if (handledIds.has(d.id)) return;
    const data = d.data();
    if (!data.challengeTo) return;
    const targetDoc = lobbiesById[data.challengeTo];
    // Se o target nao existe mais OU nao tem challengedBy apontando pra mim
    // OU o expiresAt do target ja passou
    const targetData = targetDoc ? targetDoc.data() : null;
    const targetExp = targetData?.challengeExpiresAt?.toMillis ? targetData.challengeExpiresAt.toMillis() : null;
    const targetPointsBack = targetData?.challengedBy === d.id;
    if (!targetData || !targetPointsBack || (targetExp && targetExp < now)) {
      expiredChallenges.push({ targetRef: targetDoc?.ref || null, targetId: data.challengeTo, challengerId: d.id });
      handledIds.add(d.id);
      if (targetDoc) handledIds.add(targetDoc.id);
    }
  });

  if (expiredChallenges.length) {
    const cleanupBatch = db.batch();
    for (const ec of expiredChallenges) {
      // Limpa o CHALLENGER: zera challengeTo, status volta pra full
      const challengerRef = db.collection('lobbies').doc(ec.challengerId);
      cleanupBatch.update(challengerRef, {
        challengeTo: null,
        status: 'full',  // assume que ainda esta cheia (era cheia pra desafiar)
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Limpa o TARGET: zera challengedBy + challengeExpiresAt, status volta pra full
      if (ec.targetRef) {
        cleanupBatch.update(ec.targetRef, {
          challengedBy: null,
          challengeExpiresAt: null,
          status: 'full',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      console.log(`[lobby:cleanup] challenge expirado: challenger=${ec.challengerId} target=${ec.targetId}`);
    }
    await cleanupBatch.commit().catch(e => console.warn('[lobby:cleanup] challenge-expire batch failed:', e.message));
  }

  // v48-multi-challenge: varre pendingIncoming/Outgoing maps e limpa entries expiradas.
  // Mantém os 2 lados consistentes (se A.outgoing[B] expirou, limpa B.incoming[A]).
  const mapEntriesBatch = db.batch();
  let mapClearOps = 0;
  snap.docs.forEach(d => {
    const data = d.data();
    const outgoing = data.pendingOutgoing || {};
    const incoming = data.pendingIncoming || {};
    const updates = {};
    let dirty = false;
    let recalcOutgoingCache = false;
    let recalcIncomingCache = false;
    for (const [tid, entry] of Object.entries(outgoing)) {
      const exp = entry?.expiresAt?.toMillis ? entry.expiresAt.toMillis() : 0;
      if (exp && exp < now) {
        updates[`pendingOutgoing.${tid}`] = admin.firestore.FieldValue.delete();
        dirty = true; recalcOutgoingCache = true;
      }
    }
    for (const [cid, entry] of Object.entries(incoming)) {
      const exp = entry?.expiresAt?.toMillis ? entry.expiresAt.toMillis() : 0;
      if (exp && exp < now) {
        updates[`pendingIncoming.${cid}`] = admin.firestore.FieldValue.delete();
        dirty = true; recalcIncomingCache = true;
      }
    }
    if (dirty) {
      // Recalcula cache fields legacy (challengeTo/challengedBy = primeira entry restante valida)
      if (recalcOutgoingCache) {
        const remaining = Object.entries(outgoing).filter(([k, v]) => {
          const exp = v?.expiresAt?.toMillis ? v.expiresAt.toMillis() : 0;
          return exp > now;
        });
        updates['challengeTo'] = remaining.length > 0 ? remaining[0][0] : null;
      }
      if (recalcIncomingCache) {
        const remaining = Object.entries(incoming).filter(([k, v]) => {
          const exp = v?.expiresAt?.toMillis ? v.expiresAt.toMillis() : 0;
          return exp > now;
        });
        updates['challengedBy'] = remaining.length > 0 ? remaining[0][0] : null;
        if (remaining.length > 0 && remaining[0][1]?.expiresAt) {
          updates['challengeExpiresAt'] = remaining[0][1].expiresAt;
        } else {
          updates['challengeExpiresAt'] = null;
        }
      }
      updates['updatedAt'] = admin.firestore.FieldValue.serverTimestamp();
      mapEntriesBatch.update(d.ref, updates);
      mapClearOps++;
    }
  });
  if (mapClearOps > 0) {
    await mapEntriesBatch.commit().catch(e => console.warn('[lobby:cleanup] map-expire batch failed:', e.message));
    console.log(`[lobby:cleanup] limpou ${mapClearOps} lobbies com entries expiradas em pendingIn/Out`);
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

  // Aplica orphan release: zera matchId e seta status correto.
  // v38-persist: cooldown de 15min depois de matchEndedAt (em vez de
  // comparar com createdAt direto). Antes, lobby >20min era deletado mesmo
  // se a partida tinha acabado 1min atrás — agora preserva pro user voltar.
  const POST_MATCH_COOLDOWN_MS = 15 * 60 * 1000;
  if (orphans.length) {
    const batch = db.batch();
    for (const o of orphans) {
      // Calcula tempo desde fim do match (se setado), senão usa ageMin
      const matchEndedMs = o.data.matchEndedAt?.toMillis ? o.data.matchEndedAt.toMillis() : null;
      const sincePostMatchMs = matchEndedMs ? (Date.now() - matchEndedMs) : null;
      const shouldDelete = sincePostMatchMs !== null
        ? sincePostMatchMs > POST_MATCH_COOLDOWN_MS  // pós-match: só deleta após 15min
        : o.ageMin >= 20;                            // sem matchEndedAt: TTL absoluto
      if (shouldDelete) {
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

  // v48-admin-reports: bloqueia entrada de player banido
  if (user.steamId) {
    try {
      const ps = await db.collection('playerStats').doc(user.steamId).get();
      const banUntil = ps.exists ? (ps.data().bannedUntil?.toMillis ? ps.data().bannedUntil.toMillis() : 0) : 0;
      if (banUntil && banUntil > Date.now()) {
        const remainingHrs = Math.ceil((banUntil - Date.now()) / 3600000);
        return json(403, {
          error: 'banned',
          reason: ps.data().bannedReason || 'unknown',
          bannedUntil: banUntil,
          remainingHours: remainingHrs,
        });
      }
    } catch (e) { console.warn('[lobby:join] ban check failed:', e.message); }
  }

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
// v48-multi-challenge: sala A desafia N salas simultaneas (estilo GC).
// Adiciona em pendingOutgoing[targetId] / pendingIncoming[meId] com expiresAt.
// Status NAO muda — sala continua disponivel pra desafiar mais.
// Cap MAX_OUTGOING_CHALLENGES (10) anti-spam.
async function handleChallenge(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const body = JSON.parse(event.body || '{}');
  if (!body.targetLobbyId) return json(400, { error: 'missing_targetLobbyId' });
  if (lobbyId === body.targetLobbyId) return json(400, { error: 'cant_challenge_self' });

  const db = admin.firestore();
  const myRef = db.collection('lobbies').doc(lobbyId);
  const targetRef = db.collection('lobbies').doc(body.targetLobbyId);
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;
  const expiresAtTs = admin.firestore.Timestamp.fromMillis(expiresAtMs);

  await db.runTransaction(async (tx) => {
    const [mine, target] = await Promise.all([tx.get(myRef), tx.get(targetRef)]);
    if (!mine.exists || !target.exists) throw new Error('lobby_not_found');
    const me = mine.data();
    const tgt = target.data();
    if (me.ownerId !== user.uid) throw new Error('not_owner');
    if (me.status === 'in_match' || tgt.status === 'in_match') throw new Error('already_in_match');

    // Limpa entradas expiradas do meu pendingOutgoing antes de validar cap
    const now = Date.now();
    const myOutgoing = me.pendingOutgoing || {};
    let activeCount = 0;
    for (const [tid, entry] of Object.entries(myOutgoing)) {
      const exp = entry?.expiresAt?.toMillis ? entry.expiresAt.toMillis() : 0;
      if (exp > now && tid !== body.targetLobbyId) activeCount++;
    }
    if (activeCount >= MAX_OUTGOING_CHALLENGES) throw new Error('too_many_outgoing');

    // Update meu: adiciona target ao map outgoing + cache field
    const newMyOutgoing = { ...myOutgoing, [body.targetLobbyId]: { expiresAt: expiresAtTs } };
    tx.update(myRef, {
      pendingOutgoing: newMyOutgoing,
      // Cache fields legacy (frontend antigo): primeira entrada ativa
      challengeTo: body.targetLobbyId,
      challengeExpiresAt: expiresAtTs,
      // status NAO muda — fica 'full' pra poder desafiar mais
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update target: adiciona meu lobby ao map incoming + cache field
    const tgtIncoming = tgt.pendingIncoming || {};
    const newTgtIncoming = { ...tgtIncoming, [lobbyId]: { expiresAt: expiresAtTs } };
    tx.update(targetRef, {
      pendingIncoming: newTgtIncoming,
      // Cache field legacy: primeiro challenger pendente
      challengedBy: lobbyId,
      challengeExpiresAt: expiresAtTs,
      // status NAO muda mais pra 'challenged' — sala continua 'full' e pode receber outros
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  // v48-push: notifica todos os membros do target lobby (fire-and-forget)
  try {
    const tgtSnap = await db.collection('lobbies').doc(body.targetLobbyId).get();
    const tgtData = tgtSnap.exists ? tgtSnap.data() : null;
    const targetUids = (tgtData?.slots || []).filter(s => s != null).map(s => s.uid);
    const mySnap = await db.collection('lobbies').doc(lobbyId).get();
    const myData = mySnap.exists ? mySnap.data() : null;
    if (targetUids.length) {
      const push = require('./push');
      push.sendPushToUsers(targetUids, {
        title: '⚔️ Novo desafio!',
        body: `${myData?.name || 'Uma sala'} desafiou seu time. Aceite em 30s!`,
        icon: '/gmax-league-logo.png',
        url: '/lobbies.html',
        tag: `challenge-${lobbyId}`,
      }).catch(() => {});
    }
  } catch (e) { console.warn('[push:challenge] falhou:', e.message); }

  return json(200, { ok: true, expiresAt: expiresAtMs });
}

// ───── POST /:id/accept-challenge ────────────────────────────────────────
// v48-multi-challenge: aceita challenger especifico (body.challengerId).
// Compat: sem challengerId, usa primeiro pendingIncoming nao expirado (= challengedBy legacy).
// Apos aceitar, cancela todos os OUTROS challenges relacionados aos 2 lobbies.
async function handleAcceptChallenge(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const body = JSON.parse(event.body || '{}');

  const db = admin.firestore();
  const myRef = db.collection('lobbies').doc(lobbyId);

  let matchId = null;
  let acceptedChallengerId = null;
  let lobbiesToCleanup = [];  // [{lobbyId, removeOutgoing: [targetIds], removeIncoming: [challengerIds]}]
  await db.runTransaction(async (tx) => {
    const mine = await tx.get(myRef);
    if (!mine.exists) throw new Error('not_found');
    const me = mine.data();
    if (me.ownerId !== user.uid) throw new Error('not_owner');
    if (me.status === 'in_match') throw new Error('already_in_match');

    // Determina qual challenger aceitar
    const incoming = me.pendingIncoming || {};
    const now = Date.now();
    let chId = body.challengerId || me.challengedBy;
    if (!chId) {
      // Pega primeiro nao expirado
      for (const [k, v] of Object.entries(incoming)) {
        const exp = v?.expiresAt?.toMillis ? v.expiresAt.toMillis() : 0;
        if (exp > now) { chId = k; break; }
      }
    }
    if (!chId) throw new Error('no_pending_challenge');
    const chEntry = incoming[chId];
    const chExp = chEntry?.expiresAt?.toMillis ? chEntry.expiresAt.toMillis() : (me.challengeExpiresAt?.toMillis ? me.challengeExpiresAt.toMillis() : 0);
    if (chExp && chExp < now) throw new Error('challenge_expired');
    acceptedChallengerId = chId;

    const otherRef = db.collection('lobbies').doc(chId);
    const other = await tx.get(otherRef);
    if (!other.exists) throw new Error('other_lobby_gone');
    const otherData = other.data();
    if (otherData.status === 'in_match') throw new Error('already_matched');

    // Cria o match — IDs dos dois lobbies + jogadores
    const matchRef = db.collection('matches').doc();
    matchId = matchRef.id;
    const teamA = (otherData.slots || []).filter(Boolean);  // challenger = teamA
    const teamB = (me.slots || []).filter(Boolean);
    tx.set(matchRef, {
      lobbyA: chId,
      lobbyB: lobbyId,
      teamA, teamB,
      status: 'confirming',
      confirmations: [...teamA, ...teamB].reduce((acc, p) => { acc[p.uid] = false; return acc; }, {}),
      confirmExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 1000),
      mapVeto: {
        pool: ['de_mirage','de_inferno','de_dust2','de_nuke','de_anubis','de_ancient','de_cache','de_train'],
        actions: [],
        activeTeam: 'A',
        finalMap: null,
      },
      serverInfo: null,
      stats: {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Limpa AMBOS os mapas dos 2 lobbies (vao pra in_match — sem mais challenges)
    tx.update(myRef, {
      status: 'in_match', matchId,
      pendingIncoming: {}, pendingOutgoing: {},
      challengedBy: null, challengeTo: null, challengeExpiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(otherRef, {
      status: 'in_match', matchId,
      pendingIncoming: {}, pendingOutgoing: {},
      challengedBy: null, challengeTo: null, challengeExpiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // v48-push: notifica todos os players do match pra abrirem match.html
    try {
      const allUids = [...teamA.map(p => p.uid), ...teamB.map(p => p.uid)].filter(Boolean);
      if (allUids.length) {
        const push = require('./push');
        push.sendPushToUsers(allUids, {
          title: '🎮 Match começou!',
          body: 'Confirme presença em 30s pra entrar no servidor.',
          icon: '/gmax-league-logo.png',
          url: `/match.html?id=${matchId}`,
          tag: `match-${matchId}`,
          requireInteraction: true,
        }).catch(() => {});
      }
    } catch (e) { console.warn('[push:accept] falhou:', e.message); }

    // Coleta lobbies AFETADOS pra cleanup pos-transacao (challenges cruzados)
    // Pra cada outro challenger no meu pendingIncoming (exceto o aceito) → limpa pendingOutgoing[meId] dele
    for (const otherChId of Object.keys(me.pendingIncoming || {})) {
      if (otherChId === chId) continue;
      lobbiesToCleanup.push({ id: otherChId, removeOutgoing: [lobbyId] });
    }
    // Pra cada target no meu pendingOutgoing → limpa pendingIncoming[meId] dele
    for (const targetId of Object.keys(me.pendingOutgoing || {})) {
      lobbiesToCleanup.push({ id: targetId, removeIncoming: [lobbyId] });
    }
    // Pra cada outro challenger no incoming do other (exceto eu) → limpa pendingOutgoing[other.id] dele
    for (const otherChId of Object.keys(otherData.pendingIncoming || {})) {
      if (otherChId === lobbyId) continue;
      lobbiesToCleanup.push({ id: otherChId, removeOutgoing: [chId] });
    }
    // Pra cada target no outgoing do other (exceto eu) → limpa pendingIncoming[other.id] dele
    for (const targetId of Object.keys(otherData.pendingOutgoing || {})) {
      if (targetId === lobbyId) continue;
      lobbiesToCleanup.push({ id: targetId, removeIncoming: [chId] });
    }
  });

  // Cleanup pos-transacao (best-effort, fora do TX pra evitar limite de docs)
  if (lobbiesToCleanup.length > 0) {
    const batch = db.batch();
    // Agrupa por lobbyId pra evitar update duplo no mesmo doc
    const byId = {};
    for (const item of lobbiesToCleanup) {
      if (!byId[item.id]) byId[item.id] = { removeOutgoing: new Set(), removeIncoming: new Set() };
      (item.removeOutgoing || []).forEach(x => byId[item.id].removeOutgoing.add(x));
      (item.removeIncoming || []).forEach(x => byId[item.id].removeIncoming.add(x));
    }
    for (const [lid, ops] of Object.entries(byId)) {
      const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      ops.removeOutgoing.forEach(tid => { updates[`pendingOutgoing.${tid}`] = admin.firestore.FieldValue.delete(); });
      ops.removeIncoming.forEach(cid => { updates[`pendingIncoming.${cid}`] = admin.firestore.FieldValue.delete(); });
      batch.update(db.collection('lobbies').doc(lid), updates);
    }
    await batch.commit().catch(e => console.warn('[lobby:accept] cleanup batch falhou:', e.message));
  }

  return json(200, { ok: true, matchId, acceptedFrom: acceptedChallengerId });
}

// ───── POST /:id/decline-challenge ───────────────────────────────────────
// v48-multi-challenge: declina challenger especifico (body.challengerId).
// Sem param → declina TODOS pendentes (compat).
async function handleDeclineChallenge(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const body = JSON.parse(event.body || '{}');
  const db = admin.firestore();
  const myRef = db.collection('lobbies').doc(lobbyId);
  let removedChallengers = [];
  await db.runTransaction(async (tx) => {
    const mine = await tx.get(myRef);
    if (!mine.exists) throw new Error('not_found');
    const me = mine.data();
    if (me.ownerId !== user.uid) throw new Error('not_owner');
    const incoming = me.pendingIncoming || {};
    const targetIds = body.challengerId ? [body.challengerId] : Object.keys(incoming);
    if (!targetIds.length && !me.challengedBy) return;
    // Tambem cobre legacy se challengedBy nao esta no map
    if (me.challengedBy && !incoming[me.challengedBy] && !body.challengerId) {
      targetIds.push(me.challengedBy);
    }
    removedChallengers = targetIds;

    // Limpa cada entry no meu pendingIncoming
    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    for (const cid of targetIds) {
      updates[`pendingIncoming.${cid}`] = admin.firestore.FieldValue.delete();
    }
    // Recalcula cache fields legacy
    const remaining = Object.keys(incoming).filter(k => !targetIds.includes(k));
    if (remaining.length === 0) {
      updates['challengedBy'] = null;
      updates['challengeExpiresAt'] = null;
    } else {
      updates['challengedBy'] = remaining[0];
      const exp = incoming[remaining[0]]?.expiresAt;
      if (exp) updates['challengeExpiresAt'] = exp;
    }
    tx.update(myRef, updates);
  });

  // Limpa contraparte (pendingOutgoing[meId] do challenger) fora da TX
  if (removedChallengers.length > 0) {
    const batch = db.batch();
    for (const cid of removedChallengers) {
      const otherRef = db.collection('lobbies').doc(cid);
      batch.update(otherRef, {
        [`pendingOutgoing.${lobbyId}`]: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit().catch(e => console.warn('[lobby:decline] cleanup batch falhou:', e.message));
  }
  return json(200, { ok: true, declined: removedChallengers });
}

// ───── POST /:id/cancel-challenge ────────────────────────────────────────
// v48-multi-challenge: cancela challenge especifico (body.targetId).
// Sem param → cancela TODOS outgoing.
async function handleCancelChallenge(event, lobbyId) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  const body = JSON.parse(event.body || '{}');
  const db = admin.firestore();
  const myRef = db.collection('lobbies').doc(lobbyId);
  let removedTargets = [];
  await db.runTransaction(async (tx) => {
    const mine = await tx.get(myRef);
    if (!mine.exists) throw new Error('not_found');
    const me = mine.data();
    if (me.ownerId !== user.uid) throw new Error('not_owner');
    const outgoing = me.pendingOutgoing || {};
    const targetIds = body.targetId ? [body.targetId] : Object.keys(outgoing);
    if (!targetIds.length && !me.challengeTo) return;
    if (me.challengeTo && !outgoing[me.challengeTo] && !body.targetId) {
      targetIds.push(me.challengeTo);
    }
    removedTargets = targetIds;

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    for (const tid of targetIds) {
      updates[`pendingOutgoing.${tid}`] = admin.firestore.FieldValue.delete();
    }
    const remaining = Object.keys(outgoing).filter(k => !targetIds.includes(k));
    if (remaining.length === 0) {
      updates['challengeTo'] = null;
      // challengeExpiresAt pode tambem ser do incoming, so zera se nao tiver incoming
      if (!Object.keys(me.pendingIncoming || {}).length) updates['challengeExpiresAt'] = null;
    } else {
      updates['challengeTo'] = remaining[0];
    }
    tx.update(myRef, updates);
  });

  if (removedTargets.length > 0) {
    const batch = db.batch();
    for (const tid of removedTargets) {
      const otherRef = db.collection('lobbies').doc(tid);
      batch.update(otherRef, {
        [`pendingIncoming.${lobbyId}`]: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit().catch(e => console.warn('[lobby:cancel] cleanup batch falhou:', e.message));
  }
  return json(200, { ok: true, cancelled: removedTargets });
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
    case 'cancel-challenge':  return handleCancelChallenge(event, lobbyId);
    default: return json(404, { error: 'unknown_action', action });
  }
};

exports.cleanupStaleLobbies = cleanupStaleLobbies;
exports.getAuth = getAuth;  // v41-reports: usado em match.js handleReport
