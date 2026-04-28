// ═══ Gumax — Match flow (após desafio aceito) ═══
//
// Fluxo:
//   1. Lobby A desafia Lobby B → B aceita → /matches/{id} criada (status: 'confirming')
//   2. Cada um dos 10 jogadores confirma "tô no PC" (POST /api/match/:id/confirm)
//   3. Quando 10 confirmam → status='mappick' → veto alternado de mapas
//   4. Quando 1 mapa sobra → status='starting' → backend faz RCON no servidor:
//      sv_password <X>, changelevel <map>, matchzy_loadmatch_url <json>
//   5. Backend retorna steam:// connect URL pros 10 jogadores → status='in_progress'
//   6. MatchZy roda o match (knife/sides/MR12) → ao terminar, POST /api/match/webhook
//   7. Backend grava stats (KDA, KDR, MVPs, ADR), atualiza ranking individual+times
//      e libera o servidor pra próxima partida
//
// MVP: RCON é stubbed por enquanto (retorna mock IP/port/password).
// Quando user confirmar com Glibhost que aceita Metamod+CSS+MatchZy,
// liga o cliente RCON real (mp_rcon).
//
// Schema matches/{id}:
//   lobbyA, lobbyB
//   teamA: [{uid, steamId, name, avatar}, ... 5]
//   teamB: idem
//   status: 'confirming' | 'mappick' | 'starting' | 'in_progress' | 'finished' | 'cancelled'
//   confirmations: { uid: bool, ... }   // 10 entries
//   confirmExpiresAt: Timestamp (90s)
//   mapVeto: {
//     pool: ['de_mirage','de_inferno','de_dust2','de_nuke','de_anubis','de_ancient','de_train'],
//     actions: [{ team:'A', action:'ban', map:'de_dust2', at:ts }, ...],
//     activeTeam: 'A' | 'B',
//     turn: 0..6,           // 0..3 ban (alternado, A first), 4 pick, 5 ban, 6 pick (final)
//     finalMap: 'de_mirage' | null,
//   }
//   serverInfo: { ip, port, password, connectUrl } | null
//   scoreA, scoreB, stats
//   createdAt, finishedAt

const admin = require('firebase-admin');

// Helper local pra verificar Firebase ID token (mesmo padrão de credits/raffles).
async function verifyIdToken(headers) {
  const auth = headers?.authorization || headers?.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7);
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (e) {
    console.log('[Match] ID token verify failed:', e.message);
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

// ── Sequência oficial de pick/ban pra 5v5 (estilo CS2 Premiere/Faceit):
//    A:ban → B:ban → A:ban → B:ban → A:ban → B:ban → último mapa restante = pick
//    7 mapas → 6 bans → 1 sobra
// Pra simplificar UI, capitão = owner do lobby. Em fase 2 podemos rotacionar.
const VETO_SEQUENCE = [
  { team: 'A', action: 'ban' },
  { team: 'B', action: 'ban' },
  { team: 'A', action: 'ban' },
  { team: 'B', action: 'ban' },
  { team: 'A', action: 'ban' },
  { team: 'B', action: 'ban' },
  // turn 6: mapa restante vira pick automaticamente (não tem ação do capitão)
];

// ── Carrega match com auth check de membership ───
async function loadMatchWithAuth(matchId, event) {
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return { error: 'login_required', status: 401 };
  const db = admin.firestore();
  const ref = db.collection('matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return { error: 'not_found', status: 404 };
  const data = snap.data();
  // Verifica se user é membro de algum dos times
  const allUids = [...(data.teamA || []), ...(data.teamB || [])].map(p => p.uid);
  if (!allUids.includes(decoded.uid)) return { error: 'not_member', status: 403 };
  return { ref, data, uid: decoded.uid, allUids };
}

// ── GET /:id — estado pra polling ───────────────────────────────────────
async function handleGet(event, matchId) {
  const result = await loadMatchWithAuth(matchId, event);
  if (result.error) return json(result.status, { error: result.error });
  return json(200, { id: matchId, ...result.data });
}

// ── POST /:id/confirm — jogador confirma "tô no PC" ───────────────────────
// Quando os 10 confirmam, status pula automático pra 'mappick' (transação).
// Se passar dos 90s sem todos confirmarem, status vai pra 'cancelled'.
async function handleConfirm(event, matchId) {
  const result = await loadMatchWithAuth(matchId, event);
  if (result.error) return json(result.status, { error: result.error });
  const { ref, data, uid } = result;
  if (data.status !== 'confirming') return json(409, { error: 'not_in_confirming', status: data.status });

  // Checa expiração antes de gravar
  const expMs = data.confirmExpiresAt?.toMillis ? data.confirmExpiresAt.toMillis() : 0;
  if (expMs && expMs < Date.now()) {
    await ref.update({ status: 'cancelled', cancelReason: 'confirm_timeout' });
    return json(409, { error: 'expired' });
  }

  await admin.firestore().runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) return;
    const f = fresh.data();
    if (f.status !== 'confirming') return; // alguém já avançou
    const confirmations = { ...(f.confirmations || {}), [uid]: true };
    const allConfirmed = Object.values(confirmations).every(v => v === true) && Object.keys(confirmations).length === 10;
    const update = { confirmations };
    if (allConfirmed) {
      update.status = 'mappick';
      update.mapPickStartedAt = admin.firestore.FieldValue.serverTimestamp();
      // Reset do veto pra estado limpo
      update['mapVeto.activeTeam'] = 'A';
      update['mapVeto.turn'] = 0;
    }
    tx.update(ref, update);
  });
  return json(200, { ok: true });
}

// ── POST /:id/veto { map } — capitão executa ban/pick conforme turno ─────
async function handleVeto(event, matchId) {
  const result = await loadMatchWithAuth(matchId, event);
  if (result.error) return json(result.status, { error: result.error });
  const { ref, data, uid } = result;
  if (data.status !== 'mappick') return json(409, { error: 'not_in_mappick' });

  const body = JSON.parse(event.body || '{}');
  if (!body.map) return json(400, { error: 'missing_map' });

  // Identifica time do user (A ou B) — capitão = ownerId do lobby
  let userTeam = null;
  // Olha lobbies pra achar owner
  const db = admin.firestore();
  const [lobbyA, lobbyB] = await Promise.all([
    db.collection('lobbies').doc(data.lobbyA).get(),
    db.collection('lobbies').doc(data.lobbyB).get(),
  ]);
  if (lobbyA.exists && lobbyA.data().ownerId === uid) userTeam = 'A';
  else if (lobbyB.exists && lobbyB.data().ownerId === uid) userTeam = 'B';
  if (!userTeam) return json(403, { error: 'not_captain' });

  let finalResult = null;
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) throw new Error('not_found');
    const f = fresh.data();
    if (f.status !== 'mappick') throw new Error('not_in_mappick');
    const veto = f.mapVeto || {};
    const turn = veto.turn || 0;
    if (turn >= VETO_SEQUENCE.length) throw new Error('veto_already_finished');

    const expectedTurn = VETO_SEQUENCE[turn];
    if (expectedTurn.team !== userTeam) throw new Error('not_your_turn');

    const prevActions = veto.actions || [];
    const remainingPool = (veto.pool || []).filter(m => !prevActions.some(a => a.map === m));
    if (!remainingPool.includes(body.map)) throw new Error('map_not_available');

    const newActions = [
      ...prevActions,
      { team: userTeam, action: expectedTurn.action, map: body.map, at: Date.now() },
    ];
    const newTurn = turn + 1;
    const newRemaining = remainingPool.filter(m => m !== body.map);

    // Se chegou ao último turn (6º ban) → mapa restante vira finalMap
    let finalMap = veto.finalMap || null;
    let newStatus = f.status;
    if (newTurn >= VETO_SEQUENCE.length && newRemaining.length === 1) {
      finalMap = newRemaining[0];
      newStatus = 'starting'; // backend vai começar partida no servidor
    }

    tx.update(ref, {
      'mapVeto.actions': newActions,
      'mapVeto.turn': newTurn,
      'mapVeto.activeTeam': newTurn < VETO_SEQUENCE.length ? VETO_SEQUENCE[newTurn].team : null,
      'mapVeto.finalMap': finalMap,
      status: newStatus,
    });

    if (newStatus === 'starting') finalResult = { finalMap, matchId };
  });

  // Se a partida tá pra começar, dispara setup do servidor (assíncrono, fora da tx)
  if (finalResult) {
    setupMatchServer(matchId).catch(e => {
      console.error('[match] setupMatchServer falhou:', e.message);
    });
  }
  return json(200, { ok: true, finalMap: finalResult?.finalMap || null });
}

// ── Setup do servidor CS2 (RCON + MatchZy) ───────────────────────────────
// MVP: stubbed — retorna mock connectUrl. Quando o servidor Glibhost estiver
// configurado com Metamod+CSS+MatchZy, troca pelo cliente RCON real abaixo.
async function setupMatchServer(matchId) {
  const db = admin.firestore();
  const ref = db.collection('matches').doc(matchId);

  // ── STUB ────────────────────────────────────────────────────────────
  // Em produção, isso aqui faria:
  //   1. Pega 1 servidor disponível do pool (ex: 2 servidores Glibhost)
  //   2. Conecta RCON via TCP no IP:27015 com senha do servidor
  //   3. Manda comandos:
  //        sv_password <random16chars>
  //        mp_teamname_1 "Time A"
  //        mp_teamname_2 "Time B"
  //        matchzy_loadmatch_url <URL apontando pra config JSON do match>
  //        changelevel <finalMap>
  //   4. Aguarda 10s pra mapa carregar
  //   5. Retorna { ip, port, password, connectUrl: 'steam://run/730//+connect IP:27015 +password X' }
  //
  // Por enquanto, retorna stub pra UX funcionar end-to-end no frontend.

  const password = 'gumax_' + Math.random().toString(36).slice(2, 8);
  const ip = process.env.MATCH_SERVER_IP || '0.0.0.0';
  const port = process.env.MATCH_SERVER_PORT || '27015';
  const connectUrl = `steam://run/730//+connect%20${ip}:${port}%20+password%20${password}`;

  await ref.update({
    serverInfo: { ip, port, password, connectUrl },
    status: 'in_progress',
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[match ${matchId}] server stub: ${ip}:${port} pw=${password}`);
}

// ── POST /webhook — MatchZy callback ao final ──────────────────────────
// Payload do MatchZy quando partida termina. Vamos parsear e gravar stats.
// Doc: https://shobhit-pathak.github.io/MatchZy/api/
async function handleWebhook(event) {
  // Segurança: confere secret no header (configurável no MatchZy)
  const secret = event.headers?.['x-matchzy-secret'] || event.headers?.['X-MatchZy-Secret'];
  if (process.env.MATCHZY_WEBHOOK_SECRET && secret !== process.env.MATCHZY_WEBHOOK_SECRET) {
    return json(401, { error: 'invalid_secret' });
  }
  const body = JSON.parse(event.body || '{}');
  const matchId = body.match_id || body.matchId;
  if (!matchId) return json(400, { error: 'missing_match_id' });

  const db = admin.firestore();
  const ref = db.collection('matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return json(404, { error: 'match_not_found' });

  // Atualiza o match com placar e stats. MatchZy manda webhook de eventos
  // diferentes (round_end, series_end, demo_uploaded). Trata o mais importante:
  // series_end (partida acabou) — payload tem score + player_stats[].
  if (body.event === 'series_end' || body.event === 'match_ended') {
    const stats = {};
    (body.players || body.player_stats || []).forEach(p => {
      const sid = p.steamid64 || p.steam_id || p.steamId;
      if (!sid) return;
      stats[sid] = {
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        assists: p.assists || 0,
        adr: p.adr || 0,
        hsRate: p.headshot_kills && p.kills ? Math.round((p.headshot_kills/p.kills)*100) : 0,
        mvps: p.mvp || p.mvps || 0,
        rating: p.rating || 0,
      };
    });

    await ref.update({
      status: 'finished',
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      scoreA: body.team1_score || body.scoreA || 0,
      scoreB: body.team2_score || body.scoreB || 0,
      winner: (body.team1_score > body.team2_score) ? 'A' : (body.team2_score > body.team1_score) ? 'B' : 'tie',
      stats,
      demoUrl: body.demo_url || null,
    });

    // Atualiza playerStats agregados (pra ranking individual)
    await aggregatePlayerStats(matchId, stats);

    // Libera os lobbies pra próxima partida
    const matchData = (await ref.get()).data();
    if (matchData.lobbyA) await db.collection('lobbies').doc(matchData.lobbyA).delete().catch(() => {});
    if (matchData.lobbyB) await db.collection('lobbies').doc(matchData.lobbyB).delete().catch(() => {});
  }

  return json(200, { received: true });
}

// Aggrega stats dos jogadores em playerStats/{steamId} pra ranking
async function aggregatePlayerStats(matchId, stats) {
  const db = admin.firestore();
  for (const [steamId, s] of Object.entries(stats)) {
    const ref = db.collection('playerStats').doc(steamId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? snap.data() : { matches: 0, kills: 0, deaths: 0, assists: 0, mvps: 0, totalAdr: 0 };
      tx.set(ref, {
        steamId,
        matches: (prev.matches || 0) + 1,
        kills: (prev.kills || 0) + (s.kills || 0),
        deaths: (prev.deaths || 0) + (s.deaths || 0),
        assists: (prev.assists || 0) + (s.assists || 0),
        mvps: (prev.mvps || 0) + (s.mvps || 0),
        totalAdr: (prev.totalAdr || 0) + (s.adr || 0),
        // Médias derivadas (calculadas no read pelo frontend)
        kdr: ((prev.kills || 0) + (s.kills || 0)) / Math.max(1, (prev.deaths || 0) + (s.deaths || 0)),
        kda: ((prev.kills || 0) + (s.kills || 0) + (prev.assists || 0) + (s.assists || 0)) / Math.max(1, (prev.deaths || 0) + (s.deaths || 0)),
        avgAdr: ((prev.totalAdr || 0) + (s.adr || 0)) / Math.max(1, (prev.matches || 0) + 1),
        lastMatchId: matchId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }
}

// ── GET /ranking — top 50 jogadores por rating (KDR + KDA + ADR ponderado)
async function handleRanking() {
  const db = admin.firestore();
  // Ordena por kills total como proxy de atividade. Em produção fazer cálculo
  // de "rating" composto (ex: HLTV 2.0 simplificado: 0.4*kdr + 0.3*kda + 0.3*adrNorm).
  const snap = await db.collection('playerStats')
    .orderBy('matches', 'desc')
    .limit(50)
    .get();
  const players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return json(200, { count: players.length, players });
}

// ─── Handler HTTP ───────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  // /api/match/webhook (POST, sem auth — autenticado por header secret)
  if (event.httpMethod === 'POST' && path.endsWith('/webhook')) return handleWebhook(event);
  // /api/match/ranking (GET, público)
  if (event.httpMethod === 'GET' && path.endsWith('/ranking')) return handleRanking();

  // /api/match/:id e /api/match/:id/{action}
  const m = path.match(/\/api\/match\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return json(404, { error: 'route_not_found', path });
  const matchId = m[1];
  const action = m[2] || '';

  if (event.httpMethod === 'GET' && !action) return handleGet(event, matchId);
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  switch (action) {
    case 'confirm': return handleConfirm(event, matchId);
    case 'veto':    return handleVeto(event, matchId);
    default: return json(404, { error: 'unknown_action', action });
  }
};

exports.setupMatchServer = setupMatchServer;
exports.aggregatePlayerStats = aggregatePlayerStats;
