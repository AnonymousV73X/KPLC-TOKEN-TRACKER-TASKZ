/**
 * Cloudflare Worker — Zero-Maintenance KPLC API Proxy & Scraper
 * 
 * Free deployment on Cloudflare Workers (100,000 requests/day free).
 * Automatically authenticates with KPLC APIM OAuth gateway and fetches token history.
 */

const PROD_BASIC_AUTH = "Basic aVBXZkZTZTI2NkF2eVZHc2xpWk45Nl8yTzVzYTp3R3lRZEFFa3MzRm9lSkZHU0ZZUndFMERUdGNh";
const PROD_BASE_URL = "https://selfservice.kplc.co.ke/api";
const PUBLIC_SCOPE = "token_public accounts_public attributes_public customers_public documents_public listData_public rccs_public sectorSupplies_public selfReads_public serviceRequests_public services_public streets_public supplies_public users_public workRequests_public publicData_public juaforsure_public calculator_public sscalculator_public";

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
    const meterNumber = url.searchParams.get("meter") || url.searchParams.get("serialNumberMeter");
    const accountNumber = url.searchParams.get("account") || url.searchParams.get("accountReference");

    if (!meterNumber && !accountNumber) {
      return new Response(JSON.stringify({ error: "Meter number or account number is required (?meter=12345678901)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      // 1. Get KPLC OAuth Bearer Token
      const tokenRes = await fetch(`${PROD_BASE_URL}/token`, {
        method: "POST",
        headers: {
          "Authorization": PROD_BASIC_AUTH,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Origin": "https://selfservice.kplc.co.ke",
          "Referer": "https://selfservice.kplc.co.ke/public/"
        },
        body: `grant_type=client_credentials&scope=${encodeURIComponent(PUBLIC_SCOPE)}`
      });

      if (!tokenRes.ok) {
        throw new Error(`KPLC auth failed with status ${tokenRes.status}`);
      }

      const tokenData = await tokenRes.json();
      const bearerToken = tokenData.access_token;
      if (!bearerToken) {
        throw new Error("Could not retrieve KPLC bearer access token");
      }

      // 2. Query Prepayment Records
      let queryUrl = `${PROD_BASE_URL}/publicData/4/newContractList?serialNumberMeter=${encodeURIComponent(meterNumber || "")}`;
      if (accountNumber) {
        queryUrl += `&accountReference=${encodeURIComponent(accountNumber)}`;
      }

      const dataRes = await fetch(queryUrl, {
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Origin": "https://selfservice.kplc.co.ke",
          "Referer": "https://selfservice.kplc.co.ke/public/"
        }
      });

      const responseBody = await dataRes.text();
      return new Response(responseBody, {
        status: dataRes.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
  }
};
