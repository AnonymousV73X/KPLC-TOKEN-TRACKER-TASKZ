/**
 * TASKZ — Frontend Application
 * Meter-number based session: enter meter number → auto account → dashboard
 */

const App = (() => {
    const API = '/api';
    let token = localStorage.getItem('taskz_token');
    let dashboardData = null;
    let tokenPage = 1;
    let allTokensLoaded = false;
    let usageChart = null;

    // ===== Init =====
    function init() {
        if (token) {
            showAuthenticated();
        } else {
            showMeterEntry();
        }
    }

    // ===== Navigation =====
    function navigate(view) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('nav.bottom-nav a').forEach(a => a.classList.remove('active'));

        const viewEl = document.getElementById('view-' + view);
        if (viewEl) viewEl.classList.add('active');

        const navLink = document.querySelector(`nav.bottom-nav a[data-view="${view}"]`);
        if (navLink) navLink.classList.add('active');

        if (view === 'dashboard') loadDashboard();
        if (view === 'settings') loadSettings();
    }

    // ===== Auth State =====
    function showMeterEntry() {
        document.getElementById('app-header').style.display = 'none';
        document.getElementById('bottom-nav').style.display = 'none';
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-auth').classList.add('active');
    }

    function showAuthenticated() {
        document.getElementById('app-header').style.display = 'flex';
        document.getElementById('bottom-nav').style.display = 'flex';
        navigate('dashboard');
    }

    // ===== API Helper =====
    async function api(path, method = 'GET', body = null) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (token) opts.headers['Authorization'] = 'Bearer ' + token;
        if (body) opts.body = JSON.stringify(body);

        const resp = await fetch(API + path, opts);
        if (resp.status === 401) {
            // Session expired — clear and go back to meter entry
            token = null;
            localStorage.removeItem('taskz_token');
            showMeterEntry();
            throw { status: 401 };
        }
        const data = await resp.json();
        if (!resp.ok) throw { status: resp.status, detail: data.detail };
        return data;
    }

    // ===== Meter Entry (the only "login" screen) =====
    async function enterMeter() {
        const meter_number = document.getElementById('meter-number').value.trim();
        const account_number = document.getElementById('account-number').value.trim() || null;
        if (!meter_number) return toast('Enter your meter number', 'error');

        const btn = document.getElementById('btn-enter-meter');
        btn.disabled = true;
        btn.textContent = 'Connecting…';

        try {
            const data = await api('/auth/meter-session', 'POST', { meter_number, account_number });
            token = data.access_token;
            localStorage.setItem('taskz_token', token);

            if (data.is_new) {
                toast('Meter registered! Fetching your token history…', 'success');
            } else {
                toast('Welcome back!', 'success');
            }
            showAuthenticated();
        } catch (e) {
            toast(e.detail || 'Something went wrong, try again', 'error');
            btn.disabled = false;
            btn.textContent = 'Track my meter →';
        }
    }

    /** Clear session and return to meter entry screen. */
    function changeMeter() {
        token = null;
        localStorage.removeItem('taskz_token');
        dashboardData = null;
        // Clear the meter number input so they can type a new one
        const input = document.getElementById('meter-number');
        if (input) input.value = '';
        const acct = document.getElementById('account-number');
        if (acct) acct.value = '';
        const btn = document.getElementById('btn-enter-meter');
        if (btn) { btn.disabled = false; btn.textContent = 'Track my meter →'; }
        showMeterEntry();
    }

    // ===== Dashboard =====
    async function loadDashboard() {
        document.getElementById('dashboard-loading').style.display = 'flex';
        document.getElementById('dashboard-content').style.display = 'none';

        try {
            dashboardData = await api('/dashboard', 'GET');
            renderDashboard(dashboardData);
            loadTokenHistory(true);
            loadChart();
            document.getElementById('dashboard-loading').style.display = 'none';
            document.getElementById('dashboard-content').style.display = 'block';
        } catch (e) {
            if (e.status !== 401) toast('Failed to load dashboard', 'error');
            document.getElementById('dashboard-loading').style.display = 'none';
        }
    }

    function renderDashboard(d) {
        // Units left
        const unitsEl = document.getElementById('val-units-left');
        const unitsCard = document.getElementById('card-units-left');
        if (d.units_left_estimate != null) {
            unitsEl.innerHTML = d.units_left_estimate.toFixed(1) + '<span class="stat-unit">kWh</span>';
            unitsCard.className = 'stat-card ' + (d.days_left != null && d.days_left < 2 ? 'critical' : d.days_left != null && d.days_left < 5 ? 'warning' : 'ok');
        } else {
            unitsEl.innerHTML = '--<span class="stat-unit">kWh</span>';
            unitsCard.className = 'stat-card';
        }

        // Days left
        const daysEl = document.getElementById('val-days-left');
        const daysCard = document.getElementById('card-days-left');
        if (d.days_left != null) {
            daysEl.innerHTML = d.days_left.toFixed(1) + '<span class="stat-unit">days</span>';
            daysCard.className = 'stat-card ' + (d.days_left < 2 ? 'critical' : d.days_left < 5 ? 'warning' : 'ok');
        } else {
            daysEl.innerHTML = '--<span class="stat-unit">days</span>';
            daysCard.className = 'stat-card';
        }

        // Usage rate
        const rateEl = document.getElementById('val-usage-rate');
        if (d.usage_rate != null) {
            rateEl.innerHTML = d.usage_rate.toFixed(2) + '<span class="stat-unit">kWh/day</span>';
        } else {
            rateEl.innerHTML = '--<span class="stat-unit">kWh/day</span>';
        }

        // Rate mode
        const modeLabel = document.getElementById('rate-mode-label');
        const toggle = document.getElementById('rate-toggle');
        modeLabel.textContent = d.usage_rate_mode.toUpperCase();
        modeLabel.className = 'rate-mode-label ' + d.usage_rate_mode;
        if (d.usage_rate_mode === 'manual') {
            toggle.classList.add('active');
        } else {
            toggle.classList.remove('active');
        }

        // Pay before
        const payEl = document.getElementById('val-pay-before');
        if (d.pay_before) {
            payEl.textContent = formatDate(new Date(d.pay_before)) + ' EAT';
        } else {
            payEl.textContent = '--';
        }

        // Tariff
        document.getElementById('val-tariff').textContent = 'Tariff: ' + (d.tariff || 'Unknown');

        // Last sync time
        const syncEl = document.getElementById('last-sync-time');
        if (syncEl) {
            syncEl.textContent = d.last_scrape_at ? 'Updated ' + formatDateShort(new Date(d.last_scrape_at)) : '';
        }

        // Last token
        const lastTokenEl = document.getElementById('last-token-card');
        if (d.last_token) {
            lastTokenEl.innerHTML = renderTokenItem(d.last_token);
        } else {
            lastTokenEl.innerHTML = '<div class="empty-state" style="padding:20px"><p style="font-size:0.85rem;color:var(--text-muted)">No tokens recorded yet. Tap Fetch KPLC above or wait for background sync.</p></div>';
        }
    }

    async function loadTokenHistory(reset = false) {
        if (reset) {
            tokenPage = 1;
            allTokensLoaded = false;
            document.getElementById('token-list').innerHTML = '';
        }

        const loading = document.getElementById('token-list-loading');
        loading.style.display = 'flex';

        try {
            const tokens = await api('/dashboard/tokens?page=' + tokenPage + '&per_page=20', 'GET');
            const list = document.getElementById('token-list');
            tokens.forEach(t => {
                list.insertAdjacentHTML('beforeend', renderTokenItem(t, true));
            });

            document.getElementById('token-count').textContent = (dashboardData?.total_tokens_count || 0) + ' total';

            if (tokens.length < 20) {
                allTokensLoaded = true;
            }
            document.getElementById('load-more-tokens').style.display = allTokensLoaded ? 'none' : 'block';
        } catch (e) {
            if (e.status !== 401) console.error('Failed to load tokens:', e);
        } finally {
            loading.style.display = 'none';
        }
    }

    function loadMoreTokens() {
        tokenPage++;
        loadTokenHistory(false);
    }

    function renderTokenItem(t, showPayer = false) {
        const date = t.purchased_at ? formatDate(new Date(t.purchased_at)) : 'Unknown date';
        const payerHtml = t.payer_label ? `<div class="token-payer">${escapeHtml(t.payer_label)}</div>` : '';
        const sourceHtml = `<div class="token-source">${t.source}</div>`;
        const payerEditBtn = showPayer ?
            `<button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:0.65rem;margin-top:4px" onclick="App.editPayerLabel(${t.id}, '${escapeHtml(t.payer_label || '')}')">${t.payer_label ? 'Edit' : '+ Label'}</button>` : '';

        return `<div class="token-item">
            <div class="token-info">
                <div class="token-date">${date}</div>
                <div class="token-units">${t.units != null ? t.units.toFixed(1) + ' kWh' : '-- kWh'}</div>
                <div class="token-amount">${t.amount != null ? 'KES ' + t.amount.toFixed(0) : ''} ${t.payment_mode || ''}</div>
                ${payerEditBtn}
            </div>
            <div class="token-meta">
                <div class="token-number">${t.token_number}</div>
                ${payerHtml}
                ${sourceHtml}
            </div>
        </div>`;
    }

    async function loadChart() {
        try {
            const snapshots = await api('/dashboard/snapshots?days=30', 'GET');
            renderChart(snapshots);
        } catch (e) {
            if (e.status !== 401) console.error('Chart load failed:', e);
        }
    }

    function renderChart(snapshots) {
        const canvas = document.getElementById('usage-chart');
        const empty = document.getElementById('chart-empty');

        if (!snapshots || snapshots.length < 2) {
            canvas.style.display = 'none';
            empty.style.display = 'flex';
            if (usageChart) { usageChart.destroy(); usageChart = null; }
            return;
        }

        canvas.style.display = 'block';
        empty.style.display = 'none';

        const labels = snapshots.map(s => formatDateShort(new Date(s.computed_at)));
        const unitsData = snapshots.map(s => s.units_left_estimate);
        const daysData = snapshots.map(s => s.days_left);

        if (usageChart) usageChart.destroy();

        usageChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Units Left (kWh)',
                        data: unitsData,
                        borderColor: '#00e5ff',
                        backgroundColor: 'rgba(0, 229, 255, 0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2,
                        borderWidth: 2,
                    },
                    {
                        label: 'Days Left',
                        data: daysData,
                        borderColor: '#ffaa00',
                        backgroundColor: 'rgba(255, 170, 0, 0.05)',
                        fill: false,
                        tension: 0.3,
                        pointRadius: 2,
                        borderWidth: 1.5,
                        yAxisID: 'y1',
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: { color: '#888', font: { size: 11 }, boxWidth: 12 },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: '#555', font: { size: 10 }, maxTicksLimit: 8 },
                        grid: { color: 'rgba(255,255,255,0.03)' },
                    },
                    y: {
                        position: 'left',
                        ticks: { color: '#00e5ff', font: { size: 10 } },
                        grid: { color: 'rgba(255,255,255,0.03)' },
                    },
                    y1: {
                        position: 'right',
                        ticks: { color: '#ffaa00', font: { size: 10 } },
                        grid: { drawOnChartArea: false },
                    },
                },
            },
        });
    }

    // ===== Rate Toggle =====
    function toggleRateMode() {
        if (!dashboardData) return;

        if (dashboardData.usage_rate_mode === 'manual') {
            saveSettings({ manual_usage_rate: null }).then(() => {
                toast('Switched to auto rate', 'success');
                loadDashboard();
            });
        } else {
            showRateModal();
        }
    }

    function showRateModal() {
        const currentRate = dashboardData?.usage_rate?.toFixed(2) || '';
        const container = document.getElementById('modal-container');
        container.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
            <div class="modal">
                <h3>Set Manual Rate</h3>
                <div class="form-group">
                    <label>Usage Rate (kWh/day)</label>
                    <input type="number" id="modal-rate" value="${currentRate}" step="0.1" min="0" placeholder="e.g. 5.5">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
                    <button class="btn btn-primary" style="width:auto" onclick="App.saveManualRateFromModal()">Set Rate</button>
                </div>
            </div>
        </div>`;
    }

    function saveManualRateFromModal() {
        const input = document.getElementById('modal-rate');
        const val = parseFloat(input.value);
        if (isNaN(val) || val <= 0) return toast('Enter a positive number', 'error');
        saveSettings({ manual_usage_rate: val }).then(() => {
            toast('Manual rate set', 'success');
            closeModal();
            loadDashboard();
        });
    }

    function closeModal() {
        document.getElementById('modal-container').innerHTML = '';
    }

    // ===== Payer Label =====
    function editPayerLabel(tokenId, currentLabel) {
        const container = document.getElementById('modal-container');
        container.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
            <div class="modal">
                <h3>Set Payer Label</h3>
                <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:16px">Label who paid for this token (useful for shared meters)</p>
                <div class="form-group">
                    <label>Payer</label>
                    <input type="text" id="modal-payer" value="${escapeHtml(currentLabel)}" placeholder="e.g. John, Mum, Tenant A">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-danger btn-sm" onclick="App.clearPayerLabel(${tokenId})">Clear</button>
                    <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
                    <button class="btn btn-primary" style="width:auto" onclick="App.savePayerLabel(${tokenId})">Save</button>
                </div>
            </div>
        </div>`;
    }

    async function savePayerLabel(tokenId) {
        const label = document.getElementById('modal-payer').value.trim() || null;
        try {
            await api('/dashboard/tokens/' + tokenId + '/payer', 'PATCH', { payer_label: label });
            toast('Label updated', 'success');
            closeModal();
            loadDashboard();
        } catch (e) {
            toast('Failed to update label', 'error');
        }
    }

    async function clearPayerLabel(tokenId) {
        try {
            await api('/dashboard/tokens/' + tokenId + '/payer', 'PATCH', { payer_label: null });
            toast('Label cleared', 'success');
            closeModal();
            loadDashboard();
        } catch (e) {
            toast('Failed to clear label', 'error');
        }
    }

    // ===== Settings =====
    async function loadSettings() {
        try {
            const settings = await api('/settings', 'GET');

            // Rate mode
            const modeEl = document.getElementById('setting-rate-mode');
            const modeDesc = document.getElementById('setting-rate-mode-desc');
            modeEl.textContent = settings.usage_rate_mode.toUpperCase();
            modeEl.className = 'rate-mode-label ' + settings.usage_rate_mode;
            modeDesc.textContent = settings.usage_rate_mode === 'auto'
                ? 'Auto-calculated from recent purchases'
                : 'Manual override active';

            document.getElementById('setting-manual-rate').value = settings.manual_usage_rate || '';
            document.getElementById('setting-threshold').value = settings.notification_threshold_days;

            // Telegram
            const tgStatus = document.getElementById('telegram-status');
            const tgDesc = document.getElementById('telegram-desc');
            const tgLink = document.getElementById('telegram-link-info');
            const tgUnlink = document.getElementById('btn-unlink-telegram');

            if (settings.telegram_linked) {
                tgStatus.className = 'telegram-status linked';
                tgStatus.textContent = 'Linked';
                tgDesc.textContent = 'Chat ID: ' + settings.telegram_chat_id;
                tgLink.style.display = 'none';
                tgUnlink.style.display = 'block';
            } else {
                tgStatus.className = 'telegram-status unlinked';
                tgStatus.textContent = 'Not linked';
                tgDesc.textContent = 'Link to receive low-units alerts';
                tgLink.style.display = 'none';
                tgUnlink.style.display = 'none';
            }

            // Meter info
            document.getElementById('settings-meter-number').textContent = settings.meter_number || '--';

        } catch (e) {
            if (e.status !== 401) console.error('Settings load failed:', e);
        }
    }

    async function saveSettings(data) {
        return api('/settings', 'PATCH', data);
    }

    async function saveManualRate() {
        const input = document.getElementById('setting-manual-rate');
        const val = parseFloat(input.value);
        if (input.value === '' || isNaN(val)) {
            await saveSettings({ manual_usage_rate: null });
            toast('Switched to auto rate', 'success');
        } else if (val > 0) {
            await saveSettings({ manual_usage_rate: val });
            toast('Manual rate saved', 'success');
        } else {
            return toast('Rate must be positive', 'error');
        }
        loadSettings();
    }

    async function saveThreshold() {
        const val = parseFloat(document.getElementById('setting-threshold').value);
        if (isNaN(val) || val < 0) return toast('Invalid threshold', 'error');
        await saveSettings({ notification_threshold_days: val });
        toast('Threshold updated', 'success');
        loadSettings();
    }

    async function generateTelegramLink() {
        try {
            const data = await api('/settings/telegram/link', 'POST');
            document.getElementById('telegram-link-token').value = '/start ' + data.link_token;
            document.getElementById('telegram-link-info').style.display = 'block';
            toast('Link token generated', 'success');
        } catch (e) {
            toast('Failed to generate link', 'error');
        }
    }

    async function unlinkTelegram() {
        try {
            await api('/settings/telegram/link', 'DELETE');
            toast('Telegram unlinked', 'success');
            loadSettings();
        } catch (e) {
            toast('Failed to unlink', 'error');
        }
    }

    // ===== Utilities =====
    function formatDate(d) {
        return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function formatDateShort(d) {
        return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function toast(msg, type = 'info') {
        const container = document.getElementById('toasts');
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = msg;
        container.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
    }

    // ===== Manual KPLC Fetch =====
    async function fetchKPLC() {
        const fetchBtn = document.getElementById('btn-fetch-kplc');
        const fetchIcon = document.getElementById('fetch-icon');
        const fetchLabel = document.getElementById('fetch-label');
        const inlineBtn = document.getElementById('btn-fetch-inline');

        if (fetchBtn) fetchBtn.disabled = true;
        if (inlineBtn) inlineBtn.disabled = true;
        if (fetchIcon) fetchIcon.classList.add('spinning');
        if (fetchLabel) fetchLabel.textContent = 'Fetching…';

        toast('Fetching latest token details from KPLC…', 'info');

        try {
            const res = await api('/dashboard/refresh', 'POST');
            toast('KPLC details updated successfully!', 'success');
            await loadDashboard();
        } catch (e) {
            toast(e.detail || 'Failed to fetch tokens from KPLC', 'error');
        } finally {
            if (fetchBtn) fetchBtn.disabled = false;
            if (inlineBtn) inlineBtn.disabled = false;
            if (fetchIcon) fetchIcon.classList.remove('spinning');
            if (fetchLabel) fetchLabel.textContent = 'Fetch KPLC';
        }
    }

    // ===== Boot =====
    document.getElementById('btn-change-meter').addEventListener('click', changeMeter);
    document.getElementById('meter-number').addEventListener('keydown', e => { if (e.key === 'Enter') enterMeter(); });

    init();

    return {
        navigate, enterMeter, changeMeter, fetchKPLC,
        loadMoreTokens, toggleRateMode, closeModal,
        saveManualRateFromModal, editPayerLabel, savePayerLabel, clearPayerLabel,
        saveManualRate, saveThreshold, generateTelegramLink, unlinkTelegram,
    };
})();
