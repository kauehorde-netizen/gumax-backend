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
//     pool: ['de_mirage','de_inferno','de_dust2','de_nuke','de_anubis','de_ancient','de_cache','de_train'],
//     actions: [{ team:'A', action:'ban', map:'de_dust2', at:ts }, ...],
//     activeTeam: 'A' | 'B',
//     turn: 0..7,           // 0..6 = bans alternados (A começa e encerra), 7 = mapa final
//     finalMap: 'de_mirage' | null,
//   }
//   serverInfo: { ip, port, password, connectUrl } | null
//   scoreA, scoreB, stats
//   createdAt, finishedAt

const admin = require('firebase-admin');
// v38-rating: sistema CS Rating Premier-style (calibração 3 partidas + Elo modificado)
const rating = require('./rating');

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
//    A:ban → B:ban → A:ban → B:ban → A:ban → B:ban → A:ban → último mapa restante = pick
//    8 mapas (Cache adicionado em 28/abr/2026) → 7 bans → 1 sobra
//    A inicia E encerra (4 bans pra A, 3 pra B). Time A = challenger; pequena
//    vantagem pra quem "puxou" o desafio. Aceitável em casual; rotacionar em fase 2.
// Pra simplificar UI, capitão = owner do lobby. Em fase 2 podemos rotacionar.
const VETO_SEQUENCE = [
  { team: 'A', action: 'ban' },
  { team: 'B', action: 'ban' },
  { team: 'A', action: 'ban' },
  { team: 'B', action: 'ban' },
  { team: 'A', action: 'ban' },
  { team: 'B', action: 'ban' },
  { team: 'A', action: 'ban' },
  // turn 7: mapa restante vira pick automaticamente (não tem ação do capitão)
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

// v48-scoreboard: GET /api/match/:id/scoreboard — PUBLICO (sem auth).
// Retorna so dados nao-sensiveis pra renderizar scoreboard do historico.
// Filtra serverInfo/password/confirmations.
async function handleScoreboard(matchId) {
  const db = admin.firestore();
  const snap = await db.collection('matches').doc(matchId).get();
  if (!snap.exists) return json(404, { error: 'match_not_found' });
  const d = snap.data();
  // Sanitiza teamA/teamB pra remover qualquer campo sensivel
  const cleanPlayer = (p) => ({
    uid: p.uid || null,
    steamId: p.steamId || null,
    name: p.name || 'Player',
    avatar: p.avatar || '',
  });
  const teamA = (d.teamA || []).map(cleanPlayer);
  const teamB = (d.teamB || []).map(cleanPlayer);
  // Stats por steamId
  const stats = d.stats || {};
  return json(200, {
    id: matchId,
    status: d.status || null,
    winner: d.winner || null,
    scoreA: d.scoreA || 0,
    scoreB: d.scoreB || 0,
    teamA, teamB,
    map: d.mapVeto?.finalMap || null,
    mapVeto: {
      pool: d.mapVeto?.pool || [],
      actions: d.mapVeto?.actions || [],
      finalMap: d.mapVeto?.finalMap || null,
    },
    stats,                  // { steamId: { kills, deaths, assists, adr, hsRate, mvps, rating, headshotKills } }
    demoUrl: d.demoUrl || null,
    createdAt: d.createdAt?._seconds ? d.createdAt._seconds * 1000 : null,
    finishedAt: d.finishedAt?._seconds ? d.finishedAt._seconds * 1000 : null,
  });
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
        // v38-persist: marca quando match acabou pra cleanup dar cooldown extra
        // de 15min antes de deletar (em vez de comer o lobby porque tem >20min
        // de createdAt). Permite players voltarem pro lobby pós-partida.
        matchEndedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[match ${matchId}] lobby ${id} liberado: status=${newStatus} matchEndedAt=now`);
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

  // ── RCON wrapper (com ou sem fake_rcon) ──
  // v38-rcon-mode: hosts antigos (Glibhost) tinham bug no RCON nativo do CS2 e
  // a gambiarra era usar o plugin cs2-fake-rcon (Salvatore-Als). Hosts modernos
  // (DatHost) têm RCON nativo funcional. Por isso o wrapper agora é OPT-IN via
  // env var. Default = false (RCON nativo). Pra forçar fake_rcon: set
  // MATCH_SERVER_USE_FAKE_RCON=true e configurar `fake_rcon_password <X>` no .cfg.
  const USE_FAKE_RCON = process.env.MATCH_SERVER_USE_FAKE_RCON === 'true';
  const fakePass = process.env.MATCH_SERVER_FAKE_RCON_PASS || rconPass;
  const wrap = USE_FAKE_RCON
    ? (cmd) => `fake_rcon ${fakePass} ${cmd}`
    : (cmd) => cmd;

  try {
    await rcon.authenticate(rconPass);
    console.log(`[match ${matchId}] RCON autenticado (mode=${USE_FAKE_RCON ? 'fake_rcon' : 'native'})`);

    // 1. Reset config + permite player conectar mesmo sem match carregado
    await rcon.execute(wrap('matchzy_kick_when_no_match_loaded 0'));

    // 2. Server SEM senha (player conecta via steam://connect/ip:port direto).
    await rcon.execute(wrap('sv_password ""'));

    // 3. Trocar mapa pro picado no veto.
    //
    // v38-mapfix v3: tenta 3 comandos em sequência (workshop / matchzy / legacy)
    // e cancela o match com erro claro se TODOS falharem. Antes era silencioso
    // e o player entrava no mapa errado.
    if (finalMap && /^[a-z0-9_]+$/i.test(finalMap)) {
      const shortMap = finalMap.replace(/^de_/, '');
      // v38-mapfix v4: ordem invertida — changelevel primeiro (DatHost usa
      // Local/Official Maps, mapas locais bundled). Workshop só pra hosts
      // com host_workshop_collection. matchzy é última opção.
      //
      // Heurística de sucesso: resposta com keyword de erro = falha clara,
      // próximo candidate. Resposta vazia ou normal = trata como sucesso
      // (CS2 RCON tipicamente NÃO retorna stdout em changelevel quando ok).
      const errorPatterns = /couldn['’]?t load|cant find|can['’]?t find|missing|not found|invalid map|unknown command|map.*not.*available|no\s+such\s+map/i;

      const candidates = [
        { cmd: `changelevel ${finalMap}`, label: 'legacy' },
        { cmd: `ds_workshop_changelevel ${shortMap}`, label: 'workshop' },
        { cmd: `matchzy_changemap ${finalMap}`, label: 'matchzy' },
      ];

      let mapChanged = false;
      let lastErr = '';
      for (const { cmd, label } of candidates) {
        try {
          const resp = await rcon.execute(wrap(cmd));
          const respStr = String(resp || '').trim();
          console.log(`[match ${matchId}] map-change [${label}] "${cmd}" → resp(${respStr.length}b): ${respStr.slice(0, 300)}`);
          if (errorPatterns.test(respStr)) {
            lastErr = `[${label}] ${respStr.slice(0, 200)}`;
            console.warn(`[match ${matchId}] tentativa ${label} REJEITADA: ${respStr.slice(0, 200)}`);
            continue;
          }
          mapChanged = true;
          console.log(`[match ${matchId}] map-change SUCESSO via ${label} (resp ${respStr.length === 0 ? 'vazia' : 'normal'})`);
          break;
        } catch (e) {
          lastErr = `[${label}] ${e.message}`;
          console.warn(`[match ${matchId}] tentativa ${label} EXCEPTION: ${e.message}`);
          try { await rcon.authenticate(rconPass); } catch {}
        }
      }

      if (!mapChanged) {
        console.error(`[match ${matchId}] TODAS tentativas de troca de mapa falharam: ${lastErr}`);
        try { rcon.disconnect(); } catch {}
        await ref.update({
          status: 'cancelled',
          cancelReason: 'map_change_failed',
          cancelDetail: `Servidor não conseguiu trocar pro mapa "${finalMap}". Última falha: ${lastErr}`,
        });
        await releaseLockedLobbies(matchId);
        return;
      }

      // Aguarda 8s pro mapa carregar (changelevel CS2 demora pra terminar)
      await new Promise(r => setTimeout(r, 8000));
    }

    // 4. Carrega match via URL — MatchZy puxa nosso JSON de config.
    // v38-mapfix v4: se MatchZy responder "Match load failed", o servidor não
    // conseguiu fazer GET no nosso configUrl OU o JSON está malformado pro
    // MatchZy. Loga URL pra debug.
    console.log(`[match ${matchId}] configUrl: ${configUrl}`);
    const loadCmd = wrap(`matchzy_loadmatch_url "${configUrl}"`);
    const loadResp = await rcon.execute(loadCmd);
    const loadRespStr = String(loadResp || '').trim();
    console.log(`[match ${matchId}] matchzy_loadmatch_url resp(${loadRespStr.length}b): ${loadRespStr.slice(0, 500)}`);
    if (/match load failed|invalid config|json.*error|parse.*error/i.test(loadRespStr)) {
      console.error(`[match ${matchId}] MATCHZY REJEITOU O CONFIG! URL=${configUrl}`);
      // Não cancela ainda — o user pode usar comandos manuais. Mas alerta.
    }

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
  const ref = db.collection('matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return json(404, { error: 'match_not_found' });
  const m = snap.data();
  if (m.status !== 'starting' && m.status !== 'in_progress') {
    return json(409, { error: 'match_not_ready', status: m.status });
  }

  // v38-mz-id-fix: MatchZy v0.8.x EXIGE matchid NUMÉRICO (não string).
  // Documentação: "matchid: A unique numeric ID for the match"
  // Antes mandávamos o ID Firestore (string) → MatchZy rejeitava com
  // "Match load failed!" e caía em modo PUG (sem nosso config).
  // Agora geramos numId baseado no timestamp createdAt em ms (sempre único,
  // sempre integer) e salvamos pra webhook reverse-lookup.
  // v38-mz-id-fix v2: MatchZy valida matchid como int32 (max 2.147 bi).
  // Antes usávamos timestamp em ms (~1.7 trilhões) → estourava int32 →
  // validação failed → "Match load failed!". Agora usa SEGUNDOS (~1.78 bi),
  // cabe folgado em int32 até 2038. Source MatchZy MatchManagement.cs:
  //   if (!int.TryParse(jsonData[field], out numMaps)) return error;
  let matchzyId = m.matchzyId;
  // Se o matchzyId existente é > int32 max (deploy antigo), regenera
  if (matchzyId && matchzyId > 2147483647) {
    matchzyId = null;
    console.log(`[matchzy-config] ${matchId} matchzyId antigo (>int32) — regenerando`);
  }
  if (!matchzyId) {
    matchzyId = Math.floor((m.createdAt?.toMillis ? m.createdAt.toMillis() : Date.now()) / 1000);
    await ref.update({ matchzyId });
    console.log(`[matchzy-config] ${matchId} → matchzyId=${matchzyId} (segundos, fits int32)`);
  }

  // Schema MatchZy: https://shobhit-pathak.github.io/MatchZy/match_setup/
  const team1Players = {};
  (m.teamA || []).forEach(p => { if (p.steamId) team1Players[p.steamId] = p.name || 'Player'; });
  const team2Players = {};
  (m.teamB || []).forEach(p => { if (p.steamId) team2Players[p.steamId] = p.name || 'Player'; });

  // v40-flex-team-size: players_per_team e min_players_to_ready agora derivam
  // do tamanho real dos times (suporta 3v3, 4v4, 5v5). Antes era hard-code 5
  // → MatchZy travava em "Waiting for X players" se faltasse alguém.
  // Lógica: pega o MAIOR dos dois times (caso assimétrico) e bate teto em 5.
  const sizeA = Object.keys(team1Players).length;
  const sizeB = Object.keys(team2Players).length;
  const teamSize = Math.min(5, Math.max(1, sizeA, sizeB)) || 5;

  const webhookSecret = process.env.MATCHZY_WEBHOOK_SECRET || 'change-me';
  const backendUrl = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');

  console.log(`[matchzy-config] ${matchId} → team1=${sizeA} team2=${sizeB} → players_per_team=${teamSize}`);

  return json(200, {
    matchid: matchzyId,
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
    wingman: false,                  // wingman é 2v2 num mapa só, mantemos false
    players_per_team: teamSize,      // dinâmico: 3, 4 ou 5
    min_players_to_ready: teamSize,  // só ready quando todos chegarem
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
      // ── v38-team-lock: garante que players caem no time CERTO ──
      // MatchZy já força via SwitchPlayerTeam quando isMatchSetup=true,
      // mas se algo der errado, esses cvars reforçam:
      bot_quota: 0,                  // zero bots — sem confusão de slot
      mp_team_join: 0,               // bloqueia "join team" via menu (CT/T/spec)
      mp_join_grace_time: 0,         // não dá grace pra entrar no time errado
      // ── Pausa warmup até todos estarem no time certo ──
      // (auto-ready do nosso backend dispara depois que MatchZy força os times)
      mp_warmup_offline_enabled: 1,
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
  // MatchZy manda matchid INTEGER (createdAt ms gerado em handleMatchzyConfig).
  // Reverse-lookup: matches WHERE matchzyId == X → encontra o doc com ID Firestore.
  const matchzyMatchId = body.match_id || body.matchId || body.matchid;
  if (!matchzyMatchId) return json(400, { error: 'missing_match_id' });
  console.log(`[webhook] recebido pra matchzyId=${matchzyMatchId}, evento=${body.event || body.type || '?'}`);

  const db = admin.firestore();
  // v38-mz-id-fix: matchzyMatchId é integer; faz query reversa no campo matchzyId
  let snap, ref;
  const lookupSnap = await db.collection('matches')
    .where('matchzyId', '==', Number(matchzyMatchId))
    .limit(1).get();
  if (lookupSnap.empty) {
    // Fallback: tenta como ID Firestore direto (pra não quebrar matches antigos)
    ref = db.collection('matches').doc(String(matchzyMatchId));
    snap = await ref.get();
  } else {
    snap = lookupSnap.docs[0];
    ref = snap.ref;
  }
  if (!snap.exists) {
    console.warn(`[webhook] match não encontrado: matchzyId=${matchzyMatchId}`);
    return json(404, { error: 'match_not_found' });
  }
  console.log(`[webhook] resolvido pra Firestore matchId=${ref.id}`);

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
        headshotKills: p.headshot_kills || 0,  // v41-stats-adv: pra somar HS% all-time
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
    await aggregatePlayerStats(ref.id, stats, updatedSnap.data());

    // v38-persist: libera lobbies (NÃO deleta!) com matchEndedAt setado
    // pra cleanupStaleLobbies dar 15min de cooldown antes de remover.
    // Permite players voltarem pro lobby pós-partida sem ele sumir.
    await releaseLockedLobbies(ref.id);
    console.log(`[webhook] match ${ref.id} finalizado, lobbies liberados (cooldown 15min)`);
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

  // v38-rating: pre-fetch dos ratings ANTES do match pra calcular skillDiff
  // (precisa do rating do oponente ANTES do delta dessa partida ser aplicado).
  // 1 read batch em vez de N reads dentro do loop.
  const allSteamIds = [...teamABySteamId, ...teamBBySteamId];
  const preMatchRatings = {};
  for (const sid of allSteamIds) {
    try {
      const psSnap = await db.collection('playerStats').doc(sid).get();
      preMatchRatings[sid] = psSnap.exists ? (psSnap.data().csRating ?? null) : null;
    } catch { preMatchRatings[sid] = null; }
  }
  const teamARatings = (matchData?.teamA || []).map(p => preMatchRatings[p.steamId]).filter(r => r != null);
  const teamBRatings = (matchData?.teamB || []).map(p => preMatchRatings[p.steamId]).filter(r => r != null);
  const teamAAvg = teamARatings.length ? (teamARatings.reduce((a,b)=>a+b,0) / teamARatings.length) : 5000;
  const teamBAvg = teamBRatings.length ? (teamBRatings.reduce((a,b)=>a+b,0) / teamBRatings.length) : 5000;

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

      // newEntry é construída DEPOIS do delta (ver mais abaixo). Inicializa
      // o "esqueleto" aqui pra ficar visível antes do bloco de rating.
      const baseEntry = {
        matchId,
        kills: s.kills || 0,
        deaths: s.deaths || 0,
        assists: s.assists || 0,
        adr: s.adr || 0,
        rating: s.rating || 0,
        hsRate: s.hsRate || 0,
        headshotKills: s.headshotKills || 0,  // v41-stats-adv
        mvps: s.mvps || 0,
        result,
        // Campos novos pra página de perfil (denormalizados aqui pra evitar N+1)
        map: matchData?.mapVeto?.finalMap || null,
        scoreOwn: myScore,
        scoreOpp: oppScore,
        team: inA ? 'A' : 'B',
        playedAt: admin.firestore.Timestamp.now(),
      };
      // ── v38-rating: CS Rating Premier-style ──
      // Primeiras 3 partidas = calibração (csRating fica null, acumula em
      // calibrationMatches[]). Após 3ª, calcula rating inicial.
      // Da 4ª em diante, aplica delta baseado em Elo modificado.
      let newCsRating = prev.csRating ?? null;
      let newCalibrationMatches = Array.isArray(prev.calibrationMatches) ? [...prev.calibrationMatches] : [];
      let lastDelta = 0;

      const calibEntry = {
        result, kills: s.kills || 0, deaths: s.deaths || 0, assists: s.assists || 0,
      };

      if (newMatches <= 3) {
        newCalibrationMatches.push(calibEntry);
        if (newMatches === 3) {
          newCsRating = rating.calibrationRating(newCalibrationMatches);
          console.log(`[rating] ${steamId} calibrou após 3 jogos: ${newCsRating} pts`);
        }
      } else {
        // Pós-calibração: aplica delta. Se csRating for null aqui (ex: doc antigo
        // sem calibração), começa em 5000 (Prata baixo).
        const ownAvg = inA ? teamAAvg : teamBAvg;
        const oppAvg = inA ? teamBAvg : teamAAvg;
        lastDelta = rating.calculateMatchDelta({
          won: result === 'win',
          ownTeamAvg: ownAvg,
          opponentTeamAvg: oppAvg,
          roundsScored: myScore,
          roundsConceded: oppScore,
          kills: s.kills || 0,
          deaths: s.deaths || 0,
          assists: s.assists || 0,
          mvps: s.mvps || 0,
        });
        const baseRating = (prev.csRating ?? 5000);
        newCsRating = Math.max(0, baseRating + lastDelta);
        console.log(`[rating] ${steamId} ${lastDelta >= 0 ? '+' : ''}${lastDelta} pts → ${newCsRating}`);
      }

      const tierInfo = rating.getTierForRating(newCsRating);

      // Agora que temos lastDelta calculado, monta a entry final do history
      const newEntry = { ...baseEntry, delta: lastDelta };
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

        // v38-rating: campos novos
        csRating: newCsRating,
        calibrationMatches: newCalibrationMatches,
        calibrating: newMatches < 3,
        calibrationProgress: Math.min(3, newMatches),
        tier: tierInfo.key,
        tierName: tierInfo.name,
        tierColor: tierInfo.color,
        lastDelta,    // pra mostrar no pós-match
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
    // v38-rating: campos novos do CS Rating Premier-style
    csRating: data.csRating ?? null,
    calibrating: data.calibrating ?? (matches < 3),
    calibrationProgress: data.calibrationProgress ?? Math.min(3, matches),
    tier: data.tier || (data.csRating != null ? 'gray' : 'calibrating'),
    tierName: data.tierName || 'Bronze',
    tierColor: data.tierColor || '#9ca3af',
    lastDelta: data.lastDelta || 0,
    lastSeasonTier: data.lastSeasonTier || null,
    lastSeasonTierName: data.lastSeasonTierName || null,
    lastSeasonRating: data.lastSeasonRating || null,
    // v41-stats-adv: agregações derivadas do recent10
    advancedStats: (() => {
      const recent = Array.isArray(data.recent10) ? data.recent10 : [];
      if (!recent.length) return null;
      // HS% ponderado: total HSkills / total kills
      let totalKills = 0, totalHs = 0, totalAdr = 0, totalDeaths = 0;
      for (const m of recent) {
        totalKills  += (m.kills || 0);
        totalHs     += (m.headshotKills || 0);
        totalDeaths += (m.deaths || 0);
        totalAdr    += (m.adr || 0);
      }
      const hsPct = totalKills > 0 ? Math.round((totalHs / totalKills) * 100) : 0;
      const avgAdrRecent = recent.length > 0 ? Math.round(totalAdr / recent.length) : 0;

      // mapStats: agrupa por mapa
      const byMap = {};
      for (const m of recent) {
        if (!m.map) continue;
        if (!byMap[m.map]) byMap[m.map] = { map: m.map, played: 0, wins: 0, losses: 0, ties: 0, kills: 0, deaths: 0 };
        const ms = byMap[m.map];
        ms.played++;
        if (m.result === 'win') ms.wins++;
        else if (m.result === 'loss') ms.losses++;
        else if (m.result === 'tie') ms.ties++;
        ms.kills  += (m.kills || 0);
        ms.deaths += (m.deaths || 0);
      }
      const mapStats = Object.values(byMap).map(ms => ({
        ...ms,
        winRate: ms.played > 0 ? Math.round((ms.wins / ms.played) * 100) : 0,
        kdr: ms.deaths > 0 ? Math.round((ms.kills / ms.deaths) * 100) / 100 : (ms.kills || 0),
      })).sort((a,b) => b.played - a.played);
      // Melhor mapa: maior winRate entre os com >= 2 partidas
      const eligibleMaps = mapStats.filter(m => m.played >= 2);
      const bestMap = eligibleMaps.length
        ? [...eligibleMaps].sort((a,b) => b.winRate - a.winRate || b.played - a.played)[0]
        : (mapStats[0] || null);

      // weekdayStats: dia da semana (0=Dom, 1=Seg, ..., 6=Sab)
      const WEEKDAYS_PT = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
      const byWday = WEEKDAYS_PT.map((label, i) => ({ wday: i, label, played: 0, wins: 0 }));
      for (const m of recent) {
        const t = m.playedAt?._seconds ? m.playedAt._seconds * 1000 : null;
        if (!t) continue;
        const d = new Date(t).getDay();
        byWday[d].played++;
        if (m.result === 'win') byWday[d].wins++;
      }
      const weekdayStats = byWday.map(w => ({
        ...w,
        winRate: w.played > 0 ? Math.round((w.wins / w.played) * 100) : 0,
      }));
      const playedDays = weekdayStats.filter(w => w.played > 0);
      const bestWeekday = playedDays.length
        ? [...playedDays].sort((a,b) => b.winRate - a.winRate || b.played - a.played)[0]
        : null;

      return { hsPct, avgAdrRecent, mapStats, bestMap, weekdayStats, bestWeekday, sampleSize: recent.length };
    })(),
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
      delta: typeof m.delta === 'number' ? m.delta : 0,  // v41-history-delta
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
        // v38-rating: campos rating no batch (pra lobbies mostrarem tier do owner)
        csRating: d.csRating ?? null,
        calibrating: d.calibrating ?? ((d.matches || 0) < 3),
        calibrationProgress: d.calibrationProgress ?? Math.min(3, d.matches || 0),
        tier: d.tier || (d.csRating != null ? 'gray' : 'calibrating'),
        tierName: d.tierName || 'Calibrando',
        tierColor: d.tierColor || '#6b7280',
      };
    } else {
      // Player nunca jogou — sem stats
      result[id] = {
        steamId: id, level: null, kdrRecent10: 0, winStreak: 0, matches: 0,
        csRating: null, calibrating: true, calibrationProgress: 0,
        tier: 'calibrating', tierName: 'Calibrando', tierColor: '#6b7280',
      };
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
// ── POST /debug/simulate-match — cria match fake e dispara setupMatchServer ──
// v38-debug: ferramenta pra testar pipeline MatchZy sem precisar de 10 pessoas.
// Cria match com matchzyId em segundos, status='starting', e chama
// setupMatchServer direto. Útil pra validar se "Match load failed!" foi
// resolvido sem desperdiçar 40min jogando.
//
// Body: { secret: 'X', mapName: 'de_mirage' (opcional) }
// Response: { matchId, matchzyId, mapName }
//
// Verificar resultado nos Railway logs com filtro pelo matchId retornado.
async function handleDebugSimulateMatch(event) {
  // Auth simples: secret no body. NÃO expor publicamente — só pra debug interno.
  const body = JSON.parse(event.body || '{}');
  const expectedSecret = process.env.DEBUG_SECRET || process.env.MATCHZY_WEBHOOK_SECRET || '';
  if (!expectedSecret || body.secret !== expectedSecret) {
    return json(401, { error: 'invalid_secret', hint: 'pass body.secret matching DEBUG_SECRET or MATCHZY_WEBHOOK_SECRET env var' });
  }

  const mapName = body.mapName || 'de_mirage';
  if (!/^de_[a-z0-9_]+$/.test(mapName)) return json(400, { error: 'invalid_mapName' });

  const db = admin.firestore();

  // Cria 10 players fake com SteamIDs válidos (formato Steam ID 64)
  // SteamID 64 começa com 765611 + 10 dígitos. Pra teste, geramos sequenciais.
  const baseSteamId = 76561198000000000n;
  const teamA = Array.from({ length: 5 }, (_, i) => ({
    uid: 'fake-A-' + i,
    steamId: String(baseSteamId + BigInt(1000 + i)),
    name: `BotA${i+1}`,
    avatar: '',
  }));
  const teamB = Array.from({ length: 5 }, (_, i) => ({
    uid: 'fake-B-' + i,
    steamId: String(baseSteamId + BigInt(2000 + i)),
    name: `BotB${i+1}`,
    avatar: '',
  }));

  // Cria o doc do match já em status='starting' com matchzyId em segundos
  const matchRef = db.collection('matches').doc();
  const createdAtMs = Date.now();
  const matchzyId = Math.floor(createdAtMs / 1000);
  await matchRef.set({
    teamA, teamB,
    status: 'starting',
    matchzyId,
    confirmations: [...teamA, ...teamB].reduce((acc, p) => { acc[p.uid] = true; return acc; }, {}),
    confirmExpiresAt: admin.firestore.Timestamp.fromMillis(createdAtMs + 30000),
    mapVeto: {
      pool: ['de_mirage','de_inferno','de_dust2','de_nuke','de_anubis','de_ancient','de_cache','de_train'],
      actions: [],
      activeTeam: null,
      finalMap: mapName,
      turn: 7,
    },
    serverInfo: null,
    stats: {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    debugSimulated: true,
  });

  console.log(`[debug-simulate] criado match ${matchRef.id} matchzyId=${matchzyId} mapa=${mapName}`);

  // Dispara setupMatchServer em background (não espera resposta — RCON pode demorar)
  setupMatchServer(matchRef.id).catch(e => {
    console.error(`[debug-simulate] setupMatchServer falhou:`, e.message);
  });

  return json(200, {
    ok: true,
    matchId: matchRef.id,
    matchzyId,
    mapName,
    hint: `Veja Railway logs filtrando por '${matchRef.id}' pra acompanhar o setup`,
  });
}

// ── GET /rating/leaderboard — top jogadores por csRating ──
async function handleLeaderboard(event) {
  const db = admin.firestore();
  const limit = Math.min(50, parseInt(event.queryStringParameters?.limit || '30', 10));
  // v38-rating: filtragem em memória pra evitar composite index do Firestore.
  // Pega TODOS playerStats com csRating, filtra calibrating=false e ordena.
  // Pra MVP (~30 players) isso é trivial; pra escala 1000+ adicionar index.
  const snap = await db.collection('playerStats')
    .orderBy('csRating', 'desc')
    .limit(limit * 3).get();  // pega 3x pra garantir após filtrar calibrando
  const allDocs = snap.docs.filter(d => {
    const x = d.data();
    return x.csRating != null && x.calibrating !== true;
  }).slice(0, limit);
  const players = allDocs.map(d => {
    const x = d.data();
    return {
      steamId: d.id,
      csRating: x.csRating ?? 0,
      tier: x.tier || 'gray',
      tierName: x.tierName || 'Bronze',
      tierColor: x.tierColor || '#9ca3af',
      matches: x.matches || 0,
      wins: x.wins || 0,
      losses: x.losses || 0,
      kdr: x.kdr || 0,
      kda: x.kda || 0,
      avgAdr: x.avgAdr || 0,
      // Steam profile pra exibição (busca user doc se quiser nome/avatar)
    };
  });
  // Enriquece com nome e avatar via lookup batch users
  for (const p of players) {
    try {
      const u = await db.collection('users').doc(p.steamId).get();
      if (u.exists) {
        const d = u.data();
        p.name = d.steamName || d.fullName || 'Player';
        p.avatar = d.steamAvatar || d.photoURL || '';
      }
    } catch {}
  }
  return json(200, { count: players.length, players });
}

// ── POST /admin/season-reset — zera csRating de todos (cron mensal dia 01) ──
async function handleSeasonReset(event) {
  const body = JSON.parse(event.body || '{}');
  const expectedSecret = process.env.DEBUG_SECRET || process.env.MATCHZY_WEBHOOK_SECRET || '';
  if (!expectedSecret || body.secret !== expectedSecret) {
    return json(401, { error: 'invalid_secret' });
  }
  const db = admin.firestore();
  const snap = await db.collection('playerStats').get();
  const seasonLabel = new Date().toISOString().slice(0,7); // "2026-05"
  let count = 0;
  const batch = db.batch();
  snap.docs.forEach(doc => {
    const d = doc.data();
    batch.update(doc.ref, {
      csRating: null,
      calibrating: true,
      calibrationProgress: 0,
      calibrationMatches: [],
      tier: 'calibrating',
      tierName: 'Calibrando',
      tierColor: '#6b7280',
      lastSeasonTier: d.tier || 'gray',
      lastSeasonTierName: d.tierName || 'Bronze',
      lastSeasonRating: d.csRating ?? 0,
      seasonStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      seasonLabel,
    });
    count++;
    if (count % 400 === 0) { batch.commit(); /* nova batch */ }
  });
  await batch.commit();
  console.log(`[season-reset] ${count} jogadores resetados pra temporada ${seasonLabel}`);
  return json(200, { ok: true, reset: count, seasonLabel });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' }

  // v38-debug: rota de simulação (POST /api/debug/simulate-match — sem prefixo /api/match)
  if (event.httpMethod === 'POST' && (event.path || '').includes('/debug/simulate-match')) {
    return handleDebugSimulateMatch(event);
  };

  const path = event.path || '';

  // /api/match/webhook (POST, sem auth — autenticado por header secret)
  if (event.httpMethod === 'POST' && path.endsWith('/webhook')) return handleWebhook(event);
  // v38-rating: rating endpoints
  if (event.httpMethod === 'GET' && path.endsWith('/rating/leaderboard')) return handleLeaderboard(event);
  if (event.httpMethod === 'POST' && path.endsWith('/admin/season-reset')) return handleSeasonReset(event);
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
  // v48-scoreboard: rota publica (sem auth) pra historico/perfil
  if (event.httpMethod === 'GET' && action === 'scoreboard') return handleScoreboard(matchId);

  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  switch (action) {
    case 'confirm': return handleConfirm(event, matchId);
    case 'veto':    return handleVeto(event, matchId);
    case 'abort':   return handleAbort(event, matchId);
    case 'guard-validate': return handleGuardValidate(event, matchId);
    case 'report': return handleReport(event, matchId);  // v41-reports
    default: return json(404, { error: 'unknown_action', action });
  }
};

// ── POST /api/match/:id/report ─────────────────────────────────────────
// v41-reports: jogador denuncia outro jogador apos a partida.
// Body: { targetSteamId, reason ('cheating'|'toxic'|'griefing'|'smurf'),
//         details (string opcional) }
// Validacoes:
// - reporter precisa ter estado no match (teamA ou teamB)
// - target precisa ter estado no match
// - reason precisa ser uma das validas
// - 1 report por reporter+target+match (idempotente)
async function handleReport(event, matchId) {
  const VALID_REASONS = ['cheating', 'toxic', 'griefing', 'smurf', 'other'];
  const user = await require('./lobby').getAuth(event).catch(() => null);
  if (!user) return json(401, { error: 'login_required' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  const targetSteamId = String(body.targetSteamId || '').trim();
  const reason = String(body.reason || '').trim().toLowerCase();
  const details = String(body.details || '').slice(0, 500);
  if (!targetSteamId) return json(400, { error: 'missing_target' });
  if (!VALID_REASONS.includes(reason)) return json(400, { error: 'invalid_reason', valid: VALID_REASONS });
  const db = admin.firestore();
  const matchSnap = await db.collection('matches').doc(matchId).get();
  if (!matchSnap.exists) return json(404, { error: 'match_not_found' });
  const m = matchSnap.data();
  // Reporter precisa ter estado no match
  const allPlayers = [...(m.teamA || []), ...(m.teamB || [])];
  const reporter = allPlayers.find(p => p.uid === user.uid);
  if (!reporter) return json(403, { error: 'not_in_match' });
  // Target precisa ter estado no match (impede reportar quem nem jogou)
  const target = allPlayers.find(p => p.steamId === targetSteamId);
  if (!target) return json(400, { error: 'target_not_in_match' });
  if (target.uid === user.uid) return json(400, { error: 'cant_report_self' });
  // ID deterministico → idempotente (1 report por reporter+target+match)
  const reportId = `${matchId}_${user.uid}_${targetSteamId}`;
  const reportRef = db.collection('reports').doc(reportId);
  const existing = await reportRef.get();
  if (existing.exists) return json(409, { error: 'already_reported', reportId });
  await reportRef.set({
    matchId,
    reporterUid: user.uid,
    reporterSteamId: reporter.steamId || null,
    reporterName: reporter.name || null,
    targetSteamId,
    targetName: target.name || null,
    reason,
    details,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[report] ${user.uid} reportou ${targetSteamId} (${reason}) no match ${matchId}`);
  return json(201, { reportId, status: 'pending' });
}

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
    steamConnectUrl: `steam://connect/${ip}:${port}`,
    // v37-connect-fix: fallback launch URL (funciona se CS2 não tá aberto)
    steamRunGameUrl: `steam://rungameid/730/+connect%20${ip}:${port}`,
    // Comando manual pro user colar no console do CS2 (fallback garantido)
    connectCommand: `connect ${ip}:${port}`,
    summary: {
      matchId,
      map: m.mapVeto?.finalMap || 'unknown',
      team: inA ? 'A' : 'B',
      teammates: (inA ? m.teamA : m.teamB || []).map(p => p.name).filter(Boolean),
      opponents: (inA ? m.teamB : m.teamA || []).map(p => p.name).filter(Boolean),
    },
  });
}

// v36-nopass: abort manual de match preso. Qualquer player do match pode
// chamar (ex: 9 players entraram no server, 1 não. Após 3min, auto-call.
// OU player clica "Encerrar partida" antes pra escapar voluntariamente).
async function handleAbort(event, matchId) {
  const decoded = await verifyIdToken(event.headers);
  if (!decoded) return json(401, { error: 'unauthorized' });
  const uid = decoded.uid;

  const db = admin.firestore();
  const ref = db.collection('matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return json(404, { error: 'match_not_found' });
  const m = snap.data();

  // Só pode abortar se ainda está em fluxo ativo (não acabou)
  if (m.status === 'finished' || m.status === 'cancelled') {
    return json(409, { error: 'match_already_ended', status: m.status });
  }

  // Verifica que user é parte do match
  const inA = (m.teamA || []).some(p => p.uid === uid);
  const inB = (m.teamB || []).some(p => p.uid === uid);
  if (!inA && !inB) return json(403, { error: 'not_in_match' });

  await ref.update({
    status: 'cancelled',
    cancelReason: 'aborted_by_player',
    cancelDetail: `Cancelada por ${decoded.name || uid}`,
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await releaseLockedLobbies(matchId);

  console.log(`[match ${matchId}] ABORTED por ${uid}`);
  return json(200, { success: true, status: 'cancelled' });
}

exports.setupMatchServer = setupMatchServer;
exports.aggregatePlayerStats = aggregatePlayerStats;
