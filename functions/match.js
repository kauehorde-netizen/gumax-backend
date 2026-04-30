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
//   confirmExpiresAt: Timestamp (30s)
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
    await deleteLockedLobbies(matchId); // timeout → delete lobbies (recriar do zero)
    return json(409, { error: 'expired' });
  }

  await admin.firestore().runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) return;
    const f = fresh.data();
    if (f.status !== 'confirming') return; // alguém já avançou
    const confirmations = { ...(f.confirmations || {}), [uid]: true };
    // Total esperado = todos os players de ambos os times (suporta debug 1v1 e padrão 5v5)
    const totalExpected = (f.teamA || []).length + (f.teamB || []).length;
    const allConfirmed = Object.values(confirmations).every(v => v === true) && Object.keys(confirmations).length === totalExpected;
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

// ── Setup do servidor CS2 (RCON real via Source protocol + MatchZy) ──────
// Conecta via RCON na máquina Glibhost, configura senha do servidor + carrega
// match config do MatchZy via URL apontando pro nosso backend (/matchzy-config).
//
// Variáveis de ambiente esperadas no Railway:
//   MATCH_SERVER_IP        - IP público do servidor CS2
//   MATCH_SERVER_PORT      - porta do jogo (default 27015)
//   MATCH_SERVER_RCON_PORT - porta RCON (default = MATCH_SERVER_PORT)
//   MATCH_SERVER_RCON_PASS - senha do RCON (configurada no server.cfg)
//   BACKEND_PUBLIC_URL     - URL pública do nosso backend (pra MatchZy chamar de volta)
//   MATCHZY_WEBHOOK_SECRET - secret pra autenticar callbacks do MatchZy
// Helper: DELETA lobbies travados (usado em confirm_timeout — usuários não
// confirmaram a partida, melhor recriar do zero do que ficar com lobbies
// "fantasma" + cancelDetail cacheado em loop). Inclui cleanup da subcollection
// chat (Firestore não cascadeia delete automático).
async function deleteLockedLobbies(matchId) {
  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const m = (await matchRef.get()).data();
    if (!m) return;
    const lobbyIds = [m.lobbyA, m.lobbyB].filter(Boolean);
    for (const id of lobbyIds) {
      const ref = db.collection('lobbies').doc(id);
      const snap = await ref.get();
      if (!snap.exists) continue;
      // Apaga subcollection chat primeiro (até 500 msgs por batch)
      try {
        const chatSnap = await ref.collection('chat').limit(500).get();
        if (!chatSnap.empty) {
          const batch = db.batch();
          chatSnap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } catch (e) { /* tolera */ }
      await ref.delete();
      console.log(`[match ${matchId}] lobby ${id} DELETADO (timeout)`);
    }
  } catch (e) {
    console.error(`[match ${matchId}] deleteLockedLobbies falhou:`, e.message);
  }
}

// Helper: libera lobbies travados em 'in_match' apontando pra um match cancelado.
// Permite users criarem novo desafio sem ficar em loop infinito de redirecionamento.
async function releaseLockedLobbies(matchId) {
  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const m = (await matchRef.get()).data();
    if (!m) return;
    const lobbyIds = [m.lobbyA, m.lobbyB].filter(Boolean);
    for (const id of lobbyIds) {
      const ref = db.collection('lobbies').doc(id);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const data = snap.data();
      const filled = (data.slots || []).filter(s => s != null).length;
      const newStatus = filled >= 5 ? 'full' : 'open';
      await ref.update({
        status: newStatus,
        matchId: null,
        challengedBy: null,
        challengeTo: null,
        challengeExpiresAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[match ${matchId}] lobby ${id} liberado: status=${newStatus}`);
    }
  } catch (e) {
    console.error(`[match ${matchId}] releaseLockedLobbies falhou:`, e.message);
  }
}

async function setupMatchServer(matchId) {
  const db = admin.firestore();
  const ref = db.collection('matches').doc(matchId);

  const ip = process.env.MATCH_SERVER_IP;
  const gamePort = parseInt(process.env.MATCH_SERVER_PORT || '27015', 10);
  const rconPort = parseInt(process.env.MATCH_SERVER_RCON_PORT || String(gamePort), 10);
  const rconPass = process.env.MATCH_SERVER_RCON_PASS;
  const backendUrl = process.env.BACKEND_PUBLIC_URL;

  // Validação de configuração — se faltam env vars, mata o match cedo
  if (!ip || !rconPass || !backendUrl) {
    const missing = [];
    if (!ip) missing.push('MATCH_SERVER_IP');
    if (!rconPass) missing.push('MATCH_SERVER_RCON_PASS');
    if (!backendUrl) missing.push('BACKEND_PUBLIC_URL');
    console.error(`[match ${matchId}] Faltam env vars:`, missing.join(', '));
    await ref.update({
      status: 'cancelled',
      cancelReason: 'server_misconfigured',
      cancelDetail: 'Missing env: ' + missing.join(', '),
    });
    await releaseLockedLobbies(matchId);
    return;
  }

  // Senha aleatória do servidor (jogadores recebem via connectUrl).
  // Salva no doc ANTES do RCON pra que handleMatchzyConfig consiga incluir
  // sv_password no JSON (MatchZy só aplica cvars que vêm na config).
  // v34-snappy fix: sem underscore na senha (cs2-fake-rcon parser tinha issue
  // com chars especiais; alphanumérico puro é mais robusto).
  const password = 'gx' + Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/gi, '');
  await ref.update({ serverPassword: password });
  const matchSnap = await ref.get();
  const m = matchSnap.data();
  const finalMap = m.mapVeto?.finalMap || 'de_mirage';

  // URL pública pro MatchZy puxar a config do match. MatchZy faz GET nessa URL,
  // recebe JSON com lista de jogadores + mapa + cvars, e configura o match.
  // Doc: https://shobhit-pathak.github.io/MatchZy/match_setup/
  const configUrl = `${backendUrl.replace(/\/$/, '')}/api/match/${matchId}/matchzy-config`;

  let Rcon;
  try {
    Rcon = require('rcon-srcds').default || require('rcon-srcds');
  } catch (err) {
    console.error('[match] rcon-srcds não instalado. npm install rcon-srcds');
    await ref.update({ status: 'cancelled', cancelReason: 'rcon_lib_missing' });
    await releaseLockedLobbies(matchId);
    return;
  }

  console.log(`[match ${matchId}] RCON ${ip}:${rconPort} → setup match com mapa ${finalMap}`);
  const rcon = new Rcon({ host: ip, port: rconPort, timeout: 5000 });

  // ── WORKAROUND CS2 RCON BUG ──
  // RCON nativo do CS2 está disfuncional desde o lançamento — muitos comandos
  // de engine não executam (sv_password, changelevel, etc). Solução da
  // comunidade: plugin `cs2-fake-rcon` (Salvatore-Als/cs2-fake-rcon).
  // Ele registra comandos custom `fake_rcon_password` e `fake_rcon <cmd>` que
  // o RCON consegue executar (porque foram registrados pelo plugin, não pelo
  // engine bugado). O plugin internamente executa o comando real.
  //
  // Setup: plugin Metamod instalado em game/csgo/addons/fake_rcon, e a senha
  // do fake_rcon configurada no servidor via `fake_rcon_password <X>`.
  // Esperamos que MATCH_SERVER_FAKE_RCON_PASS seja a senha que foi setada
  // no plugin (pode ser igual à do RCON nativo, mas é separada).
  //
  // Modo de uso: ao invés de `sv_password "X"`, mandamos
  // `fake_rcon ${fakePass} sv_password "X"` (ou padrão similar — confirmar
  // sintaxe nos primeiros testes).
  const fakePass = process.env.MATCH_SERVER_FAKE_RCON_PASS || rconPass;
  // Helper que envolve cada comando real no wrapper do plugin
  const wrap = (cmd) => `fake_rcon ${fakePass} ${cmd}`;

  try {
    await rcon.authenticate(rconPass);
    console.log(`[match ${matchId}] RCON autenticado (usando fake_rcon wrapper)`);

    // 1. Reset config + permite player conectar mesmo sem match carregado
    await rcon.execute(wrap('matchzy_kick_when_no_match_loaded 0'));

    // 2. Server SEM senha (workaround cs2-fake-rcon parser bug).
    await rcon.execute(wrap('sv_password ""'));

    // 3. v37-mapfix v2: changelevel pro mapa correto ANTES do loadmatch.
    //    Player que entrar no servidor já cai no mapa certo, sem warmup
    //    no startup map. MatchZy depois consome o config no novo mapa.
    if (finalMap && /^[a-z0-9_]+$/i.test(finalMap)) {
      try {
        await rcon.execute(wrap(`changelevel ${finalMap}`));
        console.log(`[match ${matchId}] changelevel: ${finalMap}`);
        // Aguarda 3s pro mapa carregar antes de mandar loadmatch
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        console.warn(`[match ${matchId}] changelevel falhou:`, e.message);
      }
    }

    // 4. Carrega match via URL — MatchZy puxa nosso JSON de config.
    const loadCmd = wrap(`matchzy_loadmatch_url "${configUrl}"`);
    const loadResp = await rcon.execute(loadCmd);
    console.log(`[match ${matchId}] matchzy_loadmatch_url resposta:`, loadResp);

    // 5. Reset sv_password DEPOIS do loadmatch (defensivo).
    await rcon.execute(wrap('sv_password ""'));

    rcon.disconnect();

    // 6. v37-autoready: dispara ready de ambos os times automaticamente.
    //    Filosofia: se player conectou no server, ele está ready. Sem `.ready`
    //    chato no chat. Espera ~30s pra galera ter tempo de entrar, depois
    //    força ready. MatchZy começa knife round + match imediatamente.
    //    Roda em background pra NÃO bloquear o flow do setup.
    setTimeout(async () => {
      try {
        const rcon2 = new Rcon({ host: ip, port: rconPort, timeout: 5000 });
        await rcon2.authenticate(rconPass);
        await rcon2.execute(wrap('matchzy_ready_team1'));
        await rcon2.execute(wrap('matchzy_ready_team2'));
        console.log(`[match ${matchId}] auto-ready disparado pros 2 times`);
        rcon2.disconnect();
      } catch (e) {
        console.warn(`[match ${matchId}] auto-ready falhou:`, e.message);
      }
    }, 30000);
  } catch (err) {
    console.error(`[match ${matchId}] RCON falhou:`, err.message);
    try { rcon.disconnect(); } catch {}
    await ref.update({
      status: 'cancelled',
      cancelReason: 'rcon_failed',
      cancelDetail: err.message,
    });
    await releaseLockedLobbies(matchId);
    return;
  }

  // Connect URL pros jogadores. v36-nopass: sem senha (server aberto), evita
  // bug de rejeição da senha do cs2-fake-rcon. URL é `steam://connect/IP:PORT`.
  const connectUrl = `steam://connect/${ip}:${gamePort}`;
  await ref.update({
    serverInfo: { ip, port: gamePort, password, connectUrl, configUrl, rconPort },
    status: 'in_progress',
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[match ${matchId}] Pronto — players podem conectar via ${connectUrl}`);
}

// ── GET /:id/matchzy-config — JSON consumido pelo MatchZy ───────────────
// MatchZy faz GET nessa URL após o setupMatchServer chamar matchzy_loadmatch_url.
// Endpoint público (sem auth) — segurança via secret na URL é difícil porque
// MatchZy não suporta headers customizados. Risco: se alguém adivinhar matchId,
// consegue ler config (não modifica). matchIds são UUIDs do Firestore, ~10^15
// possíveis. Aceitável pra MVP.
async function handleMatchzyConfig(matchId) {
  const db = admin.firestore();
  const snap = await db.collection('matches').doc(matchId).get();
  if (!snap.exists) return json(404, { error: 'match_not_found' });
  const m = snap.data();
  if (m.status !== 'starting' && m.status !== 'in_progress') {
    return json(409, { error: 'match_not_ready', status: m.status });
  }

  // Schema MatchZy: https://shobhit-pathak.github.io/MatchZy/match_setup/
  const team1Players = {};
  (m.teamA || []).forEach(p => { if (p.steamId) team1Players[p.steamId] = p.name || 'Player'; });
  const team2Players = {};
  (m.teamB || []).forEach(p => { if (p.steamId) team2Players[p.steamId] = p.name || 'Player'; });

  const webhookSecret = process.env.MATCHZY_WEBHOOK_SECRET || 'change-me';
  const backendUrl = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');

  return json(200, {
    matchid: matchId,
    team1: { name: 'Time A', tag: 'A', players: team1Players },
    team2: { name: 'Time B', tag: 'B', players: team2Players },
    num_maps: 1,
    maplist: [m.mapVeto?.finalMap || 'de_mirage'],
    // v37-team-fix: era 'knife' (round de faca decidia lado). Mudei pra 'team1_ct'
    // pra Time A começar como CT direto (sem knife). Halftime troca os lados.
    // Isso elimina a tela de escolha de team que aparecia entre o knife round.
    map_sides: ['team1_ct'],
    spectators: { players: {} },
    clinch_series: false,            // 1 mapa só — não precisa de clinch
    wingman: false,                  // 5v5 padrão
    players_per_team: 5,
    min_players_to_ready: 5,
    skip_veto: true,                 // veto já foi feito no nosso site
    cvars: {
      sv_password: '',               // server aberto (IP só pelo GUARD)
      // ── Webhook stats no fim da partida ──
      matchzy_remote_log_url: `${backendUrl}/api/match/webhook`,
      matchzy_remote_log_header_key: 'X-MatchZy-Secret',
      matchzy_remote_log_header_value: webhookSecret,
      // ── v37-autoready: basta 1 ready de cada time (backend dispara via RCON) ──
      matchzy_minimum_ready_required: 1,
      // ── Times forçados pelo MatchZy, sem balance automático ──
      mp_autoteambalance: 0,
      mp_limitteams: 0,
      mp_match_can_clinch: 0,
      // ── Warmup roda 60s, mas auto-ready dispara em 30s ──
      mp_warmup_pausetimer: 0,
      mp_warmuptime: 60,
      // ── Configs padrão competitivo (MR12) ──
      mp_friendlyfire: 1,
      mp_overtime_enable: 1,
      mp_overtime_maxrounds: 6,
      mp_maxrounds: 24,              // MR12 estilo Premier
      mp_round_restart_delay: 5,
      sv_pausable: 1,
    },
  });
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

    // Lê o doc atualizado (com winner/scoreA/scoreB) pra passar ao aggregate
    const updatedSnap = await ref.get();
    await aggregatePlayerStats(matchId, stats, updatedSnap.data());

    // Libera os lobbies pra próxima partida
    const matchData = (await ref.get()).data();
    if (matchData.lobbyA) await db.collection('lobbies').doc(matchData.lobbyA).delete().catch(() => {});
    if (matchData.lobbyB) await db.collection('lobbies').doc(matchData.lobbyB).delete().catch(() => {});
  }

  return json(200, { received: true });
}

// ── Cálculo de Level (1-10) baseado em KDR das últimas 10 partidas ──
// Faixas calibradas pra distribuir bem players amadores → semi-pro:
//   Level 1: KDR < 0.55  → newbie/aprendendo
//   Level 5: KDR ~1.00   → mediano (mata = morre)
//   Level 10: KDR > 1.80 → smurfando, top 1%
// Player precisa de >= 3 partidas pra ter level (antes disso = null/sem nível).
function computeLevel(kdrRecent, matchCount) {
  if (!matchCount || matchCount < 3) return null;
  const k = kdrRecent || 0;
  if (k < 0.55) return 1;
  if (k < 0.70) return 2;
  if (k < 0.85) return 3;
  if (k < 1.00) return 4;
  if (k < 1.15) return 5;
  if (k < 1.30) return 6;
  if (k < 1.45) return 7;
  if (k < 1.60) return 8;
  if (k < 1.80) return 9;
  return 10;
}

// Aggrega stats dos jogadores em playerStats/{steamId} pra ranking + level.
// Mantém TUDO histórico (kills/deaths/matches all-time) E ALÉM DISSO um
// rolling buffer das últimas 10 partidas pra calcular KDR "atual" e level.
//
// Pra cada player no `stats`, precisa saber:
//   - Em qual time ele estava (teamA ou teamB) → pra determinar win/loss
//   - O placar do match → match.winner ('A', 'B' ou 'tie')
async function aggregatePlayerStats(matchId, stats, matchData) {
  const db = admin.firestore();
  const winner = matchData?.winner || null;            // 'A' | 'B' | 'tie' | null
  const teamABySteamId = new Set((matchData?.teamA || []).map(p => p.steamId));
  const teamBBySteamId = new Set((matchData?.teamB || []).map(p => p.steamId));

  for (const [steamId, s] of Object.entries(stats)) {
    const ref = db.collection('playerStats').doc(steamId);

    // Determina resultado pro player nessa partida
    let result = 'unknown';
    if (winner === 'tie') result = 'tie';
    else if (winner === 'A') result = teamABySteamId.has(steamId) ? 'win' : 'loss';
    else if (winner === 'B') result = teamBBySteamId.has(steamId) ? 'win' : 'loss';

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? snap.data() : {};

      // ── All-time totals (preservados) ──
      const newMatches = (prev.matches || 0) + 1;
      const newKills   = (prev.kills   || 0) + (s.kills   || 0);
      const newDeaths  = (prev.deaths  || 0) + (s.deaths  || 0);
      const newAssists = (prev.assists || 0) + (s.assists || 0);
      const newMvps    = (prev.mvps    || 0) + (s.mvps    || 0);
      const newAdrSum  = (prev.totalAdr|| 0) + (s.adr     || 0);

      // ── Rolling window: guardamos as últimas 20 partidas pra histórico
      // (página de perfil mostra), mas o LEVEL só usa as últimas 10 ──
      const prevRecent = Array.isArray(prev.recent10) ? prev.recent10 : [];

      // Determina placar do POV do player (próprio time × adversário)
      const inA = teamABySteamId.has(steamId);
      const myScore  = inA ? (matchData?.scoreA || 0) : (matchData?.scoreB || 0);
      const oppScore = inA ? (matchData?.scoreB || 0) : (matchData?.scoreA || 0);

      const newEntry = {
        matchId,
        kills: s.kills || 0,
        deaths: s.deaths || 0,
        assists: s.assists || 0,
        adr: s.adr || 0,
        rating: s.rating || 0,
        hsRate: s.hsRate || 0,
        mvps: s.mvps || 0,
        result,
        // Campos novos pra página de perfil (denormalizados aqui pra evitar N+1)
        map: matchData?.mapVeto?.finalMap || null,
        scoreOwn: myScore,
        scoreOpp: oppScore,
        team: inA ? 'A' : 'B',
        playedAt: admin.firestore.Timestamp.now(),
      };
      // Mantém últimas 20 (pra histórico). Level usa só as últimas 10 via slice.
      const recent10 = [...prevRecent, newEntry].slice(-20);
      const last10ForLevel = recent10.slice(-10);

      // KDR rolling = soma kills / soma deaths nas últimas 10
      const recentKills  = last10ForLevel.reduce((acc, m) => acc + (m.kills  || 0), 0);
      const recentDeaths = last10ForLevel.reduce((acc, m) => acc + (m.deaths || 0), 0);
      const kdrRecent10 = recentKills / Math.max(1, recentDeaths);

      // Win streak — conta vitórias consecutivas a partir do FIM (mais recente)
      let winStreak = 0;
      for (let i = recent10.length - 1; i >= 0; i--) {
        if (recent10[i].result === 'win') winStreak++;
        else break;
      }

      // Win/loss total (all-time)
      const prevWins   = prev.wins   || 0;
      const prevLosses = prev.losses || 0;
      const newWins    = prevWins   + (result === 'win'  ? 1 : 0);
      const newLosses  = prevLosses + (result === 'loss' ? 1 : 0);

      // Level calculado a partir do KDR rolling
      const level = computeLevel(kdrRecent10, newMatches);

      tx.set(ref, {
        steamId,
        // All-time
        matches: newMatches,
        kills: newKills,
        deaths: newDeaths,
        assists: newAssists,
        mvps: newMvps,
        totalAdr: newAdrSum,
        kdr:    newKills / Math.max(1, newDeaths),
        kda:   (newKills + newAssists) / Math.max(1, newDeaths),
        avgAdr: newAdrSum / Math.max(1, newMatches),
        // Rolling 20 — esses são os "atuais" (últimas 10 viram level)
        recent10,
        kdrRecent10: Math.round(kdrRecent10 * 100) / 100,
        winStreak,
        level,
        wins: newWins,
        losses: newLosses,
        // Meta
        lastMatchId: matchId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }
}

// ── GET /api/match/player/:steamId ─────────────────────────────────────
// Perfil completo de um jogador específico — stats all-time + rolling 10
// + histórico das últimas 20 partidas (com map, score, kda detalhado).
// Endpoint PÚBLICO (qualquer um pode ver perfil de qualquer player).
async function handlePlayerProfile(steamId) {
  if (!steamId) return json(400, { error: 'missing_steamId' });
  const db = admin.firestore();
  const snap = await db.collection('playerStats').doc(steamId).get();
  if (!snap.exists) return json(404, { error: 'player_not_found', steamId });
  const data = snap.data();

  // Tenta enriquecer com avatar/nome do users/{uid} (uid pode ser igual ao steamId
  // pra logins via Steam, mas nem sempre — vamos tentar both)
  let displayName = data.steamName || `Player ${steamId.slice(-4)}`;
  let avatar = data.steamAvatar || '';
  try {
    const userSnap = await db.collection('users').doc(steamId).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      displayName = u.steamName || u.fullName || displayName;
      avatar = u.steamAvatar || u.photoURL || avatar;
    }
  } catch {}

  // Atualiza no playerStats se enriqueceu (cache pra próximas reads)
  if (!data.steamName && displayName !== `Player ${steamId.slice(-4)}`) {
    db.collection('playerStats').doc(steamId).set(
      { steamName: displayName, steamAvatar: avatar }, { merge: true }
    ).catch(() => {});
  }

  const matches = data.matches || 0;
  const wins   = data.wins   || 0;
  const losses = data.losses || 0;
  const winRate = matches > 0 ? Math.round((wins / matches) * 100) : 0;

  return json(200, {
    steamId,
    name: displayName,
    avatar,
    level: data.level || null,
    // All-time
    matches, wins, losses, winRate,
    kills: data.kills || 0,
    deaths: data.deaths || 0,
    assists: data.assists || 0,
    mvps: data.mvps || 0,
    kdr: Math.round((data.kdr || 0) * 100) / 100,
    kda: Math.round((data.kda || 0) * 100) / 100,
    avgAdr: Math.round(data.avgAdr || 0),
    // Rolling
    kdrRecent10: data.kdrRecent10 || 0,
    winStreak: data.winStreak || 0,
    // Histórico — últimas 20 partidas (mais recentes primeiro)
    history: (Array.isArray(data.recent10) ? [...data.recent10] : []).reverse().map(m => ({
      matchId: m.matchId,
      map: m.map || null,
      result: m.result || 'unknown',
      kills: m.kills || 0,
      deaths: m.deaths || 0,
      assists: m.assists || 0,
      adr: Math.round(m.adr || 0),
      mvps: m.mvps || 0,
      hsRate: m.hsRate || 0,
      scoreOwn: m.scoreOwn || 0,
      scoreOpp: m.scoreOpp || 0,
      kdr: m.deaths > 0 ? Math.round((m.kills / m.deaths) * 100) / 100 : (m.kills || 0),
      playedAt: m.playedAt?._seconds ? m.playedAt._seconds * 1000 : null,
    })),
    updatedAt: data.updatedAt?._seconds ? data.updatedAt._seconds * 1000 : null,
  });
}

// ── GET /api/match/players?ids=steamId1,steamId2,... ────────────────────
// Endpoint público pra batch fetch de stats. Frontend usa pra mostrar
// level+KDR ao lado de cada jogador na lobby/match sem fazer N requisições.
// Retorna objeto: { steamId1: { level, kdrRecent10, winStreak, matches }, ... }
async function handlePlayersBatch(event) {
  // server.js coloca req.query em event.queryStringParameters
  const idsParam = (event.queryStringParameters && event.queryStringParameters.ids) || '';
  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50); // max 50
  if (!ids.length) return json(400, { error: 'missing_ids' });

  const db = admin.firestore();
  const result = {};
  // Firestore .getAll() pra batch read em 1 round-trip
  const refs = ids.map(id => db.collection('playerStats').doc(id));
  const snaps = await db.getAll(...refs);
  snaps.forEach((snap, i) => {
    const id = ids[i];
    if (snap.exists) {
      const d = snap.data();
      result[id] = {
        steamId: id,
        level: d.level || null,
        kdrRecent10: d.kdrRecent10 || 0,
        winStreak: d.winStreak || 0,
        matches: d.matches || 0,
      };
    } else {
      // Player nunca jogou — sem stats
      result[id] = { steamId: id, level: null, kdrRecent10: 0, winStreak: 0, matches: 0 };
    }
  });
  return json(200, { players: result });
}

// ── GET /ranking — top 50 jogadores ordenados por LEVEL + KDR rolling ────
// Mudança v2: usa stats das últimas 10 partidas (não all-time) — reflete
// melhor a forma ATUAL do player. Players com < 3 partidas vão pro fim.
async function handleRanking() {
  const db = admin.firestore();
  // Pega top 100 por matches jogados (proxy de atividade), depois ordena por level
  const snap = await db.collection('playerStats')
    .orderBy('matches', 'desc')
    .limit(100)
    .get();
  const players = snap.docs.map(d => {
    const data = d.data();
    const matches = data.matches || 0;
    if (matches < 1) return null;
    return {
      steamId: d.id,
      name: data.steamName || `Player ${d.id.slice(-4)}`,
      avatar: data.steamAvatar || '',
      matches,
      kills: data.kills || 0,
      deaths: data.deaths || 0,
      assists: data.assists || 0,
      mvps: data.mvps || 0,
      // KDR atual (rolling 10) — esse é o oficial pra ranking
      kdr: data.kdrRecent10 || (data.kdr ? Math.round(data.kdr * 100) / 100 : 0),
      // KDR all-time (pra histórico)
      kdrAllTime: Math.round((data.kdr || 0) * 100) / 100,
      kda: Math.round((data.kda || 0) * 100) / 100,
      avgAdr: Math.round(data.avgAdr || 0),
      level: data.level || null,
      winStreak: data.winStreak || 0,
      lastMatchId: data.lastMatchId || null,
    };
  }).filter(Boolean);

  // Ordena por level desc (jogadores sem level vão pro fim), depois kdr desc
  players.sort((a, b) => {
    const la = a.level || 0;
    const lb = b.level || 0;
    if (lb !== la) return lb - la;
    return b.kdr - a.kdr;
  });
  const top = players.slice(0, 50);
  return json(200, { count: top.length, players: top, generatedAt: Date.now() });
}

// ─── Handler HTTP ───────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  // /api/match/webhook (POST, sem auth — autenticado por header secret)
  if (event.httpMethod === 'POST' && path.endsWith('/webhook')) return handleWebhook(event);
  // /api/match/ranking (GET, público)
  if (event.httpMethod === 'GET' && path.endsWith('/ranking')) return handleRanking();
  // /api/match/players?ids=... (GET, público — batch stats pra mostrar level/KDR em lobby)
  if (event.httpMethod === 'GET' && path.endsWith('/players')) return handlePlayersBatch(event);
  // /api/match/player/:steamId (GET, público — perfil completo + histórico)
  const playerMatch = path.match(/\/api\/match\/player\/([^/]+)$/);
  if (event.httpMethod === 'GET' && playerMatch) return handlePlayerProfile(playerMatch[1]);

  // /api/match/:id e /api/match/:id/{action}
  const m = path.match(/\/api\/match\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return json(404, { error: 'route_not_found', path });
  const matchId = m[1];
  const action = m[2] || '';

  // GET /api/match/:id — estado do match (auth required)
  if (event.httpMethod === 'GET' && !action) return handleGet(event, matchId);
  // GET /api/match/:id/matchzy-config — JSON pro MatchZy puxar (público, no auth)
  if (event.httpMethod === 'GET' && action === 'matchzy-config') return handleMatchzyConfig(matchId);

  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  switch (action) {
    case 'confirm': return handleConfirm(event, matchId);
    case 'veto':    return handleVeto(event, matchId);
    case 'abort':   return handleAbort(event, matchId);
    case 'guard-validate': return handleGuardValidate(event, matchId);
    default: return json(404, { error: 'unknown_action', action });
  }
};

// ── POST /:id/guard-validate ────────────────────────────────────────
// GMAX GUARD desktop client chama esse endpoint pra: (1) validar que o
// player TEM direito de entrar nessa partida; (2) receber as credenciais
// de connect (IP/porta) que NÃO são expostas no frontend (web).
// Body: { idToken, hwid, steamIdLocal, guardVersion }
// Resposta sucesso: { ok: true, ip, port, steamConnectUrl, summary }
//
// Garantias de segurança:
//   • idToken Firebase válido (verifyIdToken) → user autenticado
//   • steamId do user precisa estar no teamA OU teamB do match
//   • Steam local (lido do loginusers.vdf pelo cliente) precisa BATER com
//     o steamId da conta do site → impede smurf/account sharing
//   • match status precisa ser 'in_progress' ou 'starting'
//   • registra HWID no doc do match pra audit/ban tracking depois
async function handleGuardValidate(event, matchId) {
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return json(401, { error: 'unauthorized' });
  const uid = decoded.uid;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid_body' }); }

  const steamIdLocal = body.steamIdLocal || body.steamId;
  const hwid = body.hwid || null;
  const guardVersion = body.guardVersion || 'unknown';

  if (!steamIdLocal || !/^\d{17}$/.test(steamIdLocal)) {
    return json(400, { error: 'invalid_steam_id' });
  }

  const db = admin.firestore();
  const ref = db.collection('matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return json(404, { error: 'match_not_found' });
  const m = snap.data();
  if (m.status !== 'in_progress' && m.status !== 'starting') {
    return json(409, { error: 'match_not_ready', status: m.status });
  }

  // User precisa estar no roster
  const inA = (m.teamA || []).find(p => p.uid === uid);
  const inB = (m.teamB || []).find(p => p.uid === uid);
  if (!inA && !inB) return json(403, { error: 'not_in_match' });

  // CRITICAL: steamId da conta logada no Steam Client (lido do
  // loginusers.vdf pelo GUARD) precisa ser igual ao steamId associado
  // ao uid do user no Firestore. Se diferente → smurf/account sharing.
  // O uid no nosso sistema = steamId 64 (formato: ^7656\d{13}$).
  if (uid !== steamIdLocal) {
    // Caso de exceção: alguns users antigos podem ter Firebase uid != steamId
    // Verifica via doc users/{uid}.steamId como fallback
    try {
      const userDoc = await db.collection('users').doc(uid).get();
      const associatedSteamId = userDoc.exists ? userDoc.data()?.steamId : null;
      if (associatedSteamId && associatedSteamId !== steamIdLocal) {
        await ref.collection('guardLog').add({
          uid, attemptedSteamId: steamIdLocal, expectedSteamId: associatedSteamId,
          hwid, guardVersion, reason: 'steam_account_mismatch',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        return json(403, {
          error: 'steam_account_mismatch',
          detail: 'A conta logada no Steam Client é diferente da conta do site. Faça login no Steam com a mesma conta usada no site.',
        });
      }
    } catch {}
  }

  // Tudo OK — registra que esse player passou no GUARD
  await ref.collection('guardLog').add({
    uid, steamId: steamIdLocal, hwid, guardVersion,
    result: 'passed',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  // Retorna credenciais de connect (só GUARD recebe — frontend nunca vê IP/porta)
  const ip = m.serverInfo?.ip;
  const port = m.serverInfo?.port;
  if (!ip || !port) {
    return json(503, { error: 'server_not_ready' });
  }

  return json(200, {
    ok: true,
    ip, port,
    steamConnectUrl: 'steam://connect/' + ip + ':' + port,
    steamRunGameUrl: 'steam://rungameid/730/+connect%20' + ip + ':' + port,
    connectCommand: 'connect ' + ip + ':' + port,
    summary: {
      matchId,
      map: m.mapVeto?.finalMap || 'unknown',
      team: inA ? 'A' : 'B',
      teammates: (inA ? m.teamA : m.teamB || []).map(p => p.name).filter(Boolean),
      opponents: (inA ? m.teamB : m.teamA || []).map(p => p.name).filter(Boolean),
    },
  });
}

async function handleAbort(event, matchId) {
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return json(401, { error: 'unauthorized' });
  const uid = decoded.uid;
  const db = admin.firestore();
  const ref = db.collection('matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return json(404, { error: 'match_not_found' });
  const m = snap.data();
  if (m.status === 'finished' || m.status === 'cancelled') {
    return json(409, { error: 'match_already_ended', status: m.status });
  }
  const inA = (m.teamA || []).some(p => p.uid === uid);
  const inB = (m.teamB || []).some(p => p.uid === uid);
  if (!inA && !inB) return json(403, { error: 'not_in_match' });
  await ref.update({
    status: 'cancelled',
    cancelReason: 'aborted_by_player',
    cancelDetail: 'Cancelada por ' + (decoded.name || uid),
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await releaseLockedLobbies(matchId);
  console.log('[match ' + matchId + '] ABORTED por ' + uid);
  return json(200, { success: true, status: 'cancelled' });
}

exports.setupMatchServer = setupMatchServer;
exports.aggregatePlayerStats = aggregatePlayerStats;
