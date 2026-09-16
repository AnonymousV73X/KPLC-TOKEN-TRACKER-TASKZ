/**
 * Cloudflare Worker — KPLC Self-Service API Proxy (v3: browser-solved Cap PoW)
 *
 * Architecture:
 *   - The browser (kplc.surge.sh) solves the Cap PoW entirely (no CPU limits in browser).
 *   - The browser sends ?meter=XXX&captoken=<solved_token> to this worker.
 *   - This worker only does: OAuth bearer (cached) + KPLC search with the pre-solved token.
 *   - No PoW solving here → stays well under Cloudflare free-plan CPU limits.
 */

const PROD_BASIC_AUTH = "Basic aVBXZkZTZTI2NkF2eVZHc2xpWk45Nl8yTzVzYTp3R3lRZEFFa3MzRm9lSkZHU0ZZUndFMERUdGNh";
const PROD_BASE_URL = "https://selfservice.kplc.co.ke/api";
const PUBLIC_SCOPE = "token_public accounts_public attributes_public customers_public documents_public listData_public rccs_public sectorSupplies_public selfReads_public serviceRequests_public services_public streets_public supplies_public users_public workRequests_public publicData_public juaforsure_public calculator_public sscalculator_public";
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
// KPLC search (uses the pre-solved captcha token from the browser)
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
  // KPLC returns tokenNo as a bare integer — coerce to string to preserve precision
  const fixed = text.replace(/"tokenNo":\s*(\d+),/g, '"tokenNo":"$1",');
  let parsed;
  try { parsed = JSON.parse(fixed); }
  catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Main fetch handler
export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
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
      // 1. KPLC OAuth bearer (cached ~1 hr)
      const bearer = await getBearerToken();

      // 2. Query KPLC with the pre-solved captcha token from the browser
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

      // Return HTTP 200 even for KPLC 422 so browser can read the error body
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
};
