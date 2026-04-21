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

    return json(400, { error: 'Missing action parameter' });
  }

  // POST: Verify Steam callback
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON' });
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

        // Try to log user to Firestore
        try {
          const admin = require('firebase-admin');
          const db = admin.firestore();
          const userRef = db.collection('users').doc(steamId);
          const userDoc = await userRef.get();

          if (!userDoc.exists) {
            // New user
            await userRef.set({
              steamId: steamId,
              createdAt: new Date().toISOString(),
              lastLogin: new Date().toISOString(),
              orders: []
            });
            console.log(`[Steam Auth] Created new user: ${steamId}`);
          } else {
            // Update last login
            await userRef.update({
              lastLogin: new Date().toISOString()
            });
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
