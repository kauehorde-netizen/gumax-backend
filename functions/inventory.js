// v49-skins: sistema de inventário de skins virtuais (server-side via WeaponPaints).
//
// === SCHEMA DO MYSQL (a criar quando o database for provisionado) ===
//
// Database: 2 tabelas no mesmo MySQL.
// (1) wp_player_skins: tabela do plugin WeaponPaints (ele lê/escreve aqui ao spawn).
//     Plugin já cria automaticamente. Schema (referência):
//       steamid VARCHAR(64), weapon_team INT, weapon_defindex INT,
//       weapon_paint_id INT, weapon_wear FLOAT, weapon_seed INT,
//       weapon_nametag VARCHAR(64), weapon_stickers TEXT, weapon_keychain TEXT
//     PK: (steamid, weapon_team, weapon_defindex)
//
// (2) gmax_inventory: NOSSA tabela. Catálogo de skins owned + qual está equipada.
//     CREATE TABLE gmax_inventory (
//       id INT AUTO_INCREMENT PRIMARY KEY,
//       steam_id VARCHAR(64) NOT NULL,
//       paint_kit INT NOT NULL,
//       weapon VARCHAR(64) NOT NULL,           -- weapon_ak47, weapon_m4a1, etc
//       tier VARCHAR(20) NOT NULL,             -- common|rare|epic|legendary|mythical|ancient
//       source VARCHAR(64) NOT NULL,           -- match_win, match_mvp, monthly_top_kdr, ace, tournament_*
//       source_match_id VARCHAR(64),           -- referencia a matches/{id} se aplicavel
//       awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//       equipped TINYINT(1) DEFAULT 0,         -- 0=guardada, 1=equipada (1 por weapon)
//       INDEX idx_steam (steam_id),
//       INDEX idx_steam_equipped (steam_id, equipped),
//       UNIQUE KEY uniq_skin (steam_id, paint_kit, weapon)
//     );
//
// Quando jogador equipa skin X pra arma Y:
//   1. UPDATE gmax_inventory SET equipped=0 WHERE steam_id=? AND weapon=? (desequipa atuais)
//   2. UPDATE gmax_inventory SET equipped=1 WHERE id=?
//   3. INSERT INTO wp_player_skins (steamid, weapon_defindex, weapon_paint_id, weapon_wear, weapon_seed)
//      VALUES (?, ?, ?, 0.01, 1)
//      ON DUPLICATE KEY UPDATE weapon_paint_id=VALUES(weapon_paint_id);
//
// === ESTADO ATUAL ===
// Ainda em STUB MODE — usa Firestore como mock até o MySQL estar pronto.
// Quando MYSQL_URL env estiver setado, troca pra mysql2 lib.

const admin = require('firebase-admin');

let mysqlPool = null;
let mysqlReady = false;
function tryInitMySQL() {
  if (mysqlPool || !process.env.MYSQL_URL) return;
  try {
    const mysql = require('mysql2/promise');
    mysqlPool = mysql.createPool({
      uri: process.env.MYSQL_URL,
      connectionLimit: 5,
      waitForConnections: true,
    });
    mysqlReady = true;
    console.log('[inventory] MySQL pool criado');
  } catch (e) {
    console.warn('[inventory] mysql2 lib não instalada ou URL inválida — usando Firestore stub');
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function json(code, body) { return { statusCode: code, headers: CORS, body: JSON.stringify(body) }; }
async function getAuth(event) { return await require('./lobby').getAuth(event).catch(() => null); }

// ── GET /api/inventory/:steamId ───────────────────────────────────────────
// Retorna lista de skins owned + qual está equipada por arma.
// PÚBLICO (qualquer um vê inventário de qualquer jogador — like a vitrine).
async function handleGetInventory(steamId) {
  if (!steamId) return json(400, { error: 'missing_steamId' });
  tryInitMySQL();
  if (mysqlReady) {
    try {
      const [rows] = await mysqlPool.query(
        'SELECT * FROM gmax_inventory WHERE steam_id=? ORDER BY awarded_at DESC',
        [steamId]
      );
      return json(200, { steamId, items: rows, source: 'mysql' });
    } catch (e) {
      console.warn('[inventory] mysql query falhou, fallback firestore:', e.message);
    }
  }
  // Firestore stub
  const db = admin.firestore();
  const snap = await db.collection('gmaxInventory')
    .where('steamId', '==', steamId)
    .orderBy('awardedAt', 'desc').get();
  const items = snap.docs.map(d => ({
    id: d.id, ...d.data(),
    awardedAt: d.data().awardedAt?._seconds ? d.data().awardedAt._seconds * 1000 : null,
  }));
  return json(200, { steamId, items, source: 'firestore-stub' });
}

// ── POST /api/inventory/equip ─────────────────────────────────────────────
// Body: { itemId, paintKit, weapon }
// User equipa uma skin que ele POSSUI numa weapon especifica.
async function handleEquip(event) {
  const user = await getAuth(event);
  if (!user) return json(401, { error: 'login_required' });
  if (!user.steamId) return json(400, { error: 'no_steamid' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  const { itemId, paintKit, weapon } = body;
  if (!itemId || !paintKit || !weapon) return json(400, { error: 'missing_fields' });

  tryInitMySQL();
  if (mysqlReady) {
    try {
      const [check] = await mysqlPool.query(
        'SELECT id FROM gmax_inventory WHERE id=? AND steam_id=?',
        [itemId, user.steamId]
      );
      if (!check.length) return json(404, { error: 'item_not_owned' });
      // Desequipa anterior + equipa novo
      await mysqlPool.query(
        'UPDATE gmax_inventory SET equipped=0 WHERE steam_id=? AND weapon=?',
        [user.steamId, weapon]
      );
      await mysqlPool.query(
        'UPDATE gmax_inventory SET equipped=1 WHERE id=?', [itemId]
      );
      // Sincroniza com tabela do plugin
      // weapon_defindex precisa de mapping (ex: weapon_ak47 = 7). Ver constante WEAPON_DEFINDEX abaixo.
      const defindex = WEAPON_DEFINDEX[weapon];
      if (defindex) {
        await mysqlPool.query(`
          INSERT INTO wp_player_skins (steamid, weapon_team, weapon_defindex, weapon_paint_id, weapon_wear, weapon_seed)
          VALUES (?, 0, ?, ?, 0.01, 1)
          ON DUPLICATE KEY UPDATE weapon_paint_id=VALUES(weapon_paint_id), weapon_wear=VALUES(weapon_wear), weapon_seed=VALUES(weapon_seed)`,
          [user.steamId, defindex, paintKit]);
        // weapon_team=0 = ambos os times (CT+T). Plugin usa 2=T, 3=CT pra forçar lado.
      }
      return json(200, { ok: true, equipped: itemId });
    } catch (e) {
      console.error('[inventory] equip mysql falhou:', e.message);
      return json(500, { error: 'equip_failed' });
    }
  }
  // Firestore stub: só atualiza flag equipped no doc
  const db = admin.firestore();
  const ref = db.collection('gmaxInventory').doc(itemId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().steamId !== user.steamId) {
    return json(404, { error: 'item_not_owned' });
  }
  // Desequipa outras da mesma arma
  const sib = await db.collection('gmaxInventory')
    .where('steamId', '==', user.steamId)
    .where('weapon', '==', weapon).get();
  const batch = db.batch();
  sib.docs.forEach(d => batch.update(d.ref, { equipped: false }));
  batch.update(ref, { equipped: true });
  await batch.commit();
  return json(200, { ok: true, equipped: itemId, source: 'firestore-stub' });
}

// ── helper exportado: awardSkin(steamId, paintKit, weapon, tier, source, matchId) ──
// Chamado por aggregatePlayerStats quando um jogador ganha uma skin.
// Idempotente: se ja tem essa skin (paint_kit+weapon), não duplica.
async function awardSkin({ steamId, paintKit, weapon, tier, source, matchId }) {
  if (!steamId || !paintKit || !weapon || !tier || !source) {
    console.warn('[awardSkin] params invalidos:', { steamId, paintKit, weapon, tier, source });
    return { ok: false, error: 'invalid_params' };
  }
  tryInitMySQL();
  if (mysqlReady) {
    try {
      const [existing] = await mysqlPool.query(
        'SELECT id FROM gmax_inventory WHERE steam_id=? AND paint_kit=? AND weapon=?',
        [steamId, paintKit, weapon]
      );
      if (existing.length) return { ok: true, alreadyOwned: true, itemId: existing[0].id };
      const [result] = await mysqlPool.query(`
        INSERT INTO gmax_inventory (steam_id, paint_kit, weapon, tier, source, source_match_id)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [steamId, paintKit, weapon, tier, source, matchId || null]);
      console.log(`[awardSkin] ${steamId} ganhou paintKit=${paintKit} weapon=${weapon} tier=${tier} source=${source}`);
      return { ok: true, itemId: result.insertId };
    } catch (e) {
      console.error('[awardSkin] mysql falhou:', e.message);
    }
  }
  // Firestore stub
  const db = admin.firestore();
  const docId = `${steamId}_${weapon}_${paintKit}`;
  const ref = db.collection('gmaxInventory').doc(docId);
  const existing = await ref.get();
  if (existing.exists) return { ok: true, alreadyOwned: true, itemId: docId };
  await ref.set({
    steamId, paintKit, weapon, tier, source,
    sourceMatchId: matchId || null,
    equipped: false,
    awardedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[awardSkin:stub] ${steamId} ganhou paintKit=${paintKit}`);
  return { ok: true, itemId: docId };
}

// Mapping weapon_id (skins-catalog) -> defindex (CS2 internal). Lista parcial,
// expandir conforme usar mais armas no catalogo.
// Source: https://wiki.alliedmods.net/Counter-Strike:_Global_Offensive_Weapons
const WEAPON_DEFINDEX = {
  weapon_ak47: 7,         weapon_m4a1: 16,        weapon_m4a1_silencer: 60,
  weapon_awp: 9,          weapon_deagle: 1,       weapon_glock: 4,
  weapon_usp_silencer: 61, weapon_p2000: 32,      weapon_p250: 36,
  weapon_fiveseven: 3,    weapon_revolver: 64,    weapon_elite: 2,
  weapon_tec9: 30,        weapon_cz75a: 63,       weapon_famas: 10,
  weapon_galilar: 13,     weapon_aug: 8,          weapon_sg556: 39,
  weapon_ssg08: 40,       weapon_g3sg1: 11,       weapon_scar20: 38,
  weapon_mac10: 17,       weapon_mp9: 33,         weapon_mp7: 23,
  weapon_mp5sd: 23,       weapon_ump45: 24,       weapon_p90: 19,
  weapon_bizon: 26,       weapon_nova: 35,        weapon_xm1014: 25,
  weapon_sawedoff: 29,    weapon_mag7: 27,        weapon_m249: 14,
  weapon_negev: 28,
  // Knives
  weapon_knife_karambit: 507, weapon_knife_m9_bayonet: 508,
  weapon_knife_butterfly: 515, weapon_bayonet: 500,
  weapon_knife_flip: 505, weapon_knife_gut: 506,
  weapon_knife_tactical: 509, weapon_knife_falchion: 512,
  weapon_knife_survival_bowie: 514, weapon_knife_push: 516,
  weapon_knife_cord: 517, weapon_knife_canis: 518,
  weapon_knife_ursus: 519, weapon_knife_gypsy_jackknife: 520,
  weapon_knife_outdoor: 521, weapon_knife_stiletto: 522,
  weapon_knife_widowmaker: 523, weapon_knife_skeleton: 525,
  weapon_knife_kukri: 526,
  // Gloves (todos team-bound)
  studded_bloodhound_gloves: 5027, sporty_gloves: 5030,
  slick_gloves: 5031, leather_handwraps: 5032,
  motorcycle_gloves: 5033, specialist_gloves: 5034,
  studded_brokenfang_gloves: 4725, studded_hydra_gloves: 4726,
};

// ── Handler HTTP exportado pro server.js wireup ──────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const path = event.path || '';
  const playerMatch = path.match(/\/api\/inventory\/([^/]+)$/);
  if (event.httpMethod === 'GET' && playerMatch) return handleGetInventory(playerMatch[1]);
  if (event.httpMethod === 'POST' && path.endsWith('/equip')) return handleEquip(event);
  return json(404, { error: 'route_not_found' });
};

// Helpers exportados pra triggers em match.js
exports.awardSkin = awardSkin;
exports.WEAPON_DEFINDEX = WEAPON_DEFINDEX;
