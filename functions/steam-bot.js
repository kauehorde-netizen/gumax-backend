/* ═══════════════════════════════════════════════════════════
   Gumax Skins — Steam Bot Inventory Fetcher
   (portado do FlowSkins — Gu/Cauê são sócios, mesma conta Steam)

   Uses DoctorMcKay's steam-user + steam-tradeoffer-manager
   to fetch COMPLETE inventories via trade offer endpoint.
   This returns ALL items including ones hidden from public API
   (skins caras com stickers, custom name tags, floats raros).

   Env vars needed (no Railway):
   - STEAM_BOT_REFRESH_TOKEN   (preferido — não expira)
   - STEAM_BOT_USERNAME        (fallback)
   - STEAM_BOT_PASSWORD        (fallback)
   - STEAM_BOT_SHARED_SECRET   (Steam Guard TOTP, fallback)

   POST { tradeLink: "https://steamcommunity.com/tradeoffer/new/?partner=XXX&token=YYY" }
   → { success, assets, descriptions, total, source }
   ═══════════════════════════════════════════════════════════ */

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Persistent bot instance (stays logged in between requests)
let bot = null;
let botReady = false;
let botError = null;
let loginPromise = null;

function initBot() {
  if (loginPromise) return loginPromise;

  loginPromise = new Promise((resolve, reject) => {
    const username = process.env.STEAM_BOT_USERNAME;
    const password = process.env.STEAM_BOT_PASSWORD;
    const sharedSecret = process.env.STEAM_BOT_SHARED_SECRET;
    const refreshToken = process.env.STEAM_BOT_REFRESH_TOKEN;

    if (!refreshToken && !username) {
      botError = 'STEAM_BOT_REFRESH_TOKEN or STEAM_BOT_USERNAME not set';
      reject(new Error(botError));
      return;
    }

    const client = new SteamUser();
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({
      steam: client,
      community: community,
      language: 'english',
      pollInterval: -1,
    });

    if (refreshToken) {
      console.log('[Bot] Logging in with refresh token...');
      client.logOn({ refreshToken });
    } else {
      console.log(`[Bot] Logging in as ${username}...`);
      client.logOn({
        accountName: username,
        password: password,
        twoFactorCode: sharedSecret ? SteamTotp.generateAuthCode(sharedSecret) : undefined,
      });
    }

    client.on('loggedOn', () => {
      console.log('[Bot] Logged into Steam');
      client.setPersona(SteamUser.EPersonaState.Online);
    });

    // Save refresh token for future use
    client.on('refreshToken', (token) => {
      console.log('[Bot] ═══ REFRESH TOKEN ═══');
      console.log('[Bot] Save this as STEAM_BOT_REFRESH_TOKEN:');
      console.log(token);
      console.log('[Bot] ═══════════════════════');
    });

    client.on('webSession', (sessionID, cookies) => {
      console.log('[Bot] Web session obtained');
      manager.setCookies(cookies, (err) => {
        if (err) {
          console.error('[Bot] setCookies error:', err.message);
          botError = err.message;
          reject(err);
          return;
        }
        bot = { client, community, manager };
        botReady = true;
        botError = null;
        console.log('[Bot] Ready!');
        resolve(bot);
      });
    });

    client.on('error', (err) => {
      console.error('[Bot] Login error:', err.message);
      botError = err.message;
      botReady = false;
      loginPromise = null;
      reject(err);
    });

    client.on('disconnected', (eresult, msg) => {
      console.log(`[Bot] Disconnected: ${msg}. Will reconnect on next request.`);
      botReady = false;
      loginPromise = null;
    });
  });

  return loginPromise;
}

async function getPartnerInventory(tradeLink) {
  if (!botReady || !bot) {
    await initBot();
  }

  // Parse trade link to get partner ID and token
  const partnerMatch = tradeLink.match(/partner=(\d+)/);
  const tokenMatch = tradeLink.match(/token=([A-Za-z0-9_-]+)/);
  if (!partnerMatch) throw new Error('Invalid trade link');

  const partnerId = partnerMatch[1];
  const token = tokenMatch ? tokenMatch[1] : '';
  const steamId64 = String(BigInt('76561197960265728') + BigInt(partnerId));

  console.log(`[Bot] Fetching via trade offer endpoint for ${steamId64}...`);

  const sessionID = bot.community.getSessionID();
  const allItems = [];
  let start = 0;
  let page = 0;
  const MAX_PAGES = 50; // Safety limit — large inventories can have many pages

  while (page < MAX_PAGES) {
    page++;
    try {
      const pageItems = await new Promise((resolve, reject) => {
        let url = `https://steamcommunity.com/tradeoffer/new/partnerinventory/?sessionid=${sessionID}&partner=${steamId64}&appid=730&contextid=2&l=english`;
        if (start > 0) url += `&start=${start}`;

        bot.community.httpRequestGet({
          uri: url,
          headers: {
            'Referer': `https://steamcommunity.com/tradeoffer/new/?partner=${partnerId}&token=${token}`,
          },
          json: true,
        }, (err, response, body) => {
          if (err) return reject(err);
          if (!body || !body.success) return reject(new Error('success=false'));

          const rgInv = body.rgInventory || {};
          const rgDesc = body.rgDescriptions || {};
          const items = [];

          for (const [id, item] of Object.entries(rgInv)) {
            const classid = String(item.classid);
            const instanceid = String(item.instanceid || '0');
            const dk = `${classid}_${instanceid}`;
            const d = rgDesc[dk] || {};

            items.push({
              assetid: String(id),
              classid,
              instanceid,
              market_hash_name: d.market_hash_name || d.name || '',
              name: d.name || '',
              icon_url: d.icon_url || '',
              type: d.type || '',
              tradable: d.tradable ?? 1,
              marketable: d.marketable ?? 1,
              tags: d.tags || [],
              actions: d.actions || [],
              descriptions: d.descriptions || [],
              amount: parseInt(item.amount, 10) || 1,
            });
          }

          resolve({ items, more: !!body.more, moreStart: body.more_start != null ? body.more_start : 0 });
        });
      });

      allItems.push(...pageItems.items);
      console.log(`[Bot] Page ${page}: ${pageItems.items.length} items (total so far: ${allItems.length})`);

      if (!pageItems.more) break;
      if (pageItems.moreStart <= start && page > 1) { console.log('[Bot] Pagination stuck, breaking'); break; }
      start = pageItems.moreStart;

      // Small delay between pages to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));

    } catch (pageErr) {
      console.log(`[Bot] Page ${page} error: ${pageErr.message}`);
      if (page === 1) {
        // First page failed — fallback to getPartnerInventoryContents
        console.log('[Bot] Falling back to getPartnerInventoryContents...');
        return new Promise((resolve, reject) => {
          const offer = bot.manager.createOffer(tradeLink);
          offer.getPartnerInventoryContents(730, 2, (err2, inventory) => {
            if (err2) return reject(err2);
            console.log(`[Bot] Fallback got ${inventory.length} items`);
            resolve(inventory);
          });
        });
      }
      break; // Use what we have from previous pages
    }
  }

  console.log(`[Bot] Trade endpoint returned ${allItems.length} items total (${page} pages)`);
  return allItems;
}

// Express handler
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  try {
    const body = JSON.parse(event.body || '{}');
    const { tradeLink } = body;

    if (!tradeLink || !tradeLink.includes('partner=')) {
      return json(400, { error: 'tradeLink required' });
    }

    const items = await getPartnerInventory(tradeLink);

    // Convert to assets + descriptions format (compatible with evaluate-inventory)
    const assets = [];
    const descriptions = [];
    const seenDescs = new Set();

    for (const item of items) {
      assets.push({
        appid: 730,
        contextid: '2',
        assetid: item.assetid,
        classid: item.classid,
        instanceid: item.instanceid,
        amount: String(item.amount),
      });

      const dk = `${item.classid}_${item.instanceid}`;
      if (!seenDescs.has(dk)) {
        seenDescs.add(dk);
        descriptions.push({
          appid: 730,
          classid: item.classid,
          instanceid: item.instanceid,
          icon_url: item.icon_url,
          name: item.name,
          market_hash_name: item.market_hash_name,
          type: item.type,
          tradable: item.tradable,
          marketable: item.marketable,
          tags: item.tags,
          actions: item.actions,
          descriptions: item.descriptions,
        });
      }
    }

    return json(200, {
      success: true,
      assets,
      descriptions,
      total: items.length,
      source: 'steam-bot',
    });
  } catch (e) {
    console.error('[Bot] Handler error:', e.message);
    return json(500, { error: e.message, botStatus: botReady ? 'ready' : 'offline' });
  }
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

// Export for use by evaluate-inventory
exports.getPartnerInventory = getPartnerInventory;
