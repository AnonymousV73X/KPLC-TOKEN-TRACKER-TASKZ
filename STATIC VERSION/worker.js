/**
 * Cloudflare Worker — KPLC Self-Service API Proxy & Autonomous Sync Engine
 *
 * Capabilities:
 *  1. fetch(): Handles live CORS requests from web app (OAuth bearer cache + search).
 *  2. scheduled(): Cloudflare Cron Trigger (Runs every 30 mins) to auto-sync registered meters.
 */

const PROD_BASIC_AUTH = "Basic aVBXZkZTZTI2NkF2eVZHc2xpWk45Nl8yTzVzYTp3R3lRZEFFa3MzRm9lSkZHU0ZZUndFMERUdGNh";
const PROD_BASE_URL = "https://selfservice.kplc.co.ke/api";
const PUBLIC_SCOPE = "token_public accounts_public attributes_public customers_public documents_public listData_public rccs_public sectorSupplies_public selfReads_public serviceRequests_public services_public streets_public supplies_public users_public workRequests_public publicData_public juaforsure_public calculator_public sscalculator_public";
const FIREBASE_BASE_URL = "https://kplc-a0763-default-rtdb.firebaseio.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

let _bearerToken = null;
let _bearerExpiry = 0;

// ---------------------------------------------------------------------------
// KPLC OAuth bearer (cached ~1 hr across warm isolate restarts)
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
// KPLC search (uses pre-solved captcha token)
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
// Lightweight In-Worker CAPTCHA Solver for Cloudflare Edge
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
// Helpers
function normalizeTokenNumber(t) {
  if (!t) return "";
  return String(t).replace(/\D/g, "");
}

async function sha256Hex(msg) {
  const encoder = new TextEncoder();
  const data = encoder.encode(msg);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
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
// Autonomous Scheduled Sync Engine
async function runAutonomousSync(env) {
  console.log("[Edge Cron] Starting scheduled 30-min background sync...");

  // Support reading configured meters from Cloudflare Environment Variable (METERS)
  const configuredMeters = (env && env.METERS) ? env.METERS.split(",").map(s => s.trim()).filter(Boolean) : [];

  if (configuredMeters.length === 0) {
    console.log("[Edge Cron] No meters configured in Cloudflare env.METERS. Sleeping.");
    return;
  }

  // Solve CAPTCHA once for this execution run
  let capToken = null;
  try {
    capToken = await solveEdgeCaptcha();
    console.log(`[Edge Cron] Solved CAPTCHA: ${capToken.slice(0, 16)}...`);
  } catch (e) {
    console.error("[Edge Cron] Failed solving CAPTCHA at edge:", e.message);
    return;
  }

  const bearer = await getBearerToken();

  for (const rawMeter of configuredMeters) {
    const meter = normalizeTokenNumber(rawMeter);
    if (!meter || meter.length < 5) continue;

    const vaultHash = await sha256Hex("taskz_vault_v1_" + meter);
    const vaultUrl = `${FIREBASE_BASE_URL}/meters/${vaultHash}.json`;

    try {
      // 1. Fetch current remote vault data
      const remoteRes = await fetch(vaultUrl);
      const remoteData = remoteRes.ok ? await remoteRes.json() : {};
      const existingTokens = deduplicateTokens(Array.isArray(remoteData?.tokens) ? remoteData.tokens : Object.values(remoteData?.tokens || {}));

      // 2. Query KPLC
      const search = await searchMeter(bearer, capToken, meter, null);
      if (search.status !== 200 || !search.body?.data) {
        console.warn(`[Edge Cron] KPLC search returned ${search.status} for meter ${meter}`);
        continue;
      }

      const kplcRecords = search.body.data[0]?.colPrepayment || [];
      const tariff = search.body.data[0]?.tariff || remoteData?.tariff || "Domestic";

      if (kplcRecords.length === 0) continue;

      // 3. Map new tokens
      const incoming = [];
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

        incoming.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          token_number: num,
          units: units,
          amount: amount,
          payment_mode: item.pMethod || "M-PESA",
          purchased_at: dateStr,
          payer_label: null,
          source: "kplc_sync"
        });
      }

      const mergedTokens = deduplicateTokens([...existingTokens, ...incoming]);
      const newCount = mergedTokens.length - existingTokens.length;

      if (newCount > 0 || !remoteData?.meter) {
        const payload = {
          updated_at: new Date().toISOString(),
          meter: meter,
          tokens: mergedTokens,
          account: remoteData?.account || null,
          tariff: tariff,
          rate_mode: remoteData?.rate_mode || "auto",
          manual_rate: remoteData?.manual_rate || null
        };

        await fetch(vaultUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        console.log(`[Edge Cron] Updated vault for meter ${meter} with ${mergedTokens.length} tokens (+${newCount} new)!`);
      } else {
        console.log(`[Edge Cron] Meter ${meter} already up to date.`);
      }
    } catch (err) {
      console.error(`[Edge Cron] Error processing meter ${meter}:`, err.message);
    }
  }

  console.log("[Edge Cron] Scheduled sync completed.");
}

// ---------------------------------------------------------------------------
// Worker Export (HTTP + Scheduled Cron)
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

    // Optional manual sync trigger endpoint: /sync-cron
    if (url.pathname === "/sync-cron") {
      ctx.waitUntil(runAutonomousSync(env));
      return new Response(JSON.stringify({ ok: true, message: "Sync triggered in background" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
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

  // Native Cloudflare Scheduled Cron Handler
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutonomousSync(env));
  }
};
