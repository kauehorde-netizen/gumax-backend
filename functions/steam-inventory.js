// ═══ Gumax — Steam Inventory Sync ═══
// Puxa o inventário público de uma ou mais contas Steam (as contas-loja do Gu)
// e sincroniza na collection `stock/` do Firestore como itens de Entrega Full.
//
// Cada item do stock recebe:
//   { name, wear, rarity, type, assetid, instanceid, classid, iconUrl, tradeable,
//     marketable, ownerSteamId, ownerSteamName, lastSyncAt, delivery: 'full', active: true,
//     buyPriceUSD: <Skinport min_price>, suggestedBRL: <min_price * usdRate * (1 + margin)> }
//
// Endpoint:
//   POST /api/admin/sync-inventory  (admin only — X-Admin-Key header)
//     body: { steamIds: [...] | single steamId string }
//     - Se body omitido, lê settings/store.storeSteamIds do Firestore
//
// Inventário Steam public API:
//   https://steamcommunity.com/inventory/{steamId}/730/2?l=english&count=5000
//   (sem auth; conta precisa ter inventário público nas preferências de privacidade)

const admin = require('firebase-admin');
const https = require('https');
const { fetchPricempireItems, getYoupinPrice } = require('./pricempire');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// Steam anda rejeitando requests sem UA de navegador real (return 400).
// Usamos UA de Chrome + Referer + Accept headers completos pra simular um browser.
function httpGetJson(url, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8',
        'Referer': 'https://steamcommunity.com/',
        'Origin': 'https://steamcommunity.com',
      },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 403) return reject(Object.assign(new Error('inventory_private'), { status: 403 }));
        if (res.statusCode === 429) return reject(Object.assign(new Error('rate_limit'), { status: 429 }));
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error('http_' + res.statusCode),
            { status: res.statusCode, bodySample: body.substring(0, 200) }));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('bad_json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Extrai wear canônico do nome (ex: "AK-47 | Redline (Field-Tested)" → "FT")
function extractWear(name) {
  if (!name) return 'N/A';
  if (name.includes('(Factory New)')) return 'FN';
  if (name.includes('(Minimal Wear)')) return 'MW';
  if (name.includes('(Field-Tested)')) return 'FT';
  if (name.includes('(Well-Worn)')) return 'WW';
  if (name.includes('(Battle-Scarred)')) return 'BS';
  return 'N/A';
}

// Tags do inventário trazem rarity, type etc
function pickTag(tags, category) {
  if (!Array.isArray(tags)) return null;
  const t = tags.find(x => x?.category === category);
  return t ? (t.localized_tag_name || t.name || null) : null;
}

// Busca o perfil resumido (persona name, avatar) na Steam Web API
async function fetchPersona(steamId) {
  const key = process.env.STEAM_API_KEY;
  if (!key) return null;
  try {
    const data = await httpGetJson(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamId}`
    );
    return data?.response?.players?.[0] || null;
  } catch { return null; }
}

// Busca inventário público de uma conta (CS2, app id 730, context 2).
// Steam reduziu limites recentemente — count=2000 é o máximo seguro.
async function fetchInventory(steamId) {
  const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;
  return await httpGetJson(url, { timeout: 20000 });
}

// Cotação CNY→BRL (Pricempire retorna em CNY)
async function fetchCnyBrl() {
  if (global._cnyBrlCache && Date.now() - global._cnyBrlCache.ts < 60 * 60 * 1000) {
    return global._cnyBrlCache.value;
  }
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', { timeout: 5000 });
    const d = await r.json();
    const rate = d.rates?.BRL || 0.68;
    global._cnyBrlCache = { value: rate, ts: Date.now() };
    return rate;
  } catch { return global._cnyBrlCache?.value || 0.68; }
}

// ── Sync core ─────────────────────────────────────────────────────────────
// IMPORTANTE: syncTime é passado do caller pra que TODOS os items sincronizados
// na mesma operação tenham o MESMO lastSyncAt. Assim a prune (que remove o que
// não foi sincronizado agora) não remove por engano os items que acabaram de sincronizar.
// stockFactor é o fator BRL/CNY de VENDA pro estoque (google_rate + surcharge ou × %).
async function syncSingleAccount(steamId, pricempireIndex, cnyRate, syncTime, stockFactor) {
  const [inventory, persona] = await Promise.all([
    fetchInventory(steamId),
    fetchPersona(steamId),
  ]);
  if (!inventory || !inventory.assets || !inventory.descriptions) {
    return { steamId, error: 'empty_inventory_or_private', count: 0 };
  }

  // Indexa descriptions por classid+instanceid
  const descByKey = {};
  for (const d of inventory.descriptions) {
    descByKey[`${d.classid}_${d.instanceid}`] = d;
  }

  const db = admin.firestore();
  const batch = db.batch();
  let count = 0;

  for (const asset of inventory.assets) {
    const key = `${asset.classid}_${asset.instanceid}`;
    const desc = descByKey[key];
    if (!desc) continue;
    if (desc.marketable !== 1 && desc.marketable !== true) continue;

    const marketHashName = desc.market_hash_name || desc.market_name || desc.name || '';
    if (!marketHashName) continue;

    const type = pickTag(desc.tags, 'Type');
    const rarity = pickTag(desc.tags, 'Rarity');
    const exterior = pickTag(desc.tags, 'Exterior');
    const wearCode = extractWear(marketHashName);

    // SKIP: stickers, cases, graffiti, patches, music kits, agents, pins, pass etc.
    // Só queremos skins de armas (Weapon), facas (Knife) e luvas (Gloves).
    const lowerName = marketHashName.toLowerCase();
    const isWeaponOrKnife =
      marketHashName.startsWith('★') ||   // facas/luvas
      /^StatTrak™\s/.test(marketHashName) || // StatTrak (qualquer arma)
      /^[A-Z]+[\w\- ]*\s\|/.test(marketHashName); // "AK-47 | ...", "Desert Eagle | ..."
    const isBlockedCategory =
      /^(Sticker|Patch|Graffiti|Music Kit|Sealed Graffiti|Case|Operation|Souvenir Package|Pin|Pass|Coupon|Key)/i.test(marketHashName) ||
      /^(Dreams & Nightmares|Fracture|Operation Riptide|Operation Breakout|Chroma|Huntsman|Prisma|Shattered|Recoil|Snakebite|Horizon|Clutch|Spectrum|Gamma|Glove|Hydra|Winter Offensive|eSports) Case/i.test(marketHashName) ||
      /Case$/i.test(marketHashName) ||
      /Capsule$/i.test(marketHashName);
    if (!isWeaponOrKnife || isBlockedCategory) continue;

    // Preço via Pricempire (base: Youpin CNY)
    const pricempireItem = pricempireIndex[marketHashName];
    const buyPriceCNY = pricempireItem ? getYoupinPrice(pricempireItem) : 0;

    // Inspect link da Steam (usado pra buscar float exato + pattern via CSFloat)
    const inspectAction = Array.isArray(desc.actions)
      ? desc.actions.find(a => /Inspect/i.test(a?.name || ''))
      : null;
    const inspectLink = inspectAction?.link
      ?.replace('%owner_steamid%', steamId)
      ?.replace('%assetid%', asset.assetid) || null;

    const docId = `steam_${steamId}_${asset.assetid}`;
    const stockDoc = {
      name: marketHashName,
      wear: wearCode,
      wearFull: exterior || '',
      rarity: rarity || 'Mil-Spec',
      type: type || 'Weapon Skin',
      classid: asset.classid,
      instanceid: asset.instanceid,
      assetid: asset.assetid,
      inspectLink,
      iconUrl: desc.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}/256fx256f` : '',
      tradable: desc.tradable === 1 || desc.tradable === true,
      marketable: true,
      ownerSteamId: steamId,
      ownerSteamName: persona?.personaname || '',
      delivery: 'full',
      inStock: true,
      active: true,
      lastSyncAt: syncTime,
      buyPriceCNY: buyPriceCNY > 0 ? buyPriceCNY : null,
      buyPriceBRL: buyPriceCNY > 0 ? +(buyPriceCNY * cnyRate).toFixed(2) : null,
      // sellPriceBRL: preço de VENDA na loja, usando config settings/stockPricing
      // (google_rate + surcharge OU google_rate × (1 + margin/100)).
      sellPriceBRL: buyPriceCNY > 0 && stockFactor > 0
        ? +(buyPriceCNY * stockFactor).toFixed(2)
        : null,
      source: 'steam_inventory',
    };
    batch.set(db.collection('stock').doc(docId), stockDoc, { merge: true });
    count++;
    if (count % 400 === 0) {
      // Firestore limit de 500 ops por batch — commit parcial e recomeça
      await batch.commit();
    }
  }
  if (count > 0) await batch.commit();

  return { steamId, count, personaName: persona?.personaname || null };
}

// Remove items que não apareceram na última sync (ou seja, foram vendidos/transferidos)
async function pruneMissingItems(syncedSteamIds, freshSyncTime) {
  const db = admin.firestore();
  let removed = 0;
  for (const sid of syncedSteamIds) {
    const snap = await db.collection('stock')
      .where('ownerSteamId', '==', sid)
      .where('source', '==', 'steam_inventory')
      .get();
    for (const doc of snap.docs) {
      if (doc.data().lastSyncAt !== freshSyncTime) {
        await doc.ref.update({ active: false, inStock: false, removedAt: new Date().toISOString() });
        removed++;
      }
    }
  }
  return removed;
}

async function syncInventory(steamIds) {
  if (!Array.isArray(steamIds) || steamIds.length === 0) {
    throw new Error('steamIds required (array of strings)');
  }
  // Normaliza
  const ids = steamIds.map(s => String(s).trim()).filter(s => /^\d{17}$/.test(s));
  if (ids.length === 0) throw new Error('no valid steamIds (expected 17-digit SteamID64)');

  // Fator de venda do estoque (google_rate + surcharge OU × margin%)
  // vindo de settings/stockPricing.
  const { getStockConversionFactor } = require('./pricing');
  const [pricempireIndex, cnyRate, stockFactor] = await Promise.all([
    fetchPricempireItems(),
    fetchCnyBrl(),
    getStockConversionFactor().catch(() => 0.85), // fallback seguro
  ]);
  console.log(`[steam-inventory] stockFactor=${stockFactor}`);

  const results = [];
  const syncTime = new Date().toISOString();
  for (const sid of ids) {
    try {
      const r = await syncSingleAccount(sid, pricempireIndex, cnyRate, syncTime, stockFactor);
      r.lastSyncAt = syncTime;
      results.push(r);
    } catch (e) {
      results.push({ steamId: sid, error: e.message });
    }
  }

  // Marca items fora do inventário atual como inativos
  const prunedCount = await pruneMissingItems(ids, syncTime);

  // Atualiza timestamp de última sync global
  try {
    const db = admin.firestore();
    await db.collection('settings').doc('store').set({
      lastInventorySync: syncTime,
      lastInventorySyncResults: results,
    }, { merge: true });
  } catch {}

  // Background: busca float exato + pattern pros items novos (não bloqueia a resposta)
  // CSFloat rate-limited — processa em batch com throttle
  setImmediate(async () => {
    try {
      const { enrichStockWithFloats } = require('./float-inspector');
      const r = await enrichStockWithFloats();
      console.log('[sync] float enrichment:', JSON.stringify(r));
    } catch (e) {
      console.error('[sync] float enrichment error:', e.message);
    }
  });

  return { syncTime, accounts: results, pruned: prunedCount };
}

// Normaliza o inventário bruto da Steam em uma lista de items [{ market_hash_name, wear, rarity, type, iconUrl, assetid, tradable, marketable }].
// Aplica filtro: só items marketable (skins, não items que não podem ser negociados).
function normalizeInventoryItems(inventory) {
  if (!inventory || !Array.isArray(inventory.assets) || !Array.isArray(inventory.descriptions)) {
    return [];
  }
  const descByKey = {};
  for (const d of inventory.descriptions) {
    descByKey[`${d.classid}_${d.instanceid}`] = d;
  }
  const items = [];
  for (const asset of inventory.assets) {
    const key = `${asset.classid}_${asset.instanceid}`;
    const desc = descByKey[key];
    if (!desc) continue;
    // Só items tradable e marketable
    if (desc.tradable !== 1 && desc.tradable !== true) continue;
    if (desc.marketable !== 1 && desc.marketable !== true) continue;

    const marketHashName = desc.market_hash_name || desc.market_name || desc.name || '';
    if (!marketHashName) continue;

    items.push({
      assetid: asset.assetid,
      classid: asset.classid,
      instanceid: asset.instanceid,
      market_hash_name: marketHashName,
      wear: extractWear(marketHashName),
      wearFull: pickTag(desc.tags, 'Exterior') || '',
      rarity: pickTag(desc.tags, 'Rarity') || 'Common',
      type: pickTag(desc.tags, 'Type') || 'Weapon Skin',
      iconUrl: desc.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}/256fx256f`
        : '',
      tradable: true,
      marketable: true,
    });
  }
  return items;
}

// ── Handler HTTP ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '';

  // GET /api/steam-inventory?steamId=76561... — público, leitura do inventário de qualquer
  // user (desde que a conta esteja pública na Steam). Sem auth pra simplificar; rate limit
  // protege contra abuso.
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const steamId = String(q.steamId || '').trim();
    if (!/^\d{17}$/.test(steamId)) {
      return json(400, { error: 'steamId precisa ser um SteamID64 (17 dígitos)' });
    }
    try {
      const inv = await fetchInventory(steamId);
      const items = normalizeInventoryItems(inv);
      return json(200, { steamId, count: items.length, items });
    } catch (e) {
      const code = e.status === 403 ? 403 : (e.status === 429 ? 429 : 500);
      console.error(`[steam-inventory] ${steamId} ${e.message}`, e.bodySample || '');
      return json(code, {
        error: e.message,
        steamId,
        hint: e.status === 400
          ? 'Steam rejeitou a request. Verifica se o inventário tá público (Steam → Perfil → Editar Perfil → Privacidade → Inventário: Público).'
          : (e.status === 403 ? 'Inventário privado' : undefined),
        debug: e.bodySample || undefined,
      });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // Admin only — aceita Firebase ID token (Authorization: Bearer <token>) ou ADMIN_API_KEY (legacy).
  const ADMIN_EMAILS = ['gumaxskins@gmail.com', 'cauehorde@gmail.com'];
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const legacyKey = event.headers?.['x-admin-key'] || event.headers?.['X-Admin-Key'];

  let authorized = false;
  if (bearerToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(bearerToken);
      if (ADMIN_EMAILS.includes((decoded.email || '').toLowerCase())) authorized = true;
    } catch {
      // não é Firebase token — cai pro fallback ADMIN_API_KEY
      if (process.env.ADMIN_API_KEY && bearerToken === process.env.ADMIN_API_KEY) authorized = true;
    }
  }
  if (!authorized && legacyKey && process.env.ADMIN_API_KEY && legacyKey === process.env.ADMIN_API_KEY) {
    authorized = true;
  }
  if (!authorized) return json(401, { error: 'Unauthorized — login como admin necessário' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  let steamIds = body.steamIds;
  if (typeof steamIds === 'string') steamIds = [steamIds];

  // Se não veio no body, lê da config store.storeSteamIds
  if (!Array.isArray(steamIds) || steamIds.length === 0) {
    try {
      const db = admin.firestore();
      const doc = await db.collection('settings').doc('store').get();
      steamIds = doc.exists ? (doc.data()?.storeSteamIds || []) : [];
    } catch {}
  }

  if (!Array.isArray(steamIds) || steamIds.length === 0) {
    return json(400, { error: 'no steamIds provided and settings/store.storeSteamIds empty' });
  }

  try {
    const result = await syncInventory(steamIds);
    return json(200, result);
  } catch (e) {
    return json(500, { error: e.message });
  }
};

exports.syncInventory = syncInventory;
