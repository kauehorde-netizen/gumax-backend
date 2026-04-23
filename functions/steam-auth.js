// ═══ Gumax — Steam OpenID 2.0 Authentication ═══
// Steam authentication for customer login

const https = require('https');
const querystring = require('querystring');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve({ status: r.statusCode, body }));
      r.on('error', reject);
    }).on('error', reject);
  });
}

function httpPost(url, postData) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = typeof postData === 'string' ? postData : querystring.stringify(postData);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve({ status: r.statusCode, body }));
      r.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // GET: Generate Steam login URL
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (action === 'login') {
      const returnTo = params.returnTo || process.env.FRONTEND_URL || 'https://market.gumaxskins.com.br';
      // Steam OpenID 2.0 redirect URL
      const steamOpenIdParams = {
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo + '?steam_callback=1',
        'openid.realm': returnTo,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      };
      const loginUrl = 'https://steamcommunity.com/openid/login?' + querystring.stringify(steamOpenIdParams);
      return json(200, { loginUrl });
    }

    // Resolve vanity URL (ex: "gumaxskins" → "76561198...")
    if (action === 'resolve-vanity') {
      const vanity = (params.name || '').trim();
      if (!vanity) return json(400, { error: 'name required' });
      const apiKey = process.env.STEAM_API_KEY;
      if (!apiKey) return json(500, { error: 'STEAM_API_KEY not configured' });
      try {
        const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${apiKey}&vanityurl=${encodeURIComponent(vanity)}`;
        const res = await httpGet(url);
        if (res.status !== 200) return json(502, { error: 'steam_api_error', status: res.status });
        const data = JSON.parse(res.body);
        const r = data?.response;
        if (r?.success === 1 && r?.steamid) {
          // Também busca o perfil resumido
          let profile = null;
          try {
            const summUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${r.steamid}`;
            const summ = await httpGet(summUrl);
            if (summ.status === 200) {
              const sd = JSON.parse(summ.body);
              profile = sd?.response?.players?.[0] || null;
            }
          } catch {}
          return json(200, {
            success: true, vanity, steamId: r.steamid,
            profileName: profile?.personaname || null,
            avatar: profile?.avatarfull || null,
          });
        }
        return json(404, { success: false, error: 'vanity_not_found', vanity });
      } catch (e) {
        return json(500, { error: e.message });
      }
    }

    return json(400, { error: 'Missing or invalid action parameter' });
  }

  // POST: Verify Steam callback
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }

    // Action "refresh-profile": re-busca nome + avatar da Steam pra um user já logado.
    // Requer Firebase ID token no Authorization header.
    if (body.action === 'refresh-profile') {
      const authHeader = event.headers?.authorization || event.headers?.Authorization;
      if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        return json(401, { error: 'Bearer token required' });
      }
      const idToken = authHeader.slice(7);
      let decoded;
      try {
        const admin = require('firebase-admin');
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch (e) {
        return json(401, { error: 'Invalid token' });
      }
      const steamId = decoded.uid;
      if (!/^\d{17}$/.test(steamId)) {
        return json(400, { error: 'Not a Steam user (uid is not a steamId)' });
      }

      const steamApiKey = process.env.STEAM_API_KEY;
      if (!steamApiKey) {
        return json(500, { error: 'STEAM_API_KEY not configured' });
      }

      try {
        const profileRes = await httpGet(
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${steamApiKey}&steamids=${steamId}`
        );
        if (profileRes.status !== 200) {
          return json(502, { error: 'Steam API error', status: profileRes.status });
        }
        const profile = JSON.parse(profileRes.body);
        const player = profile?.response?.players?.[0];
        if (!player) return json(404, { error: 'Steam profile not found' });

        const steamName = player.personaname || `Steam ${steamId.slice(-4)}`;
        const steamAvatar = player.avatarfull || player.avatarmedium || player.avatar || '';

        const admin = require('firebase-admin');
        const db = admin.firestore();
        await db.collection('users').doc(steamId).set({
          steamName, steamAvatar, lastLogin: new Date().toISOString(),
        }, { merge: true });

        return json(200, { success: true, steamName, steamAvatar, steamId });
      } catch (e) {
        return json(500, { error: 'refresh error: ' + e.message });
      }
    }

    if (body.action !== 'verify' || !body.params) {
      return json(400, { error: 'Missing action or params' });
    }

    const openidParams = body.params;

    // Extract Steam ID from claimed_id
    const claimedId = openidParams['openid.claimed_id'] || '';
    const steamIdMatch = claimedId.match(/\/id\/(\d+)$/) || claimedId.match(/(\d{17})$/);
    if (!steamIdMatch) {
      return json(400, { error: 'Could not extract Steam ID', claimedId });
    }
    const steamId = steamIdMatch[1];

    // Verify with Steam
    try {
      const verifyParams = { ...openidParams };
      verifyParams['openid.mode'] = 'check_authentication';

      const verifyRes = await httpPost('https://steamcommunity.com/openid/login', verifyParams);

      if (verifyRes.body.includes('is_valid:true')) {
        console.log(`[Steam Auth] Verified Steam ID: ${steamId}`);

        // Tenta buscar nome + avatar do perfil público Steam (se STEAM_API_KEY existir)
        let steamName = '';
        let steamAvatar = '';
        const steamApiKey = process.env.STEAM_API_KEY;
        if (steamApiKey) {
          try {
            const profileUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${steamApiKey}&steamids=${steamId}`;
            const profileRes = await httpGet(profileUrl);
            if (profileRes.status === 200) {
              const profile = JSON.parse(profileRes.body);
              const player = profile?.response?.players?.[0];
              if (player) {
                steamName = player.personaname || '';
                steamAvatar = player.avatarfull || player.avatarmedium || player.avatar || '';
              }
            }
          } catch (e) {
            console.log('[Steam Auth] GetPlayerSummaries error:', e.message);
          }
        }

        // Try to log user to Firestore
        try {
          const admin = require('firebase-admin');
          const db = admin.firestore();
          const userRef = db.collection('users').doc(steamId);
          const userDoc = await userRef.get();

          if (!userDoc.exists) {
            await userRef.set({
              steamId,
              steamName: steamName || `Steam ${steamId.slice(-4)}`,
              steamAvatar,
              createdAt: new Date().toISOString(),
              lastLogin: new Date().toISOString(),
              orders: []
            });
            console.log(`[Steam Auth] Created new user: ${steamId} (${steamName || 'no name'})`);
          } else {
            // Atualiza nome/avatar se conseguiu puxar da Steam (usuário pode ter trocado)
            const patch = { lastLogin: new Date().toISOString() };
            if (steamName) patch.steamName = steamName;
            if (steamAvatar) patch.steamAvatar = steamAvatar;
            await userRef.update(patch);
          }
        } catch (e) {
          console.log('[Steam Auth] Firestore write error:', e.message);
          // Don't fail auth if Firestore fails
        }

        // Gera Firebase custom token pra analise.html logar com signInWithCustomToken
        let firebaseCustomToken = null;
        try {
          const admin = require('firebase-admin');
          // Usa o steamId como uid no Firebase Auth — mesmo doc de /users/{steamId}
          firebaseCustomToken = await admin.auth().createCustomToken(steamId, {
            provider: 'steam',
            steamId,
          });
        } catch (e) {
          console.log('[Steam Auth] customToken error:', e.message);
        }

        return json(200, { success: true, steamId, firebaseCustomToken });
      } else {
        console.log(`[Steam Auth] Verification failed: ${verifyRes.body.substring(0, 200)}`);
        return json(401, { success: false, error: 'Steam verification failed' });
      }
    } catch (e) {
      console.error('[Steam Auth] Error:', e.message);
      return json(500, { error: 'Verification error: ' + e.message });
    }
  }

  return json(405, { error: 'Method not allowed' });
};
