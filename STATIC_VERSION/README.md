# TASKZ — Static Edition (100% Client-Side)

A zero-backend, single-file HTML/CSS/JS edition of the KPLC Token Tracker.

## 🚀 Key Features
- **100% Static & Free:** Single `index.html` file that runs in any browser or on free static hosts (GitHub Pages, Cloudflare Pages, Netlify, Vercel).
- **LocalStorage Storage:** All your meter details, tokens, and settings are stored locally and privately on your own device.
- **KPLC Live Fetching:** Queries KPLC APIM for your meter via a CORS relay proxy.
- **1 Unit = 25 Ksh Fallback:** Automatically calculates missing or placeholder amounts (like `--`).
- **Interactive Chart:** Chart.js trend visualization for units and burn rate.
- **Backup & Restore:** One-click JSON export/import so you can transfer your tokens between devices.

## 🌐 How to Host for Free

### Option 1: GitHub Pages
1. Create a repository on GitHub.
2. Upload `index.html`.
3. Go to **Settings > Pages** > Set Source to `main` branch.
4. Your tracker is live at `https://<your-username>.github.io/<repo-name>/`!

### Option 2: Cloudflare Pages
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) > **Pages** > **Create a project**.
2. Connect your GitHub repository or drag-and-drop the `STATIC_VERSION` folder.
3. Deploy for free in 30 seconds!

---

### Optional: Deploy Your Own Cloudflare Worker CORS Proxy
If you want your own dedicated private CORS proxy instead of the default public relay:
1. In Cloudflare Dashboard, go to **Workers & Pages > Create application > Create Worker**.
2. Paste the code from `worker.js`.
3. Click **Deploy**.
4. In your TASKZ Static Settings, paste your worker URL (`https://your-worker.workers.dev?url=`).
