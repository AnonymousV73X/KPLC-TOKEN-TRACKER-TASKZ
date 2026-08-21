/**
 * TASKZ — Frontend Application (KPLC-inspired UI)
 * Meter-number based session: enter meter number → auto account → dashboard
 * Theme: light/dark toggle with localStorage persistence
 */

const App = (() => {
  const API = "/api";
  let token = localStorage.getItem("taskz_token");
  let dashboardData = null;
  let tokenPage = 1;
  let allTokensLoaded = false;
  let usageChart = null;

  // ===== Theme =====
  const THEME_KEY = "taskz_theme";

  function getStoredTheme() {
    return (
      localStorage.getItem(THEME_KEY) ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light")
    );
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta)
      meta.setAttribute("content", theme === "dark" ? "#0B1220" : "#002D62");
    // Refresh chart colors if chart exists
    if (usageChart && dashboardData !== null) {
      updateChartColors(usageChart);
    }
  }

  function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    // Sync segment control buttons
    document.querySelectorAll(".theme-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeSet === theme);
    });
  }

  function toggleTheme() {
    const current =
      document.documentElement.getAttribute("data-theme") || "light";
    setTheme(current === "light" ? "dark" : "light");
  }

  function initTheme() {
    const theme = getStoredTheme();
    applyTheme(theme);
    document.querySelectorAll(".theme-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeSet === theme);
      btn.addEventListener("click", () => setTheme(btn.dataset.themeSet));
    });
    // Wire up all theme toggle buttons (header + auth)
    const headerToggle = document.getElementById("btn-theme-toggle");
    if (headerToggle) headerToggle.addEventListener("click", toggleTheme);
    const authToggle = document.getElementById("btn-theme-toggle-auth");
    if (authToggle) authToggle.addEventListener("click", toggleTheme);
  }

  // ===== Init =====
  function init() {
    initTheme();
    if (token) {
      showAuthenticated();
    } else {
      showMeterEntry();
    }
  }

  // ===== Navigation =====
  function navigate(view) {
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.remove("active"));
    document
      .querySelectorAll("nav.bottom-nav a")
      .forEach((a) => a.classList.remove("active"));

    const viewEl = document.getElementById("view-" + view);
    if (viewEl) viewEl.classList.add("active");

    const navLink = document.querySelector(
      `nav.bottom-nav a[data-view="${view}"]`,
    );
    if (navLink) navLink.classList.add("active");

    if (view === "dashboard") loadDashboard();
    if (view === "settings") loadSettings();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ===== Auth State =====
  function showMeterEntry() {
    document.getElementById("app-header").style.display = "none";
    document.getElementById("bottom-nav").style.display = "none";
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.remove("active"));
    document.getElementById("view-auth").classList.add("active");
  }

  function showAuthenticated() {
    document.getElementById("app-header").style.display = "flex";
    document.getElementById("bottom-nav").style.display = "flex";
    navigate("dashboard");
  }

  // ===== API Helper =====
  async function api(path, method = "GET", body = null) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    if (body) opts.body = JSON.stringify(body);

    const resp = await fetch(API + path, opts);
    if (resp.status === 401) {
      token = null;
      localStorage.removeItem("taskz_token");
      showMeterEntry();
      throw { status: 401 };
    }
    const data = await resp.json();
    if (!resp.ok) throw { status: resp.status, detail: data.detail };
    return data;
  }

  // ===== Meter Entry (the only "login" screen) =====
  async function enterMeter() {
    const meter_number = document.getElementById("meter-number").value.trim();
    const account_number =
      document.getElementById("account-number").value.trim() || null;
    if (!meter_number) return toast("Enter your meter number", "error");

    const btn = document.getElementById("btn-enter-meter");
    btn.disabled = true;
    const btnText = btn.querySelector(".btn-text");
    if (btnText) btnText.textContent = "Connecting…";

    try {
      const data = await api("/auth/meter-session", "POST", {
        meter_number,
        account_number,
      });
      token = data.access_token;
      localStorage.setItem("taskz_token", token);

      if (data.is_new) {
        toast("Meter registered! Fetching your token history…", "success");
      } else {
        toast("Welcome back!", "success");
      }
      showAuthenticated();
    } catch (e) {
      toast(e.detail || "Something went wrong, try again", "error");
      btn.disabled = false;
      if (btnText) btnText.textContent = "Track my meter";
    }
  }

  function changeMeter() {
    token = null;
    localStorage.removeItem("taskz_token");
    dashboardData = null;
    const input = document.getElementById("meter-number");
    if (input) input.value = "";
    const acct = document.getElementById("account-number");
    if (acct) acct.value = "";
    const btn = document.getElementById("btn-enter-meter");
    if (btn) {
      btn.disabled = false;
      const btnText = btn.querySelector(".btn-text");
      if (btnText) btnText.textContent = "Track my meter";
    }
    showMeterEntry();
  }

  // ===== Dashboard =====
  async function loadDashboard() {
    document.getElementById("dashboard-loading").style.display = "flex";
    document.getElementById("dashboard-content").style.display = "none";

    try {
      dashboardData = await api("/dashboard", "GET");
      renderDashboard(dashboardData);
      loadTokenHistory(true);
      loadChart();
      document.getElementById("dashboard-loading").style.display = "none";
      document.getElementById("dashboard-content").style.display = "block";
    } catch (e) {
      if (e.status !== 401) toast("Failed to load dashboard", "error");
      document.getElementById("dashboard-loading").style.display = "none";
    }
  }

  function renderDashboard(d) {
    // Meter number badge
    const meterNumEl = document.getElementById("hero-meter-num");
    if (meterNumEl)
      meterNumEl.textContent =
        d.meter_number || dashboardData?.meter_number || "--";

    // Hero — Units left
    const unitsEl = document.getElementById("val-units-left");
    const heroUnitsCard = document.getElementById("hero-units");
    heroUnitsCard.classList.remove("status-warning", "status-critical");
    if (d.units_left_estimate != null) {
      unitsEl.innerHTML =
        d.units_left_estimate.toFixed(1) + '<span class="stat-unit">kWh</span>';
      if (d.days_left != null) {
        if (d.days_left < 2) heroUnitsCard.classList.add("status-critical");
        else if (d.days_left < 5) heroUnitsCard.classList.add("status-warning");
      }
    } else {
      unitsEl.innerHTML = '--<span class="stat-unit">kWh</span>';
    }

    // Hero — Days left
    const daysEl = document.getElementById("val-days-left");
    const heroDaysCard = document.getElementById("hero-days");
    heroDaysCard.classList.remove("status-warning", "status-critical");
    if (d.days_left != null) {
      daysEl.innerHTML =
        d.days_left.toFixed(1) + '<span class="stat-unit">days</span>';
      if (d.days_left < 2) heroDaysCard.classList.add("status-critical");
      else if (d.days_left < 5) heroDaysCard.classList.add("status-warning");
    } else {
      daysEl.innerHTML = '--<span class="stat-unit">days</span>';
    }

    // Usage rate
    const rateEl = document.getElementById("val-usage-rate");
    const usageSub = document.getElementById("usage-sub");
    if (d.usage_rate != null) {
      rateEl.innerHTML =
        d.usage_rate.toFixed(2) + '<span class="stat-unit">kWh/day</span>';
    } else {
      rateEl.innerHTML = '--<span class="stat-unit">kWh/day</span>';
    }
    if (usageSub) {
      usageSub.textContent =
        d.usage_rate_mode === "manual"
          ? "Manual override active"
          : "Auto-calculated from recent purchases";
    }

    // Rate mode
    const modeLabel = document.getElementById("rate-mode-label");
    const toggle = document.getElementById("rate-toggle");
    modeLabel.textContent = d.usage_rate_mode.toUpperCase();
    modeLabel.className = "rate-mode-label " + d.usage_rate_mode;
    if (d.usage_rate_mode === "manual") {
      toggle.classList.add("active");
    } else {
      toggle.classList.remove("active");
    }

    // Pay before
    const payEl = document.getElementById("val-pay-before");
    if (d.pay_before) {
      payEl.textContent = formatDate(new Date(d.pay_before));
    } else {
      payEl.textContent = "--";
    }

    // Tariff
    document.getElementById("val-tariff").textContent =
      "Tariff: " + (d.tariff || "Unknown");

    // Last sync time
    const syncEl = document.getElementById("last-sync-time");
    if (syncEl) {
      syncEl.textContent = d.last_scrape_at
        ? "Updated " + formatDateShort(new Date(d.last_scrape_at))
        : "Live";
    }

    // Last token
    const lastTokenEl = document.getElementById("last-token-card");
    if (d.last_token) {
      lastTokenEl.innerHTML = renderTokenItem(d.last_token);
    } else {
      lastTokenEl.innerHTML =
        '<div class="empty-state"><p>No tokens recorded yet. Tap Fetch above or wait for background sync.</p></div>';
    }
  }

  async function loadTokenHistory(reset = false) {
    if (reset) {
      tokenPage = 1;
      allTokensLoaded = false;
      document.getElementById("token-list").innerHTML = "";
    }

    const loading = document.getElementById("token-list-loading");
    loading.style.display = "flex";

    try {
      const tokens = await api(
        "/dashboard/tokens?page=" + tokenPage + "&per_page=20",
        "GET",
      );
      const list = document.getElementById("token-list");
      tokens.forEach((t) => {
        list.insertAdjacentHTML("beforeend", renderTokenItem(t, true));
      });

      if (tokens.length < 20) {
        allTokensLoaded = true;
      }
      document.getElementById("load-more-tokens").style.display =
        allTokensLoaded ? "none" : "block";
    } catch (e) {
      if (e.status !== 401) console.error("Failed to load tokens:", e);
    } finally {
      loading.style.display = "none";
    }
  }

  function loadMoreTokens() {
    tokenPage++;
    loadTokenHistory(false);
  }

  function formatSourceLabel(src) {
    const map = {
      manual_fetch: "Manual fetch",
      auto_fetch: "Auto fetch",
      manual: "Manual",
      sms: "SMS",
      kplc: "KPLC",
    };
    if (!src) return "Unknown";
    return (
      map[src] ||
      src.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    );
  }

  function formatTokenNumber(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (!digits) return escapeHtml(raw || "--");
    return digits.match(/.{1,4}/g).join("-");
  }

  function renderTokenItem(t, showPayer = false) {
    const date = t.purchased_at
      ? formatDate(new Date(t.purchased_at))
      : "Unknown date";
    const payerHtml = t.payer_label
      ? `<span class="token-payer">${escapeHtml(t.payer_label)}</span>`
      : "";
    const sourceHtml = `<span class="token-source">${escapeHtml(formatSourceLabel(t.source))}</span>`;
    const payerEditBtn = showPayer
      ? `<button class="btn btn-ghost btn-sm token-edit-label-btn" onclick="App.editPayerLabel(${t.id}, '${escapeHtml(t.payer_label || "")}')">${t.payer_label ? "Edit label" : "+ Label"}</button>`
      : "";

    return `<div class="token-item">
            <div class="token-item-head">
                <span class="token-item-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                </span>
                <span class="token-item-date">${date}</span>
                <span class="token-item-tags">${payerHtml}${sourceHtml}${payerEditBtn}</span>
            </div>
            <div class="token-item-body">
                <div class="token-field">
                    <span class="token-field-label">Payment mode</span>
                    <span class="token-field-value">${escapeHtml(t.payment_mode || "--")}</span>
                </div>
                <div class="token-field">
                    <span class="token-field-label">Amount</span>
                    <span class="token-field-value">${t.amount != null ? "KES " + t.amount.toFixed(0) : "--"}</span>
                </div>
                <div class="token-field">
                    <span class="token-field-label">Units</span>
                    <span class="token-field-value">${t.units != null ? t.units.toFixed(1) + " kWh" : "--"}</span>
                </div>
                <div class="token-field token-field-number">
                    <span class="token-field-label">Token number</span>
                    <span class="token-field-value token-number">${formatTokenNumber(t.token_number)}</span>
                </div>
            </div>
        </div>`;
  }

  // ===== Chart =====
  async function loadChart() {
    try {
      const snapshots = await api("/dashboard/snapshots?days=30", "GET");
      renderChart(snapshots);
    } catch (e) {
      if (e.status !== 401) console.error("Chart load failed:", e);
    }
  }

  function getChartColors() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    return {
      units: dark ? "#60A5FA" : "#002D62",
      unitsFill: dark ? "rgba(96, 165, 250, 0.18)" : "rgba(0, 45, 98, 0.12)",
      days: dark ? "#FBBF24" : "#F59E0B",
      daysFill: dark ? "rgba(251, 191, 36, 0.05)" : "rgba(245, 158, 11, 0.05)",
      grid: dark ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.05)",
      tick: dark ? "#7C8AA3" : "#6B7280",
      legend: dark ? "#B4C0D4" : "#4B5563",
    };
  }

  function updateChartColors(chart) {
    const c = getChartColors();
    chart.data.datasets[0].borderColor = c.units;
    chart.data.datasets[0].backgroundColor = c.unitsFill;
    chart.data.datasets[1].borderColor = c.days;
    chart.data.datasets[1].backgroundColor = c.daysFill;
    chart.options.scales.x.ticks.color = c.tick;
    chart.options.scales.x.grid.color = c.grid;
    chart.options.scales.y.ticks.color = c.tick;
    chart.options.scales.y.grid.color = c.grid;
    chart.options.scales.y1.ticks.color = c.tick;
    chart.options.plugins.legend.labels.color = c.legend;
    chart.update();
  }

  function renderChart(snapshots) {
    const canvas = document.getElementById("usage-chart");
    const empty = document.getElementById("chart-empty");

    if (!snapshots || snapshots.length < 2) {
      canvas.style.display = "none";
      empty.style.display = "flex";
      if (usageChart) {
        usageChart.destroy();
        usageChart = null;
      }
      return;
    }

    canvas.style.display = "block";
    empty.style.display = "none";

    const labels = snapshots.map((s) =>
      formatDateShort(new Date(s.computed_at)),
    );
    const unitsData = snapshots.map((s) => s.units_left_estimate);
    const daysData = snapshots.map((s) => s.days_left);

    if (usageChart) usageChart.destroy();

    const c = getChartColors();

    usageChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Units Left (kWh)",
            data: unitsData,
            borderColor: c.units,
            backgroundColor: c.unitsFill,
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
          },
          {
            label: "Days Left",
            data: daysData,
            borderColor: c.days,
            backgroundColor: c.daysFill,
            fill: false,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 1.5,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        layout: {
          padding: { top: 24, right: 8, bottom: 4, left: 4 },
        },
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            position: "top",
            align: "end",
            labels: {
              color: c.legend,
              font: { size: 11, family: "Inter" },
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              pointStyle: "circle",
            },
          },
          tooltip: {
            backgroundColor: getComputedStyle(document.documentElement)
              .getPropertyValue("--surface")
              .trim(),
            titleColor: getComputedStyle(document.documentElement)
              .getPropertyValue("--text")
              .trim(),
            bodyColor: getComputedStyle(document.documentElement)
              .getPropertyValue("--text-secondary")
              .trim(),
            borderColor: getComputedStyle(document.documentElement)
              .getPropertyValue("--border")
              .trim(),
            borderWidth: 1,
            padding: 12,
            cornerRadius: 8,
            titleFont: { family: "Inter", weight: "700" },
            bodyFont: { family: "Inter" },
          },
        },
        scales: {
          x: {
            ticks: {
              color: c.tick,
              font: { size: 10, family: "Inter" },
              maxTicksLimit: 6,
            },
            grid: { color: c.grid, drawTicks: false },
            border: { display: false },
          },
          y: {
            position: "left",
            grace: "10%",
            beginAtZero: true,
            ticks: { color: c.tick, font: { size: 10, family: "Inter" } },
            grid: { color: c.grid, drawTicks: false },
            border: { display: false },
          },
          y1: {
            position: "right",
            grace: "10%",
            beginAtZero: true,
            ticks: { color: c.tick, font: { size: 10, family: "Inter" } },
            grid: { drawOnChartArea: false },
            border: { display: false },
          },
        },
      },
    });
  }

  // ===== Rate Toggle =====
  function toggleRateMode() {
    if (!dashboardData) return;

    if (dashboardData.usage_rate_mode === "manual") {
      saveSettings({ manual_usage_rate: null }).then(() => {
        toast("Switched to auto rate", "success");
        loadDashboard();
      });
    } else {
      showRateModal();
    }
  }

  function showRateModal() {
    const currentRate = dashboardData?.usage_rate?.toFixed(2) || "";
    const container = document.getElementById("modal-container");
    container.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
            <div class="modal">
                <h3>Set Manual Rate</h3>
                <p>Override the auto-calculated usage rate with your own kWh/day value.</p>
                <div class="form-group">
                    <label>Usage Rate (kWh/day)</label>
                    <div class="input-wrap">
                        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                        <input type="number" id="modal-rate" value="${currentRate}" step="0.1" min="0" placeholder="e.g. 5.5">
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
                    <button class="btn btn-primary" onclick="App.saveManualRateFromModal()">Set Rate</button>
                </div>
            </div>
        </div>`;
    setTimeout(() => document.getElementById("modal-rate")?.focus(), 50);
  }

  function saveManualRateFromModal() {
    const input = document.getElementById("modal-rate");
    const val = parseFloat(input.value);
    if (isNaN(val) || val <= 0)
      return toast("Enter a positive number", "error");
    saveSettings({ manual_usage_rate: val }).then(() => {
      toast("Manual rate set", "success");
      closeModal();
      loadDashboard();
    });
  }

  function closeModal() {
    document.getElementById("modal-container").innerHTML = "";
  }

  // ===== Payer Label =====
  function editPayerLabel(tokenId, currentLabel) {
    const container = document.getElementById("modal-container");
    container.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
            <div class="modal">
                <h3>Set Payer Label</h3>
                <p>Label who paid for this token — useful for shared meters.</p>
                <div class="form-group">
                    <label>Payer</label>
                    <div class="input-wrap">
                        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        <input type="text" id="modal-payer" value="${escapeHtml(currentLabel)}" placeholder="e.g. John, Mum, Tenant A">
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-danger btn-sm" onclick="App.clearPayerLabel(${tokenId})">Clear</button>
                    <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
                    <button class="btn btn-primary" onclick="App.savePayerLabel(${tokenId})">Save</button>
                </div>
            </div>
        </div>`;
    setTimeout(() => document.getElementById("modal-payer")?.focus(), 50);
  }

  async function savePayerLabel(tokenId) {
    const label = document.getElementById("modal-payer").value.trim() || null;
    try {
      await api("/dashboard/tokens/" + tokenId + "/payer", "PATCH", {
        payer_label: label,
      });
      toast("Label updated", "success");
      closeModal();
      loadDashboard();
    } catch (e) {
      toast("Failed to update label", "error");
    }
  }

  async function clearPayerLabel(tokenId) {
    try {
      await api("/dashboard/tokens/" + tokenId + "/payer", "PATCH", {
        payer_label: null,
      });
      toast("Label cleared", "success");
      closeModal();
      loadDashboard();
    } catch (e) {
      toast("Failed to clear label", "error");
    }
  }

  // ===== Settings =====
  async function loadSettings() {
    try {
      const settings = await api("/settings", "GET");

      // Rate mode
      const modeEl = document.getElementById("setting-rate-mode");
      const modeDesc = document.getElementById("setting-rate-mode-desc");
      modeEl.textContent = settings.usage_rate_mode.toUpperCase();
      modeEl.className = "rate-mode-label " + settings.usage_rate_mode;
      modeDesc.textContent =
        settings.usage_rate_mode === "auto"
          ? "Auto-calculated from recent purchases"
          : "Manual override active";

      document.getElementById("setting-manual-rate").value =
        settings.manual_usage_rate || "";
      document.getElementById("setting-threshold").value =
        settings.notification_threshold_days;

      // Telegram
      const tgStatus = document.getElementById("telegram-status");
      const tgDesc = document.getElementById("telegram-desc");
      const tgLink = document.getElementById("telegram-link-info");
      const tgUnlink = document.getElementById("btn-unlink-telegram");

      if (settings.telegram_linked) {
        tgStatus.className = "telegram-status linked";
        tgStatus.textContent = "Linked";
        tgDesc.textContent = "Chat ID: " + settings.telegram_chat_id;
        tgLink.style.display = "none";
        tgUnlink.style.display = "inline-flex";
      } else {
        tgStatus.className = "telegram-status unlinked";
        tgStatus.textContent = "Not linked";
        tgDesc.textContent = "Link to receive low-units alerts";
        tgLink.style.display = "none";
        tgUnlink.style.display = "none";
      }

      // Meter info
      document.getElementById("settings-meter-number").textContent =
        settings.meter_number || "--";
    } catch (e) {
      if (e.status !== 401) console.error("Settings load failed:", e);
    }
  }

  async function saveSettings(data) {
    return api("/settings", "PATCH", data);
  }

  async function saveManualRate() {
    const input = document.getElementById("setting-manual-rate");
    const val = parseFloat(input.value);
    if (input.value === "" || isNaN(val)) {
      await saveSettings({ manual_usage_rate: null });
      toast("Switched to auto rate", "success");
    } else if (val > 0) {
      await saveSettings({ manual_usage_rate: val });
      toast("Manual rate saved", "success");
    } else {
      return toast("Rate must be positive", "error");
    }
    loadSettings();
  }

  async function saveThreshold() {
    const val = parseFloat(document.getElementById("setting-threshold").value);
    if (isNaN(val) || val < 0) return toast("Invalid threshold", "error");
    await saveSettings({ notification_threshold_days: val });
    toast("Threshold updated", "success");
    loadSettings();
  }

  async function generateTelegramLink() {
    try {
      const data = await api("/settings/telegram/link", "POST");
      document.getElementById("telegram-link-token").value =
        "/start " + data.link_token;
      document.getElementById("telegram-link-info").style.display = "block";
      toast("Link token generated", "success");
    } catch (e) {
      toast("Failed to generate link", "error");
    }
  }

  async function unlinkTelegram() {
    try {
      await api("/settings/telegram/link", "DELETE");
      toast("Telegram unlinked", "success");
      loadSettings();
    } catch (e) {
      toast("Failed to unlink", "error");
    }
  }

  // ===== Utilities =====
  function formatDate(d) {
    return d.toLocaleDateString("en-KE", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function formatDateShort(d) {
    return d.toLocaleDateString("en-KE", { day: "numeric", month: "short" });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toastIcon(type) {
    if (type === "success")
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    if (type === "error")
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }

  function toast(msg, type = "info") {
    const container = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.innerHTML = toastIcon(type) + "<span>" + escapeHtml(msg) + "</span>";
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(-8px)";
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }

  // ===== Manual KPLC Fetch =====
  async function fetchKPLC() {
    const fetchBtn = document.getElementById("btn-fetch-kplc");
    const fetchIcon = document.getElementById("fetch-icon");
    const fetchLabel = document.getElementById("fetch-label");
    const inlineBtn = document.getElementById("btn-fetch-inline");

    if (fetchBtn) fetchBtn.disabled = true;
    if (inlineBtn) inlineBtn.disabled = true;
    if (fetchIcon) fetchIcon.classList.add("spinning");
    if (fetchLabel) fetchLabel.textContent = "Fetching…";

    toast("Fetching latest token details from KPLC…", "info");

    try {
      const res = await api("/dashboard/refresh", "POST");
      toast("KPLC details updated successfully!", "success");
      await loadDashboard();
    } catch (e) {
      toast(e.detail || "Failed to fetch tokens from KPLC", "error");
    } finally {
      if (fetchBtn) fetchBtn.disabled = false;
      if (inlineBtn) inlineBtn.disabled = false;
      if (fetchIcon) fetchIcon.classList.remove("spinning");
      if (fetchLabel) fetchLabel.textContent = "Fetch";
    }
  }

  // ===== Add / Paste SMS Token Modal =====
  function showAddTokenModal() {
    const container = document.getElementById("modal-container");
    container.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
            <div class="modal" style="max-width:440px">
                <h3>Add / Paste Token</h3>
                <p>Paste your full KPLC SMS message, or type the token number manually.</p>
                <div class="form-group">
                    <label>KPLC SMS Message / Text</label>
                    <textarea id="modal-token-sms" rows="3" style="width:100%;padding:12px 14px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:var(--radius-sm);color:var(--text);font-family:var(--font);font-size:0.85rem;resize:vertical;outline:none" placeholder="e.g. You have bought 15.30 units of electricity for KES 500. Token: 1234-5678-9012-3456-7890"></textarea>
                </div>
                <div style="text-align:center;font-size:0.72rem;color:var(--text-muted);margin:10px 0;letter-spacing:0.04em;font-weight:600">— OR ENTER MANUALLY —</div>
                <div class="form-group">
                    <label>Token Number</label>
                    <div class="input-wrap">
                        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M7 6V4a5 5 0 0110 0v2"/></svg>
                        <input type="text" id="modal-token-num" placeholder="20-digit number" inputmode="numeric">
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <div class="form-group">
                        <label>Units (kWh)</label>
                        <div class="input-wrap">
                            <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
                            <input type="number" id="modal-token-units" step="0.01" placeholder="15.3">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Amount (KES)</label>
                        <div class="input-wrap">
                            <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                            <input type="number" id="modal-token-amt" placeholder="500">
                        </div>
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
                    <button class="btn btn-primary" onclick="App.submitAddToken()">Save Token</button>
                </div>
            </div>
        </div>`;
    setTimeout(() => document.getElementById("modal-token-sms")?.focus(), 50);
  }

  async function submitAddToken() {
    const sms = document.getElementById("modal-token-sms")?.value?.trim();
    const num = document.getElementById("modal-token-num")?.value?.trim();
    const units = parseFloat(
      document.getElementById("modal-token-units")?.value,
    );
    const amount = parseFloat(
      document.getElementById("modal-token-amt")?.value,
    );

    if (!sms && !num) {
      return toast("Please paste a KPLC SMS or enter a token number", "error");
    }

    const payload = {
      raw_text: sms || null,
      token_number: num || null,
      units: !isNaN(units) ? units : null,
      amount: !isNaN(amount) ? amount : null,
    };

    try {
      await api("/dashboard/tokens", "POST", payload);
      toast("Token added and metrics recalculated!", "success");
      closeModal();
      loadDashboard();
    } catch (e) {
      toast(e.detail || "Failed to add token", "error");
    }
  }

  // ===== Boot =====
  document.addEventListener("DOMContentLoaded", () => {
    document
      .getElementById("btn-change-meter")
      .addEventListener("click", changeMeter);
    document.getElementById("meter-number").addEventListener("keydown", (e) => {
      if (e.key === "Enter") enterMeter();
    });
    // Keyboard support for rate toggle
    const rateToggle = document.getElementById("rate-toggle");
    if (rateToggle) {
      rateToggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleRateMode();
        }
      });
    }
  });

  init();

  return {
    navigate,
    enterMeter,
    changeMeter,
    fetchKPLC,
    showAddTokenModal,
    submitAddToken,
    loadMoreTokens,
    toggleRateMode,
    closeModal,
    saveManualRateFromModal,
    editPayerLabel,
    savePayerLabel,
    clearPayerLabel,
    saveManualRate,
    saveThreshold,
    generateTelegramLink,
    unlinkTelegram,
    toggleTheme,
  };
})();