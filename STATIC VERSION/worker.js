/**
 * Cloudflare Worker — KPLC Self-Service API Proxy & 100% Autonomous Sync Engine
 *
 * Capabilities:
 *  1. fetch(): Live CORS proxy for client-side search requests.
 *  2. scheduled(): Automated cron trigger (runs every 30 mins) that:
 *     - Automatically signs a Google OAuth2 Admin JWT at the edge.
 *     - Dumps ALL registered meters across all users from Firebase RTDB.
 *     - Solves KPLC Proof-of-Work CAPTCHA challenge at the edge.
 *     - Fetches newly purchased tokens for every meter.
 *     - Deduplicates and writes new tokens back to each user's vault.
 *     - ZERO manual meter configuration required!
 */

const PROD_BASIC_AUTH = "Basic aVBXZkZTZTI2NkF2eVZHc2xpWk45Nl8yTzVzYTp3R3lRZEFFa3MzRm9lSkZHU0ZZUndFMERUdGNh";
const PROD_BASE_URL = "https://selfservice.kplc.co.ke/api";
const PUBLIC_SCOPE = "token_public accounts_public attributes_public customers_public documents_public listData_public rccs_public sectorSupplies_public selfReads_public serviceRequests_public services_public streets_public supplies_public users_public workRequests_public publicData_public juaforsure_public calculator_public sscalculator_public";
const FIREBASE_BASE_URL = "https://kplc-a0763-default-rtdb.firebaseio.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Firebase Admin Service Account credentials for autonomous discovery
const FIREBASE_ADMIN = {
  client_email: "firebase-adminsdk-fbsvc@kplc-a0763.iam.gserviceaccount.com",
  private_key: `-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQDC+z61d2aKu15Z
Fj/dvOtz8J/sAvfZgVSA79bTitgnC+MwqNJg0Afd+PX0gzSN2rZBQn/UE3SYbZF2
yQJ3/DR7CwT4mIqjULm1Az0GEH2afGTvNOXwhdbY64C23I6SjvOH29NDKc3dFxSK
WB6zkwhr8ylXdBJptlMDQIDwsrqGX3aOlaxkOM6Z6mlgJWymvniu4MeVNp98DH+i
Sf5uEml9tyAsZMVWNlUebuADt2zG9c8wXIP31ExVcgiI4IiW7t84NhKWITOtDxDA
1WH4fKj8H71HKPhrty72yD7GzC29pZmRRnXgP+MahUbursHFrapbwzJXRDk4ucCw
ogpl07f3AgMBAAECgf8/BCVGXFa1f7RyRzJpKIc5ic5Wl0mn49VlvjZ5QITw3LwE
WWcSmeBSjgWCH3fWqhAAaP2eJYb9KlPrX2Edoy53ibCRm5bRhuocnKAWQ2K2VE0N
3eApvcKHoie0X6BG1hFAuPXduQCAhly1fjMYpcgAugnNJ6QhJMXsff60Xn0CmtiB
zW8HGlL0ldbUuwyNlNc3kI5ZOzFZHq6OYQ3o6Ve6A6XNDrD9irIDS+AtiCe05pU5
R6pAdeBOnUhKdYgafEWVTES6d7xrS1YEFiSWlHLdjQlBUDuJ5jZrcRDsMx7eUs7L
tKswqrf/fSi0frKUoTre8yWCU7TwsAjP8+AFv40CgYEA/hEhn5CnXtgzajFQ0kTG
Nvtb4nmoxmSZ+v9gddsaIL/xCTAWPxb81iBWQ7RZcYi56VpF5ah1Of5T2oUOtNuC
JX9sowFPFQJp4XLr39nzbacZCvaBMH8kCW9N4pUqXfgx7sb8wiwcQKHiBT0IWw4T
GCfaLnuiLmD824SBYz2S8IUCgYEAxHcHDk84F7B2SbNK2EVZ1B2spECtsUkqFRKN
nvWlETWiTqliSpMTRsLkSC+bbC0w6MQrS44eEV17iUoW43N4h7WM+HNhhCoSmrYs
M+56PIhf62tY2IPs1bdmvAPfHipUn3HX2JDYQjD6b9+osQllFY1ziF5UiZxkf0nI
VVB2jUsCgYBfV+p4SP6mVxgkV9FutyRzaay3ttQhb4thaAi48bpCZAV+Xy9aCbRk
XspAqiOOubKa4aetYaRsWQb60EgOkvmqPMF2An288qTtWAUwgkgZ9EUvmgYtPuk1
KTHfP/8gOI30f3RHIeqQTq/VK2xBT2zW+c2k9/yKzxbVAkrUBT1pSQKBgBswletn
D05H/7bnd15DCtGOYcxBn0g/5fEQpkTvni6pi5LzYkUL4ckTQ+CxpgLspi4wqAVG
3+ZrV6OCe3RzEKVHfQENhttxry12NNvjD0u9W/kK3Drq1yYkwbUXnBNirF98s/Cm
6ycN/Drraz9FG5ZGA01GMNDysf3jyjP0dNPNAoGBANminlkl3PADgJ4HRa2uyBVT
8B6lMx3b+xQkt4VSsG2TLFAOQvKozU5UGPP88mQNaZLMwLqnzYMqce5gDDwZvZ5U
e7pqJluw6UTg2Xw0RNmirBTguGZ7FpHOAhtFJheEjVgl8ssGbnCz+G8lyAhOQKqH
RkjS+tQy6V1s34yec0m4
-----END PRIVATE KEY-----`
};

let _bearerToken = null;
let _bearerExpiry = 0;

// ---------------------------------------------------------------------------
// 1. Google OAuth2 Service Account Token Generator (Web Crypto API)
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^\n]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getFirebaseAdminAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: FIREBASE_ADMIN.client_email,
    scope: "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaim = base64UrlEncode(JSON.stringify(claimSet));
  const unsignedToken = `${encodedHeader}.${encodedClaim}`;

  // Import PKCS#8 private key
  const binaryKey = pemToArrayBuffer(FIREBASE_ADMIN.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const assertion = `${unsignedToken}.${encodedSignature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("Failed to obtain Firebase Admin access token: " + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ---------------------------------------------------------------------------
// 2. KPLC OAuth Bearer (cached ~1 hr)
async function getBearerToken() {
  if (_bearerToken && Date.now() < _bearerExpiry) return _bearerToken;

  const res = await fetch(`${PROD_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Authorization": PROD_BASIC_AUTH,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": UA,
      "Origin": "https://selfservice.kplc.co.ke",
      "Referer": "https://selfservice.kplc.co.ke/public/",
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(PUBLIC_SCOPE)}`,
  });
  if (!res.ok) throw new Error(`KPLC OAuth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("KPLC OAuth returned no access_token");
  _bearerToken = data.access_token;
  _bearerExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _bearerToken;
}

// ---------------------------------------------------------------------------
// 3. KPLC Search
async function searchMeter(bearer, captcha, meter, account) {
  const params = new URLSearchParams();
  if (meter) params.set("serialNumberMeter", meter);
  if (account) params.set("accountReference", account);

  const res = await fetch(`${PROD_BASE_URL}/publicData/4/search?${params.toString()}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "x-self-service-channel": "WEB",
      "x-ss-authorization": "none",
      "x-incms-origin": "desktop",
      "x-incms-origin-d": "",
      "x-ss-captcha": captcha,
      "User-Agent": UA,
      "Origin": "https://selfservice.kplc.co.ke",
      "Referer": "https://selfservice.kplc.co.ke/public/",
    },
  });
  const text = await res.text();
  const fixed = text.replace(/"tokenNo":\s*(\d+),/g, '"tokenNo":"$1",');
  let parsed;
  try { parsed = JSON.parse(fixed); }
  catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// 4. In-Worker Fast Single-Block SHA-256 CAPTCHA Solver
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
  let result = "";
  function next() {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0;
  }
  while (result.length < length) result += (next() >>> 0).toString(16).padStart(8, "0");
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
    const nStr = "" + nonce;
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

async function solveEdgeCaptcha() {
  const capBase = "https://selfservice.kplc.co.ke/capcha/319f5ee7ab";
  const chRes = await fetch(`${capBase}/challenge`, {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: "{}"
  });
  if (!chRes.ok) throw new Error(`Challenge fetch failed: ${chRes.status}`);
  const chData = await chRes.json();
  const token = chData.token;
  const cfg = chData.challenge || { c: 80, s: 32, d: 4 };

  const solutions = [];
  for (let i = 1; i <= cfg.c; i++) {
    const salt = capPrng(token + i, cfg.s);
    const target = capPrng(token + i + "d", cfg.d);
    const t0 = parseInt(target.substring(0, 2), 16);
    const t1 = parseInt(target.substring(2, 4), 16);
    solutions.push(solveSingleBlock(salt, (t0 << 8) | t1));
  }

  const redRes = await fetch(`${capBase}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ token, solutions })
  });
  if (!redRes.ok) throw new Error(`Redeem failed: ${redRes.status}`);
  const redData = await redRes.json();
  return redData.token;
}

// ---------------------------------------------------------------------------
// 5. Helpers
function normalizeTokenNumber(t) {
  if (!t) return "";
  return String(t).replace(/\D/g, "");
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
      if (t.payment_mode && (!old.payment_mode || old.payment_mode === "M-PESA")) old.payment_mode = t.payment_mode;
      if (t.purchased_at && !old.purchased_at) old.purchased_at = t.purchased_at;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const da = a.purchased_at ? new Date(a.purchased_at).getTime() : 0;
    const db = b.purchased_at ? new Date(b.purchased_at).getTime() : 0;
    return db - da;
  });
}

// ---------------------------------------------------------------------------
// 6. 100% Autonomous Scheduled Sync Engine (Zero Manual Input)
async function runAutonomousSync() {
  console.log("[Edge Cron] Starting fully autonomous 30-min background sync...");

  let authToken;
  try {
    authToken = await getFirebaseAdminAccessToken();
    console.log("[Edge Cron] Firebase Admin authenticated successfully!");
  } catch (err) {
    console.error("[Edge Cron] Admin auth error:", err.message);
    return;
  }

  // Automatically dump ALL registered meters from Firebase
  let metersData;
  try {
    const res = await fetch(`${FIREBASE_BASE_URL}/meters.json`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    metersData = await res.json();
  } catch (err) {
    console.error("[Edge Cron] Failed reading meters from database:", err.message);
    return;
  }

  if (!metersData || typeof metersData !== "object") {
    console.log("[Edge Cron] No registered meters found in database. Exiting.");
    return;
  }

  const metersToSync = [];
  for (const [hash, entry] of Object.entries(metersData)) {
    if (entry && entry.meter) {
      metersToSync.push({ meter: entry.meter, vaultHash: hash, currentData: entry });
    }
  }

  console.log(`[Edge Cron] Automatically discovered ${metersToSync.length} registered meter(s)!`);
  if (metersToSync.length === 0) return;

  let capToken;
  let capExpiry = 0;
  async function getValidCapToken() {
    if (capToken && Date.now() < capExpiry) return capToken;
    capToken = await solveEdgeCaptcha();
    capExpiry = Date.now() + 12 * 60 * 1000; // valid for ~12 mins
    return capToken;
  }

  try {
    await getValidCapToken();
    console.log(`[Edge Cron] Solved initial CAPTCHA: ${capToken.slice(0, 16)}...`);
  } catch (e) {
    console.error("[Edge Cron] Failed solving initial CAPTCHA:", e.message);
    return;
  }

  const bearer = await getBearerToken();

// ---------------------------------------------------------------------------
// 6. Notification Dispatcher & Usage Calculator
function computeRemainingUnits(tokens, manualRate) {
  if (!tokens || tokens.length === 0) return { unitsLeft: 0, daysLeft: 0, rate: 0 };
  const valid = tokens
    .filter(t => t.purchased_at && t.units && t.units > 0)
    .map(t => ({ ...t, date: new Date(t.purchased_at), units: parseFloat(t.units) }))
    .filter(t => !isNaN(t.date.getTime()))
    .sort((a, b) => a.date - b.date);

  if (valid.length === 0) return { unitsLeft: 0, daysLeft: 0, rate: 0 };
  let rate = manualRate > 0 ? manualRate : 0;
  if (rate <= 0 && valid.length >= 2) {
    const rates = [];
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1];
      const curr = valid[i];
      const daysBetween = (curr.date - prev.date) / (1000 * 60 * 60 * 24);
      if (daysBetween > 0.083 && daysBetween < 90 && prev.units > 0) {
        rates.push(prev.units / daysBetween);
      }
    }
    if (rates.length > 0) {
      rates.sort((a, b) => a - b);
      rate = rates[Math.floor(rates.length / 2)];
    }
  }
  if (rate <= 0 && valid[valid.length - 1].units) {
    rate = valid[valid.length - 1].units / 7.0; // fallback 1 week
  }
  rate = Math.max(0.01, rate || 1.0);

  const now = new Date();
  let balance = 0;
  let lastDate = valid[0].date;
  for (let i = 0; i < valid.length; i++) {
    const tok = valid[i];
    const days = Math.max(0, (tok.date - lastDate) / (1000 * 60 * 60 * 24));
    balance = Math.max(0, balance - (days * rate));
    balance += tok.units;
    lastDate = tok.date;
  }
  const finalDays = Math.max(0, (now - lastDate) / (1000 * 60 * 60 * 24));
  balance = Math.max(0, balance - (finalDays * rate));
  const daysLeft = rate > 0 ? (balance / rate) : 0;
  return { unitsLeft: balance, daysLeft: daysLeft, rate: rate };
}

// Default community Telegram Bot token (can also be overridden via env.TELEGRAM_BOT_TOKEN)
const DEFAULT_TG_BOT_TOKEN = "7758284561:AAEB7Xz2N_N4d-1_X-example"; // Placeholder or user-configured

async function dispatchAlert(channel, recipient, message, env) {
  try {
    if (channel === "whatsapp") {
      const { phone, apikey } = recipient;
      if (!phone || !apikey) return { ok: false, error: "Missing WhatsApp phone or CallMeBot API key" };
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;
      const res = await fetch(waUrl);
      return { ok: res.ok, status: res.status };
    } else {
      // Telegram
      const botToken = env?.TELEGRAM_BOT_TOKEN || "7981245890:AAH-KPLC-ALERTS-DEMO";
      const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const res = await fetch(tgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: recipient.chat_id,
          text: message,
          parse_mode: "Markdown"
        })
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data: data };
    }
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// Process meters concurrently in chunks of 5
  const CHUNK_SIZE = 5;
  for (let i = 0; i < metersToSync.length; i += CHUNK_SIZE) {
    const chunk = metersToSync.slice(i, i + CHUNK_SIZE);
    console.log(`[Edge Cron] Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} meters concurrent)...`);

    await Promise.all(chunk.map(async (item) => {
      const { meter, vaultHash, currentData } = item;
      const vaultUrl = `${FIREBASE_BASE_URL}/meters/${vaultHash}.json`;

      try {
        const existingTokens = deduplicateTokens(Array.isArray(currentData?.tokens) ? currentData.tokens : Object.values(currentData?.tokens || {}));

        let activeCap = await getValidCapToken();
        let search = await searchMeter(bearer, activeCap, meter, null);

        // If captcha expired mid-batch, solve fresh one and retry once
        if (search.status === 422 && search.body?.error?.includes("captcha")) {
          capToken = null; // force fresh solve
          activeCap = await getValidCapToken();
          search = await searchMeter(bearer, activeCap, meter, null);
        }

        if (search.status !== 200 || !search.body?.data) {
          console.warn(`[Edge Cron] KPLC search status ${search.status} for meter ${meter}`);
          return;
        }

        const kplcRecords = search.body.data[0]?.colPrepayment || [];
        const tariff = search.body.data[0]?.tariff || currentData?.tariff || "Domestic";

        if (kplcRecords.length === 0) return;

        const incoming = [];
        for (const rec of kplcRecords) {
          const num = normalizeTokenNumber(rec.tokenNo);
          if (!num || num.length < 10) continue;

          let units = rec.trnUnits != null ? parseFloat(rec.trnUnits) : null;
          let amount = rec.trnAmount != null ? parseFloat(rec.trnAmount) : null;

          if ((amount == null || amount === 0) && units != null && units > 0) {
            amount = Math.round(units * 25.0 * 100) / 100;
          } else if ((units == null || units === 0) && amount != null && amount > 0) {
            units = Math.round((amount / 25.0) * 100) / 100;
          }

          const dateStr = rec.trnTimestamp ? new Date(rec.trnTimestamp).toISOString() : new Date().toISOString();

          incoming.push({
            id: Date.now() + Math.floor(Math.random() * 1000),
            token_number: num,
            units: units,
            amount: amount,
            payment_mode: rec.pMethod || "M-PESA",
            purchased_at: dateStr,
            payer_label: null,
            source: "kplc_sync"
          });
        }

        const mergedTokens = deduplicateTokens([...existingTokens, ...incoming]);
        const newCount = mergedTokens.length - existingTokens.length;

        if (newCount > 0 || !currentData?.meter) {
          const payload = {
            updated_at: new Date().toISOString(),
            meter: meter,
            tokens: mergedTokens,
            account: currentData?.account || null,
            tariff: tariff,
            rate_mode: currentData?.rate_mode || "auto",
            manual_rate: currentData?.manual_rate || null,
            alert_settings: currentData?.alert_settings || null
          };

          await fetch(vaultUrl, {
            method: "PUT",
            headers: {
              "Authorization": `Bearer ${authToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });
          console.log(`[Edge Cron] ✅ Updated meter ${meter} with ${mergedTokens.length} tokens (+${newCount} new)!`);
        } else {
          console.log(`[Edge Cron] ⚡ Meter ${meter} already up to date.`);
        }

        // Check Low Power Alert trigger
        const alertSettings = currentData?.alert_settings;
        if (alertSettings && alertSettings.enabled) {
          const manualRate = parseFloat(currentData?.manual_rate) || 0;
          const status = computeRemainingUnits(mergedTokens, manualRate);
          const threshold = parseFloat(alertSettings.threshold) || 5.0;

          if (status.unitsLeft <= threshold) {
            // Check last alert sent timestamp (throttle to once per 24 hours to avoid spam)
            const lastAlertAt = alertSettings.last_alert_at ? new Date(alertSettings.last_alert_at).getTime() : 0;
            const nowMs = Date.now();
            if (nowMs - lastAlertAt > 24 * 60 * 60 * 1000) {
              const msg = `⚠️ *KPLC Low Power Alert!*\\n\\nMeter: \`${meter}\`\\nRemaining: *${status.unitsLeft.toFixed(1)} kWh* (~${status.daysLeft.toFixed(1)} days left)\\nDaily burn: ~${status.rate.toFixed(1)} kWh/day\\n\\nPlease top up soon to avoid blackout!`;
              const res = await dispatchAlert(alertSettings.channel, {
                chat_id: alertSettings.telegram_chat_id,
                phone: alertSettings.whatsapp_phone,
                apikey: alertSettings.whatsapp_apikey
              }, msg);

              if (res.ok) {
                console.log(`[Edge Cron] 🔔 Alert sent to meter ${meter} via ${alertSettings.channel}!`);
                // Update last_alert_at in Firebase
                alertSettings.last_alert_at = new Date().toISOString();
                await fetch(`${FIREBASE_BASE_URL}/meters/${vaultHash}/alert_settings.json`, {
                  method: "PATCH",
                  headers: {
                    "Authorization": `Bearer ${authToken}`,
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({ last_alert_at: alertSettings.last_alert_at })
                });
              } else {
                console.warn(`[Edge Cron] Failed dispatching alert to meter ${meter}:`, res.error);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Edge Cron] Error processing meter ${meter}:`, err.message);
      }
    }));
  }

  console.log(`[Edge Cron] Scheduled sync of ${metersToSync.length} meter(s) completed successfully.`);
}

// ---------------------------------------------------------------------------
// Main Worker Exports
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Instant on-demand sync trigger endpoint: /sync-now
    if (url.pathname === "/sync-now") {
      ctx.waitUntil(runAutonomousSync());
      return new Response(JSON.stringify({ ok: true, message: "Autonomous sync triggered in background" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Direct alert dispatch endpoint (for testing or instant notification): /send-alert
    if (url.pathname === "/send-alert" && request.method === "POST") {
      try {
        const body = await request.json();
        const { meter, channel, telegram_chat_id, whatsapp_phone, whatsapp_apikey, is_test } = body;
        const msg = is_test
          ? `🔔 *KPLC Token Tracker Test Alert*\\n\\nMeter: \`${meter || "Test"}\`\\nYour notifications are configured correctly! You will receive automatic alerts when power drops low.`
          : body.message || "⚠️ KPLC Alert!";

        const res = await dispatchAlert(channel, {
          chat_id: telegram_chat_id,
          phone: whatsapp_phone,
          apikey: whatsapp_apikey
        }, msg, env);

        return new Response(JSON.stringify(res), {
          status: res.ok ? 200 : 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    const meter    = url.searchParams.get("meter")   || url.searchParams.get("serialNumberMeter");
    const account  = url.searchParams.get("account") || url.searchParams.get("accountReference");
    const captoken = url.searchParams.get("captoken");

    if (!meter && !account) {
      return new Response(JSON.stringify({
        error: "Meter number or account number is required (?meter=12345678901)",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!captoken) {
      return new Response(JSON.stringify({
        error: "Missing captoken — browser must solve Cap PoW and pass ?captoken=",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startedAt = Date.now();
    try {
      const bearer = await getBearerToken();
      const search = await searchMeter(bearer, captoken, meter, account);

      const elapsedMs = Date.now() - startedAt;
      const upstreamData = search.body?.data || [];
      const upstreamErr = (search.status !== 200 && search.body)
        ? (search.body.msgUser || search.body.message || `KPLC returned HTTP ${search.status}`)
        : null;

      const outBody = {
        ok: search.status === 200,
        status: search.status,
        elapsed_ms: elapsedMs,
        data: upstreamData,
        error: upstreamErr,
        code: search.body?.code || null,
        raw: search.body?.raw || null,
      };

      const httpStatus = (search.status === 200 || search.status === 422) ? 200 : 502;
      return new Response(JSON.stringify(outBody), {
        status: httpStatus,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: err.message,
        elapsed_ms: Date.now() - startedAt,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },

  // 100% Autonomous Scheduled Cron Handler (Fires every 30 mins)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutonomousSync());
  }
};
