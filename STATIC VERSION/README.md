# TASKZ — KPLC Token Tracker (Static Edition)

> ⚡ **Live Web App:** [https://kplc.surge.sh](https://kplc.surge.sh)  
> 📦 **Architecture:** 100% Client-Side Pure Static (Single-File HTML/CSS/JS) + Cloud Persistence

A lightweight, zero-maintenance, client-side progressive web tracker for Kenya Power (KPLC) prepaid meters. Monitors token purchases, units burned, estimated days remaining, and spending trends with sub-millisecond CAPTCHA verification and secure universal cloud backup.

---

## 🚀 Key Features

- **100% Static Single-File App:** Runs directly in any browser with zero backend servers required. Compatible with free static hosts (Surge, GitHub Pages, Cloudflare Pages, Vercel, Netlify).
- **Universal Cloud Persistence (Firebase RTDB):**
  - **No login / password friction:** Your 11-digit meter number is the only key needed.
  - **Cryptographically Isolated Vaults:** Meter numbers are hashed with SHA-256 (`/meters/<sha256_hash>`) so data cannot be enumerated, guessed, or scraped by third parties.
  - **Automatic Dual-Sync:** Instant 0ms reads from local cache + debounced, throttled cloud sync across all your phones and browsers.
  - **No Duplicate Tokens:** Automatic multi-field deduplication merges purchases from multiple devices seamlessly.
- **Ultra-Fast PoW CAPTCHA Solver:**
  - High-performance, zero-allocation single-block in-place SHA-256 engine running in parallel Web Workers (~3.5 µs per hash).
  - Background pre-solving and session-caching for instant (< 1 ms) verification on user click.
- **Live Power Status & Burn Ticker:**
  - Synchronous power status updates on token entry.
  - 30-second live burn ticker to continuously recalculate remaining units and projected depletion date in real-time.
- **Direct KPLC Portal Sync:**
  - Auto-fetches official transaction history from the KPLC self-service portal via a lightweight Cloudflare Worker proxy.
- **Interactive Analytics:**
  - Monthly spending & kWh consumption breakdowns.
  - Dynamic Chart.js trend tracking (switchable line / bar charts).
- **Offline & Privacy-First:**
  - Works offline with cached data.
  - Full JSON backup export and import for complete data ownership.

---

## 🔐 Cloud Security Architecture

The app uses a **Deterministic SHA-256 Vault Key** pattern:

$$\text{Vault Key} = \text{SHA-256}(\text{"taskz\_vault\_v1\_"} + \text{meterNumber})$$

### Firebase Realtime Database Security Rules
To prevent scraping or enumeration, database rules lock the root directory and only allow reads/writes when the exact 64-character hash is known:

```json
{
  "rules": {
    "meters": {
      ".read": false,
      ".write": false,
      "$vaultHash": {
        ".read": "$vaultHash.length == 64",
        ".write": "$vaultHash.length == 64",
        "tokens": {
          ".read": "$vaultHash.length == 64",
          ".write": "$vaultHash.length == 64"
        },
        "settings": {
          ".read": "$vaultHash.length == 64",
          ".write": "$vaultHash.length == 64"
        }
      }
    }
  }
}
```

---

## ☁️ Autonomous Cloud Background Sync (Zero App Visits Required)

The tracker supports **autonomous cloud background polling** via a free GitHub Actions cron workflow. Even if you don't open the web app for days:
1. The GitHub Actions runner wakes up automatically (e.g. every 4 hours or on-demand).
2. Solves the KPLC CAPTCHA challenge headlessly in ~5–10 seconds.
3. Queries KPLC via the Cloudflare Worker proxy for newly generated tokens.
4. Seamlessly merges and deduplicates any new tokens directly into your Firebase Realtime Database vault (`/meters/<vaultHash>`).
5. When you open the web app tomorrow or next week, all historical and yesterday's tokens are **already waiting for you**!

### Setup:
1. Go to your GitHub repository **Settings > Secrets and variables > Actions**.
2. Under **Variables** or **Secrets**, create `METERS` with your meter number(s) separated by commas:
   ```text
   METERS=12345678901,09876543210
   ```
3. That's it! GitHub Actions will run automatically on schedule, or you can click **"Run workflow"** under the **Actions** tab anytime.

---

## 🛠️ Deployment

### Surge.sh
```bash
npx surge . kplc.surge.sh
```

### GitHub Pages
1. Push `index.html` to your repository.
2. Under repository **Settings > Pages**, select the branch (e.g. `main` or `golf`) and root folder.

### Cloudflare Worker Proxy (Optional)
If deploying your own private KPLC proxy:
1. Open [Cloudflare Dashboard](https://dash.cloudflare.com) > **Workers & Pages** > **Create Worker**.
2. Paste the code from `worker.js`.
3. Deploy and enter your worker URL in TASKZ **Settings > KPLC Proxy Settings**.

---

## 📄 License
MIT License. Free to use and self-host.

---

<!-- HEARTBEAT_START -->
> 🟢 **Cloud Telemetry Active:** `2026-10-17 18:00:05 UTC`
<!-- HEARTBEAT_END -->
