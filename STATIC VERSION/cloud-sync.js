/**
 * KPLC Autonomous Background Token Auto-Sync
 * Runs autonomously in GitHub Actions (Cron or Manual Trigger)
 *
 * Full Automation Flow:
 *  1. Authenticates as Firebase Admin using service account (FIREBASE_SERVICE_ACCOUNT).
 *  2. Discovers ALL registered meters in /meters.json across all users automatically.
 *  3. Solves KPLC Proof-of-Work CAPTCHA headlessly in ~5-10s.
 *  4. Queries KPLC via Cloudflare Worker proxy.
 *  5. Merges newly purchased tokens into each meter vault without duplicates.
 *  6. Zero manual user intervention required!
 */

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const FIREBASE_BASE_URL = 'https://kplc-a0763-default-rtdb.firebaseio.com';
const PROXY_WORKER_URL = 'https://kplc-tracker-proxy.captiosuskhid.workers.dev';

// Fast SHA-256 Round Constants
const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

function capPrng(seed, length) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  let state = hash >>> 0;
  let result = '';
  function next() {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0;
  }
  while (result.length < length) result += (next() >>> 0).toString(16).padStart(8, '0');
  return result.substring(0, length);
}

function solveSingleBlock(salt, targetUint16) {
  const m = new Uint32Array(16);
  const w = new Uint32Array(64);
  for (let j = 0; j < 8; j++) {
    m[j] = (salt.charCodeAt(j * 4) << 24) |
           (salt.charCodeAt(j * 4 + 1) << 16) |
           (salt.charCodeAt(j * 4 + 2) << 8) |
           salt.charCodeAt(j * 4 + 3);
  }
  const t0 = (targetUint16 >>> 8) & 0xff;
  const t1 = targetUint16 & 0xff;

  let nonce = 0;
  while (true) {
    const nStr = '' + nonce;
    const totalLen = 32 + nStr.length;
    m[8] = 0; m[9] = 0; m[10] = 0; m[11] = 0; m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 0;
    for (let j = 0; j < nStr.length; j++) {
      const bytePos = 32 + j;
      m[bytePos >> 2] |= nStr.charCodeAt(j) << (24 - ((bytePos & 3) * 8));
    }
    const padPos = totalLen;
    m[padPos >> 2] |= 0x80 << (24 - ((padPos & 3) * 8));
    m[15] = totalLen * 8;

    for (let j = 0; j < 16; j++) w[j] = m[j];
    for (let j = 16; j < 64; j++) {
      const s0 = (w[j-15]>>>7 | w[j-15]<<25) ^ (w[j-15]>>>18 | w[j-15]<<14) ^ (w[j-15]>>>3);
      const s1 = (w[j-2]>>>17 | w[j-2]<<15) ^ (w[j-2]>>>19 | w[j-2]<<13) ^ (w[j-2]>>>10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
    }

    let a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a;
    let e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;

    for (let j = 0; j < 64; j++) {
      const S1 = (e>>>6 | e<<26) ^ (e>>>11 | e<<21) ^ (e>>>25 | e<<7);
      const ch = (e & f) ^ (~e & g);
      const t1_v = (h + S1 + ch + SHA256_K[j] + w[j]) | 0;
      const S0 = (a>>>2 | a<<30) ^ (a>>>13 | a<<19) ^ (a>>>22 | a<<10);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1_v) | 0; d = c; c = b; b = a; a = (t1_v + t2) | 0;
    }

    const h0 = (0x6a09e667 + a) | 0;
    if (((h0 >>> 24) & 0xff) === t0 && ((h0 >>> 16) & 0xff) === t1) {
      return nonce;
    }
    nonce++;
  }
}

function solveCaptcha(token, cfg) {
  const solutions = {};
  for (let i = 1; i <= cfg.c; i++) {
    const salt = capPrng(token + i, cfg.s);
    const target = capPrng(token + i + 'd', cfg.d);
    const t0 = parseInt(target.substring(0, 2), 16);
    const t1 = parseInt(target.substring(2, 4), 16);
    solutions[i] = solveSingleBlock(salt, (t0 << 8) | t1);
  }
  return Array.from({ length: cfg.c }, (_, i) => solutions[i + 1]);
}

function getCaptchaToken() {
  const chRaw = execSync('curl -s -X POST "https://selfservice.kplc.co.ke/capcha/319f5ee7ab/challenge" -H "Content-Type: application/json" -d "{}"').toString();
  const ch = JSON.parse(chRaw);
  if (!ch || !ch.token || !ch.challenge) {
    throw new Error('Failed to retrieve CAPTCHA challenge');
  }

  const solutions = solveCaptcha(ch.token, ch.challenge);
  const tempFile = `temp_cap_${Date.now()}.json`;
  fs.writeFileSync(tempFile, JSON.stringify({ token: ch.token, solutions }));

  let redOut;
  try {
    redOut = execSync(`curl -s -X POST "https://selfservice.kplc.co.ke/capcha/319f5ee7ab/redeem" -H "Content-Type: application/json" --data-binary @${tempFile}`).toString();
  } finally {
    try { fs.unlinkSync(tempFile); } catch(e){}
  }

  const redData = JSON.parse(redOut);
  if (!redData || !redData.token) {
    throw new Error('CAPTCHA redeem failed: ' + redOut);
  }
  return redData.token;
}

// Generate Google OAuth2 Access Token from Service Account Key
async function getFirebaseAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsignedJwt = `${b64url(header)}.${b64url(claimSet)}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${unsignedJwt}.${signature}`;

  return new Promise((resolve, reject) => {
    const postData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(d);
          if (body.access_token) resolve(body.access_token);
          else reject(new Error('Failed to get token: ' + d));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function fetchJsonAuth(url, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

function putJsonAuth(url, data, token) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const u = new URL(url);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'PUT',
      headers: headers
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function normalizeTokenNumber(t) {
  if (!t) return '';
  return String(t).replace(/\D/g, '');
}

function getVaultHash(meter) {
  const clean = normalizeTokenNumber(meter);
  if (!clean) return null;
  return crypto.createHash('sha256').update('taskz_vault_v1_' + clean).digest('hex');
}

function deduplicateTokens(tokens) {
  if (!Array.isArray(tokens)) return [];
  const map = new Map();
  for (const t of tokens) {
    if (!t) continue;
    const cleanNum = normalizeTokenNumber(t.token_number);
    if (!cleanNum || cleanNum.length < 10) continue;
    if (!map.has(cleanNum)) {
      map.set(cleanNum, t);
    } else {
      const old = map.get(cleanNum);
      if ((old.units == null || isNaN(old.units)) && t.units != null) old.units = t.units;
      if ((old.amount == null || isNaN(old.amount)) && t.amount != null) old.amount = t.amount;
      if (t.payment_mode && (!old.payment_mode || old.payment_mode === 'M-PESA')) old.payment_mode = t.payment_mode;
      if (t.purchased_at && !old.purchased_at) old.purchased_at = t.purchased_at;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const da = a.purchased_at ? new Date(a.purchased_at).getTime() : 0;
    const db = b.purchased_at ? new Date(b.purchased_at).getTime() : 0;
    return db - da;
  });
}

async function syncMeter(meterInput, vaultHashInput, authToken) {
  const meter = normalizeTokenNumber(meterInput);
  if (!meter || meter.length < 5) return;

  const vaultHash = vaultHashInput || getVaultHash(meter);
  if (!vaultHash) return;

  console.log(`\n========================================`);
  console.log(`[Auto-Sync] Processing Meter: ${meter}`);
  console.log(`[Auto-Sync] Vault SHA-256: ${vaultHash.slice(0, 16)}...`);
  console.log(`========================================`);

  // 1. Fetch remote cloud state for this meter vault
  const vaultUrl = `${FIREBASE_BASE_URL}/meters/${vaultHash}.json`;
  const remoteData = await fetchJsonAuth(vaultUrl, authToken) || {};
  const existingTokens = deduplicateTokens(Array.isArray(remoteData.tokens) ? remoteData.tokens : Object.values(remoteData.tokens || {}));

  console.log(`[Auto-Sync] Existing tokens in cloud vault: ${existingTokens.length}`);

  // 2. Solve fresh CAPTCHA challenge
  console.log(`[Auto-Sync] Solving KPLC CAPTCHA challenge...`);
  const capToken = getCaptchaToken();
  console.log(`[Auto-Sync] CAPTCHA verified! Token: ${capToken.slice(0, 16)}...`);

  // 3. Query KPLC via Worker proxy
  const queryUrl = `${PROXY_WORKER_URL}/?meter=${encodeURIComponent(meter)}&captoken=${encodeURIComponent(capToken)}`;
  const workerRaw = execSync(`curl -s "${queryUrl}"`).toString();
  const workerData = JSON.parse(workerRaw);

  if (!workerData.ok && workerData.error) {
    console.warn(`[Auto-Sync] KPLC query response: ${workerData.error}`);
    return;
  }

  const kplcRecords = workerData.data?.[0]?.colPrepayment || [];
  const tariff = workerData.data?.[0]?.tariff || remoteData.tariff || 'Domestic';
  console.log(`[Auto-Sync] KPLC returned ${kplcRecords.length} prepayment records`);

  if (kplcRecords.length === 0) return;

  // 4. Map KPLC records into unified format
  const mappedIncoming = [];
  for (const item of kplcRecords) {
    const num = normalizeTokenNumber(item.tokenNo);
    if (!num || num.length < 10) continue;

    let units = item.trnUnits != null ? parseFloat(item.trnUnits) : null;
    let amount = item.trnAmount != null ? parseFloat(item.trnAmount) : null;

    if ((amount == null || amount === 0) && units != null && units > 0) {
      amount = Math.round(units * 25.0 * 100) / 100;
    } else if ((units == null || units === 0) && amount != null && amount > 0) {
      units = Math.round((amount / 25.0) * 100) / 100;
    }

    const dateStr = item.trnTimestamp ? new Date(item.trnTimestamp).toISOString() : new Date().toISOString();

    mappedIncoming.push({
      id: Date.now() + Math.floor(Math.random() * 1000),
      token_number: num,
      units: units,
      amount: amount,
      payment_mode: item.pMethod || 'M-PESA',
      purchased_at: dateStr,
      payer_label: null,
      source: 'kplc_sync'
    });
  }

  // 5. Merge and deduplicate
  const mergedTokens = deduplicateTokens([...existingTokens, ...mappedIncoming]);
  const newTokensFound = mergedTokens.length - existingTokens.length;

  console.log(`[Auto-Sync] Merged total tokens: ${mergedTokens.length} (+${newTokensFound} new)`);

  if (newTokensFound > 0 || !remoteData.meter) {
    const payload = {
      updated_at: new Date().toISOString(),
      meter: meter,
      tokens: mergedTokens,
      account: remoteData.account || null,
      tariff: tariff,
      rate_mode: remoteData.rate_mode || 'auto',
      manual_rate: remoteData.manual_rate || null
    };

    await putJsonAuth(vaultUrl, payload, authToken);
    console.log(`[Auto-Sync] Successfully updated cloud vault with ${mergedTokens.length} tokens!`);
  } else {
    console.log(`[Auto-Sync] No new tokens detected. Cloud vault already up to date.`);
  }
}

async function runAll() {
  let authToken = null;
  const metersToSync = [];

  // Check for Firebase Service Account Key (Enables 100% autonomous discovery of all users)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      console.log(`[Auto-Sync] Authenticating as Firebase Admin (${sa.client_email})...`);
      authToken = await getFirebaseAccessToken(sa);
      console.log(`[Auto-Sync] Firebase Admin authenticated successfully!`);

      // Dump all meters registered in the database automatically
      const metersData = await fetchJsonAuth(`${FIREBASE_BASE_URL}/meters.json`, authToken);
      if (metersData && typeof metersData === 'object') {
        for (const [hash, entry] of Object.entries(metersData)) {
          if (entry && entry.meter) {
            metersToSync.push({ meter: entry.meter, vaultHash: hash });
          }
        }
        console.log(`[Auto-Sync] Automatically discovered ${metersToSync.length} registered meter(s) in cloud database!`);
      }
    } catch (e) {
      console.warn(`[Auto-Sync] Firebase Admin auth failed: ${e.message}`);
    }
  }

  // Fallback to METERS env variable if configured
  if (metersToSync.length === 0 && process.env.METERS) {
    const list = process.env.METERS.split(',').map(s => s.trim()).filter(Boolean);
    for (const m of list) {
      metersToSync.push({ meter: m, vaultHash: getVaultHash(m) });
    }
  }

  if (metersToSync.length === 0) {
    console.log('[Auto-Sync] No registered meters found in database.');
    console.log('[Auto-Sync] Ensure FIREBASE_SERVICE_ACCOUNT secret is set in GitHub Actions.');
    return;
  }

  console.log(`[Auto-Sync] Starting background sync for ${metersToSync.length} meter(s)...`);

  for (const item of metersToSync) {
    try {
      await syncMeter(item.meter, item.vaultHash, authToken);
    } catch (err) {
      console.error(`[Auto-Sync] Error syncing meter ${item.meter}:`, err.message);
    }
  }

  console.log('\n[Auto-Sync] All scheduled meters processed.');
}

runAll().catch(err => {
  console.error('[Auto-Sync] Fatal run error:', err);
  process.exit(1);
});
