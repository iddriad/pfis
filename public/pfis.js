// ═══════════════════════════════════════════════════════════════════════════
//  PFIS — Predictive Fraud Intelligence System  |  Client Script  (pfis.js)
// ═══════════════════════════════════════════════════════════════════════════

// ─── UTILITIES ──────────────────────────────────────────────────────────────
function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function fmt(n) { return '₵' + Number(n).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtTime(d) { return d.toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function fmtDate(d) { return d.toLocaleDateString('en-GH', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + fmtTime(d); }
function uid() { return 'TXN-PFIS-' + Date.now().toString(36).toUpperCase(); }
function caseId() { return 'CASE-PFIS-' + Date.now().toString(36).toUpperCase(); }
function showPage(id) { /* noop — navigation handled by separate pages */ }

// ─── ACTIVITY LOG ───────────────────────────────────────────────────────────
function addLog(msg) {
  const tbody = document.getElementById('activityLog');
  if (tbody) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="font-size:11px;"><span style="color:var(--gov-muted);font-family:monospace;">[${fmtTime(new Date())}]</span> ${msg}</td>`;
    tbody.insertBefore(tr, tbody.firstChild);
    while (tbody.children.length > 50) tbody.removeChild(tbody.lastChild);
  }
  console.log('[LOG]', msg);
}

// ─── STATIC DATA ────────────────────────────────────────────────────────────
const PROFILES = [
  { id: 'U-PF-001', name: 'Kofi Mensah',     type: 'Trader',   sub: 'Frequent Sender',   avg: 600,  hours: [8, 18],  device: 'Samsung Galaxy A54',  location: 'Kumasi',     initials: 'KM' },
  { id: 'U-PF-002', name: 'Ama Boateng',      type: 'Student',  sub: 'Saver',             avg: 120,  hours: [9, 20],  device: 'iPhone 13',           location: 'Accra',      initials: 'AB' },
  { id: 'U-PF-003', name: 'Kwame Asante',     type: 'Worker',   sub: 'Bill Payer',        avg: 350,  hours: [7, 21],  device: 'Tecno Spark 10',      location: 'Takoradi',   initials: 'KA' },
  { id: 'U-PF-004', name: 'Akosua Frimpong',  type: 'Merchant', sub: 'Bulk Receiver',     avg: 1200, hours: [6, 20],  device: 'Xiaomi Redmi 12',     location: 'Accra',      initials: 'AF' },
  { id: 'U-PF-005', name: 'Yaw Darko',        type: 'Worker',   sub: 'Remittance Sender', avg: 450,  hours: [8, 19],  device: 'Samsung Galaxy A32',  location: 'Kumasi',     initials: 'YD' },
  { id: 'U-PF-006', name: 'Efua Ansah',       type: 'Student',  sub: 'Freelancer',        avg: 200,  hours: [10, 22], device: 'Tecno Camon 20',      location: 'Cape Coast', initials: 'EA' },
];

const DEVICES = [
  'Samsung Galaxy A54', 'iPhone 13', 'Tecno Spark 10', 'Xiaomi Redmi 12',
  'Samsung Galaxy A32', 'Tecno Camon 20', 'Unknown Android Device', 'New iPhone', 'Unregistered Tablet',
];

const LOCATIONS = [
  'Accra', 'Kumasi', 'Takoradi', 'Tamale', 'Cape Coast',
  'Sunyani', 'Ho', 'Bolgatanga', 'Unknown Location', 'International IP',
];

const RECIPIENTS = [
  'MTN MoMo #0244-XXX', 'Vodafone Cash #0205-XXX', 'AirtelTigo #0277-XXX',
  'GCB Acct #1003-XXX', 'Ecobank #0038-XXX', 'New Recipient', 'Unknown Account', 'International Wire',
];

// Known fraud pattern labels (used in hurdle evaluation & reports)
const FRAUD_TYPES = [
  'Account Takeover', 'SIM Swap', 'Smurfing', 'Mule Network',
  'Rapid Fire Transfers', 'Device Spoofing', 'Location Anomaly',
];

// ─── MUTABLE STATE ──────────────────────────────────────────────────────────
let transactions  = [];
let investigations = [];
let running       = false;
let engineInterval = null;
let txnInterval   = 2800;
let threshSafe    = 40;
let threshMod     = 70;
let monFilter     = 'all';
let typeFilter    = 'all';

// Engine runs server-side — see server.js processTxn()

// ─── ENGINE TOGGLE ──────────────────────────────────────────────────────────
// ── Engine state synced with server ──────────────────────────────────────────
function setEngineUI(isRunning) {
  const btn  = document.getElementById('engineBtn');
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const notice = document.getElementById('engineNotice');
  if (isRunning) {
    if (btn)  { btn.textContent = '■ Deactivate'; btn.classList.add('stop'); }
    if (dot)  dot.classList.add('active');
    if (text) text.textContent = 'Engine Active';
    if (notice) notice.style.display = 'none';
  } else {
    if (btn)  { btn.textContent = '▶ Activate Engine'; btn.classList.remove('stop'); }
    if (dot)  dot.classList.remove('active');
    if (text) text.textContent = 'Engine Offline';
  }
}

function toggleEngine() {
  const btn = document.getElementById('engineBtn');
  if (btn) btn.disabled = true;

  // Check current server state first
  fetch('/api/engine/status')
    .then(r => r.json())
    .then(status => {
      const endpoint = status.running ? '/api/engine/stop' : '/api/engine/start';
      return fetch(endpoint, { method: 'POST' });
    })
    .then(r => r.json())
    .then(() => syncEngineState())
    .catch(() => { if (btn) btn.disabled = false; });
}

function syncEngineState() {
  fetch('/api/engine/status')
    .then(r => r.json())
    .then(status => {
      setEngineUI(status.running);
      const btn = document.getElementById('engineBtn');
      if (btn) btn.disabled = false;
    })
    .catch(() => {});
}

// ─── TRANSACTION MODAL ──────────────────────────────────────────────────────
//
//  Opens a detailed overlay for any transaction by ID.
//  If a DOM element with id="txnModal" exists it is used; otherwise one is
//  created on-the-fly so the function works on every page.
//

function openTxnModal(id) {
  const txn = transactions.find(t => t.id === id);
  if (!txn) {
    // Fallback: try fetching from server
    fetch('/api/transactions/' + id)
      .then(r => r.json())
      .then(data => _renderTxnModal(data))
      .catch(() => alert('Transaction ' + id + ' not found.'));
    return;
  }
  _renderTxnModal(txn);
}

function _renderTxnModal(txn) {
  // Ensure modal container exists
  let modal = document.getElementById('txnModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'txnModal';
    modal.style.cssText = [
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.55);backdrop-filter:blur(2px);',
    ].join('');
    document.body.appendChild(modal);
  }

  const riskCol = txn.risk === 'high'
    ? 'var(--danger-red)'
    : txn.risk === 'moderate'
      ? 'var(--warn-amber)'
      : 'var(--safe-green)';

  const hurdleRows = txn.failedHurdles.length
    ? txn.failedHurdles.map(h => `
        <li style="font-size:12px;color:var(--danger-red);margin-bottom:4px;">⚠ ${h}</li>`).join('')
    : '<li style="font-size:12px;color:var(--safe-green);">✔ All checks passed</li>';

  const actionButtons = txn.risk === 'high' && txn.confirmed === null ? `
    <button class="btn btn-success" onclick="confirmTxn('${txn.id}')">✔ Confirm Transaction</button>
    <button class="btn btn-danger"  onclick="cancelTxn('${txn.id}')">✖ Cancel Transaction</button>
    <button class="btn btn-outline" onclick="_flagInvestigation('${txn.id}')">🔍 Flag for Investigation</button>
  ` : `<button class="btn btn-outline" onclick="closeTxnModal()">Close</button>`;

  modal.innerHTML = `
    <div style="
      background:#fff;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.3);
      width:min(600px,95vw);max-height:90vh;overflow-y:auto;
    ">
      <!-- Header -->
      <div style="
        background:var(--gov-navy,#1B2A4A);color:#fff;
        padding:20px 24px;border-radius:6px 6px 0 0;
        display:flex;justify-content:space-between;align-items:center;
      ">
        <div>
          <div style="font-size:11px;opacity:.7;font-family:monospace;">${txn.id}</div>
          <div style="font-size:18px;font-weight:700;margin-top:2px;">Transaction Detail</div>
        </div>
        <button onclick="closeTxnModal()"
          style="background:rgba(255,255,255,.15);border:none;color:#fff;font-size:18px;
                 cursor:pointer;width:32px;height:32px;border-radius:50%;line-height:32px;text-align:center;">
          ×
        </button>
      </div>

      <!-- Risk Banner -->
      <div style="background:${riskCol};color:#fff;padding:10px 24px;font-size:13px;font-weight:700;letter-spacing:.5px;">
        ${txn.risk.toUpperCase()} RISK &nbsp;·&nbsp; Score: ${txn.score}/100
        ${txn.fraudType ? '&nbsp;·&nbsp; ' + txn.fraudType : ''}
      </div>

      <!-- Body -->
      <div style="padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:20px;">

        <!-- Left column: transaction fields -->
        <div>
          <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--gov-muted,#6B7280);margin:0 0 12px;">Transaction</h4>
          ${_detailRow('Amount',    fmt(txn.amount))}
          ${_detailRow('Recipient', txn.recipient)}
          ${_detailRow('Date/Time', fmtDate(new Date(txn.ts)))}
          ${_detailRow('Status',    txn.status.charAt(0).toUpperCase() + txn.status.slice(1))}
          ${txn.smsOutcome ? _detailRow('SMS Outcome', '📱 ' + txn.smsOutcome) : ''}
        </div>

        <!-- Right column: customer / device -->
        <div>
          <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--gov-muted,#6B7280);margin:0 0 12px;">Customer</h4>
          ${_detailRow('Name',     txn.profile.name)}
          ${_detailRow('ID',       txn.profile.id)}
          ${_detailRow('Type',     txn.profile.type + ' — ' + txn.profile.sub)}
          ${_detailRow('Device',   txn.device)}
          ${_detailRow('Location', txn.location)}
        </div>

        <!-- Hurdles (full-width) -->
        <div style="grid-column:1/-1;">
          <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--gov-muted,#6B7280);margin:0 0 8px;">Rule Checks</h4>
          <ul style="margin:0;padding:0 0 0 4px;list-style:none;">${hurdleRows}</ul>
        </div>

      </div>

      <!-- Footer actions -->
      <div style="
        padding:16px 24px;border-top:1px solid #E2E8F0;
        display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;
      ">
        ${actionButtons}
      </div>
    </div>
  `;

  modal.style.display = 'flex';

  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) closeTxnModal(); }, { once: true });
}

function _detailRow(label, value) {
  return `<div style="margin-bottom:9px;">
    <div style="font-size:11px;color:var(--gov-muted,#6B7280);margin-bottom:2px;">${label}</div>
    <div style="font-size:13px;font-weight:600;">${value}</div>
  </div>`;
}

function closeTxnModal() {
  const modal = document.getElementById('txnModal');
  if (modal) modal.style.display = 'none';
}

// ─── TRANSACTION ACTIONS ────────────────────────────────────────────────────

function confirmTxn(id) {
  const txn = _findOrAlert(id);
  if (!txn) return;

  txn.confirmed = true;
  txn.status    = 'approved';

  _patchTxnServer(txn);
  closeTxnModal();
  addLog(`✔ Operator confirmed transaction <strong>${id}</strong> for ${txn.profile.name} (${fmt(txn.amount)}).`);
  _refreshCurrentPage();
}

function cancelTxn(id) {
  const txn = _findOrAlert(id);
  if (!txn) return;

  txn.confirmed = false;
  txn.status    = 'cancelled';

  _patchTxnServer(txn);
  closeTxnModal();
  addLog(`✖ Operator cancelled transaction <strong>${id}</strong> for ${txn.profile.name} (${fmt(txn.amount)}).`);
  _refreshCurrentPage();
}

function _flagInvestigation(id) {
  const txn = _findOrAlert(id);
  if (!txn) return;

  const inv = {
    id:        caseId(),
    txnId:     txn.id,
    account:   txn.profile.name + ' (' + txn.profile.id + ')',
    amount:    txn.amount,
    fraudType: txn.fraudType || 'Unknown',
    status:    'Open',
    opened:    new Date().toISOString(),
  };

  investigations.unshift(inv);

  txn.status    = 'investigating';
  txn.confirmed = null;

  fetch('/api/investigations', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(inv),
  }).catch(() => {});

  _patchTxnServer(txn);
  closeTxnModal();
  addLog(`🔍 Investigation opened: <strong>${inv.id}</strong> — ${txn.profile.name} — ${fmt(txn.amount)}`);
  _refreshCurrentPage();
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function _findOrAlert(id) {
  const txn = transactions.find(t => t.id === id);
  if (!txn) { alert('Transaction ' + id + ' not found in local store.'); }
  return txn || null;
}

function _patchTxnServer(txn) {
  fetch('/api/transactions/' + txn.id, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ status: txn.status, confirmed: txn.confirmed }),
  }).catch(() => {});
}

function _refreshCurrentPage() {
  const path = window.location.pathname;
  if (path === '/')             { fetch('/api/transactions').then(r=>r.json()).then(d=>{transactions=d;renderDashboard(d);}).catch(()=>{}); }
  if (path === '/monitor')      { fetch('/api/monitor').then(r=>r.json()).then(renderMonitorPage).catch(()=>{}); }
  if (path === '/transactions') renderTxnTable();
  if (path === '/investigations') {
    fetch('/api/investigations').then(r => r.json()).then(renderInvestPage).catch(() => renderInvestPage(investigations));
  }
}

// ─── HELPER RENDERERS ───────────────────────────────────────────────────────

function txnRow(t, short = false) {
  const riskBadge = `<span class="badge badge-${t.risk}">${t.risk.toUpperCase()}</span>`;
  const statusBadge =
    t.status === 'approved'          ? '<span class="badge badge-safe">Approved</span>'   :
    t.status === 'blocked'           ? '<span class="badge badge-high">Blocked</span>'    :
    t.status === 'monitoring'        ? '<span class="badge badge-moderate">Monitoring</span>' :
    t.status === 'investigating'     ? '<span class="badge" style="background:#553C9A;color:#fff;">Investigating</span>' :
    t.status === 'awaiting_customer' ? '<span class="badge" style="background:#7C3AED;color:#fff;">📱 Awaiting SMS</span>' :
                                       '<span class="badge" style="background:#742A2A;color:#fff;">Cancelled</span>';
  const action = `<button class="btn btn-outline btn-sm" onclick="openTxnModal('${t.id}')">View</button>`;

  if (short) {
    return `<tr>
      <td style="font-size:11px;font-family:monospace;">${t.id}</td>
      <td>${t.profile.name}</td>
      <td>${fmt(t.amount)}</td>
      <td><strong style="color:var(--danger-red);">${t.score}</strong></td>
      <td style="font-size:11px;">${t.failedHurdles.slice(0, 2).join(', ')}${t.failedHurdles.length > 2 ? '…' : ''}</td>
      <td style="font-size:11px;">${fmtTime(new Date(t.ts))}</td>
      <td>${statusBadge}</td>
      <td>${action}</td>
    </tr>`;
  }
  return `<tr>
    <td>${t.id}</td>
    <td>${new Date(t.ts).toLocaleString('en-GH')}</td>
    <td>${t.profile.name}</td>
    <td>${fmt(t.amount)}</td>
    <td>${riskBadge}</td>
    <td>${statusBadge}</td>
    <td>${action}</td>
  </tr>`;
}

// ─── DASHBOARD ──────────────────────────────────────────────────────────────

function renderDashboard(data) {
  const notice = document.getElementById('engineNotice');
  if (running && notice) notice.style.display = 'none';

  const total = data.length;
  const safe  = data.filter(t => t.risk === 'safe').length;
  const mod   = data.filter(t => t.risk === 'moderate').length;
  const high  = data.filter(t => t.risk === 'high').length;
  const saved = data.filter(t => t.confirmed === false).reduce((a, t) => a + t.amount, 0);

  _setText('st-total', total);
  _setText('st-safe',  safe);
  _setText('st-mod',   mod);
  _setText('st-high',  high);
  _setText('st-saved', fmt(saved));
  _setText('st-rate',  total ? Math.round((safe / total) * 100) + '%' : '—');

  // Distribution bars
  if (total > 0) {
    _setText('distMeta', total + ' total');
    const bars = document.getElementById('distBars');
    if (bars) {
      bars.innerHTML = ['safe', 'moderate', 'high'].map(r => {
        const cnt = r === 'safe' ? safe : r === 'moderate' ? mod : high;
        const pct = Math.round((cnt / total) * 100);
        const col = r === 'safe' ? 'var(--safe-green)' : r === 'moderate' ? 'var(--warn-amber)' : 'var(--danger-red)';
        const lbl = r === 'safe' ? 'Safe' : r === 'moderate' ? 'Moderate' : 'High Risk';
        return `<div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
            <span style="color:${col};font-weight:700;">${lbl}</span>
            <span class="text-muted">${cnt} (${pct}%)</span>
          </div>
          <div style="background:#E2E8F0;border-radius:2px;height:14px;">
            <div style="width:${pct}%;height:100%;background:${col};border-radius:2px;transition:width .4s;"></div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // Trend SVG
  const scores = data.slice(0, 20).reverse().map(t => t.score);
  if (scores.length > 1) {
    const svg = document.getElementById('trendSvg');
    if (svg) {
      const w = svg.clientWidth || 540, h = 90, max = 100;
      const pts = scores.map((s, i) => `${(i / (scores.length - 1)) * w},${h - (s / max) * (h - 10) + 5}`).join(' ');
      svg.innerHTML = `
        <defs>
          <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1B2A4A" stop-opacity=".15"/>
            <stop offset="100%" stop-color="#1B2A4A" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="${pts} ${w},${h} 0,${h}" fill="url(#tg)"/>
        <polyline points="${pts}" fill="none" stroke="var(--gov-navy)" stroke-width="2"/>
        ${scores.map((s, i) => {
          const x = (i / (scores.length - 1)) * w;
          const y = h - (s / max) * (h - 10) + 5;
          const col = s <= threshSafe ? 'var(--safe-green)' : s <= threshMod ? 'var(--warn-amber)' : 'var(--danger-red)';
          return `<circle cx="${x}" cy="${y}" r="4" fill="${col}" stroke="#fff" stroke-width="1.5"/>`;
        }).join('')}
      `;
    }
  }

  // High-risk table
  const highTxns = data.filter(t => t.risk === 'high').slice(0, 8);
  const dashBody = document.getElementById('dashHighBody');
  if (dashBody) {
    dashBody.innerHTML = highTxns.length
      ? highTxns.map(t => txnRow(t, true)).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--gov-muted);padding:28px;">No high-risk transactions detected.</td></tr>';
  }

  // User type chart
  const typeData = {};
  PROFILES.forEach(p => { typeData[p.type] = { total: 0, high: 0 }; });
  data.forEach(t => {
    if (typeData[t.profile.type]) {
      typeData[t.profile.type].total++;
      if (t.risk === 'high') typeData[t.profile.type].high++;
    }
  });
  const typeChart = document.getElementById('userTypeChart');
  if (typeChart) {
    typeChart.innerHTML = Object.entries(typeData).map(([type, d]) => {
      const pct = d.total ? Math.round((d.high / d.total) * 100) : 0;
      return `<div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
          <span class="fw-700">${type}</span>
          <span class="text-muted">${d.high}/${d.total} high-risk</span>
        </div>
        <div style="background:#E2E8F0;border-radius:2px;height:10px;">
          <div style="width:${pct}%;height:100%;background:var(--danger-red);border-radius:2px;transition:width .4s;"></div>
        </div>
      </div>`;
    }).join('');
  }
}

// ─── MONITOR PAGE ───────────────────────────────────────────────────────────

function renderMonitorPage(data) {
  const safe = data.filter(t => t.risk === 'safe').length;
  const mod  = data.filter(t => t.risk === 'moderate').length;
  const high = data.filter(t => t.risk === 'high').length;
  _setText('monC-safe', safe);
  _setText('monC-mod',  mod);
  _setText('monC-high', high);

  const feed = document.getElementById('monitorFeed');
  if (!feed) return;
  feed.innerHTML = '';

  data.forEach(txn => {
    const awaitingFilter = monFilter === 'awaiting';
    if (awaitingFilter && txn.status !== 'awaiting_customer') return;
    if (!awaitingFilter && monFilter !== 'all' && txn.risk !== monFilter) return;
    if (typeFilter !== 'all' && txn.profile.type !== typeFilter) return;

    const borderCol = txn.risk === 'high' ? 'var(--danger-red)' : txn.risk === 'moderate' ? 'var(--warn-amber)' : 'var(--safe-green)';
    const bg        = txn.risk === 'high' ? '#FFF5F5'           : txn.risk === 'moderate' ? '#FFFBEB'           : '#F0FFF4';
    const el        = document.createElement('div');
    el.style.cssText = `background:${bg};border:1px solid var(--gov-border);border-left:4px solid ${borderCol};padding:12px 16px;margin-bottom:10px;border-radius:2px;animation:slideIn .3s ease;`;
    el.innerHTML = `
      <style>@keyframes slideIn{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:none;}}</style>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
            <span class="badge badge-${txn.risk}">${txn.risk.toUpperCase()} · ${txn.score}</span>
            <span style="font-size:11px;font-family:monospace;color:var(--gov-muted);">${txn.id}</span>
            <span style="font-size:11px;color:var(--gov-muted);">${fmtTime(new Date(txn.ts))}</span>
          </div>
          <div style="font-size:14px;font-weight:600;color:var(--gov-navy);margin-bottom:4px;">
            ${txn.profile.name} · ${fmt(txn.amount)} → ${txn.recipient}
          </div>
          <div style="font-size:12px;color:var(--gov-muted);">${txn.device} · ${txn.location}</div>
          ${txn.failedHurdles && txn.failedHurdles.length
            ? `<div style="font-size:11px;color:var(--danger-red);margin-top:4px;">Failed: ${txn.failedHurdles.join(', ')}</div>`
            : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          ${txn.risk === 'high' && txn.confirmed === null ? `
            <button class="btn btn-success btn-sm" onclick="confirmTxn('${txn.id}')">Confirm</button>
            <button class="btn btn-danger  btn-sm" onclick="cancelTxn('${txn.id}')">Cancel</button>
            <button class="btn btn-outline btn-sm" onclick="openTxnModal('${txn.id}')">Detail</button>
          ` : `<button class="btn btn-outline btn-sm" onclick="openTxnModal('${txn.id}')">Detail</button>`}
        </div>
      </div>
    `;
    feed.appendChild(el);
  });
}

function setMonFilter(f, el) {
  monFilter = f;
  document.querySelectorAll('.sidebar-link').forEach(a => a.classList.remove('active'));
  if (el) el.classList.add('active');
  renderMonitorPage(transactions.slice(0, 40));
}

function setTypeFilter(f, el) {
  typeFilter = f;
  document.querySelectorAll('.active-type').forEach(a => a.classList.remove('active-type'));
  if (el) el.classList.add('active-type');
  renderMonitorPage(transactions.slice(0, 40));
}

function clearMonitor() {
  const feed = document.getElementById('monitorFeed');
  if (feed) feed.innerHTML = '';
}

// ─── TRANSACTIONS PAGE ──────────────────────────────────────────────────────

function renderTxnTable() {
  const rfEl = document.getElementById('txnRiskFilter');
  const sfEl = document.getElementById('txnStatusFilter');
  const rf = rfEl ? rfEl.value : 'all';
  const sf = sfEl ? sfEl.value : 'all';

  fetch('/api/transactions').then(r => r.json()).then(data => {
    transactions = data;
    const filtered = data.filter(t =>
      (rf === 'all' || t.risk === rf) &&
      (sf === 'all' || t.status === sf)
    );
    _setText('txnCount', filtered.length + ' transactions recorded');
    const body = document.getElementById('txnBody');
    if (!body) return;
    if (!filtered.length) {
      body.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--gov-muted);padding:40px;">No transactions match the selected filters.</td></tr>';
    } else {
      body.innerHTML = filtered.map(t => `<tr>
        <td>${t.id}</td>
        <td>${new Date(t.ts).toLocaleString('en-GH')}</td>
        <td>${t.profile.name}</td>
        <td>${t.profile.type}</td>
        <td>${fmt(t.amount)}</td>
        <td>${t.recipient}</td>
        <td>${t.device}</td>
        <td>${t.location}</td>
        <td>${t.score}</td>
        <td>${t.risk.toUpperCase()}</td>
        <td>${t.status}</td>
        <td><button class="btn btn-outline btn-sm" onclick="openTxnModal('${t.id}')">View</button></td>
      </tr>`).join('');
    }
  });
}

function exportCSV() {
  fetch('/api/transactions').then(r => r.json()).then(data => {
    const header = ['Ref No', 'Date/Time', 'Customer', 'Type', 'Amount', 'Recipient', 'Device', 'Location', 'Risk Score', 'Risk Level', 'Status', 'Fraud Type'];
    const rows = data.map(t => [
      t.id,
      new Date(t.ts).toLocaleString('en-GH'),
      t.profile.name,
      t.profile.type,
      t.amount,
      t.recipient,
      t.device,
      t.location,
      t.score,
      t.risk,
      t.status,
      t.fraudType || '',
    ]);
    const csv = [header].concat(rows).map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'pfis_transactions_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    addLog('📥 CSV export downloaded (' + data.length + ' records).');
  });
}

function renderTransactionsPage(data) {
  const container = document.getElementById('txnContainer');
  if (!container) return;
  if (!data.length) { container.innerHTML = '<p>No transactions available.</p>'; return; }
  const rows = data.map(t => `<tr>
    <td>${t.id}</td>
    <td>${new Date(t.ts).toLocaleString('en-GH')}</td>
    <td>${t.profile.name}</td>
    <td>${fmt(t.amount)}</td>
    <td>${t.risk.toUpperCase()}</td>
  </tr>`).join('');
  container.innerHTML = `<table class="gov-table"><thead><tr><th>Ref</th><th>Date</th><th>Customer</th><th>Amount</th><th>Risk</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ─── PROFILES PAGE ──────────────────────────────────────────────────────────

function renderProfilesPage(data) {
  const container = document.getElementById('profileContainer');
  if (!container) return;
  container.innerHTML = data.map(p => {
    // Compute stats for this profile from local transaction store
    const ptxns = transactions.filter(t => t.profile.id === p.id);
    const phigh = ptxns.filter(t => t.risk === 'high').length;
    return `<div class="card">
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px;">
          <div style="
            width:44px;height:44px;border-radius:50%;background:var(--gov-navy,#1B2A4A);
            color:#fff;display:flex;align-items:center;justify-content:center;
            font-weight:700;font-size:15px;flex-shrink:0;
          ">${p.initials}</div>
          <div>
            <h4 style="margin:0;">${p.name}</h4>
            <p style="margin:2px 0 0;font-size:12px;color:var(--gov-muted,#6B7280);">${p.type} — ${p.sub}</p>
          </div>
        </div>
        <p style="font-size:11px;color:#555;margin:0 0 6px;">${p.id}</p>
        <div style="font-size:12px;color:var(--gov-muted,#6B7280);">
          Avg: ${fmt(p.avg)} · ${p.location} · Active ${p.hours[0]}:00–${p.hours[1]}:00
        </div>
        ${ptxns.length ? `<div style="font-size:12px;margin-top:6px;">
          <span>${ptxns.length} txns</span>
          ${phigh ? `<span style="color:var(--danger-red);margin-left:8px;">⚠ ${phigh} high-risk</span>` : ''}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── INVESTIGATIONS PAGE ────────────────────────────────────────────────────

function renderInvestPage(data) {
  const container = document.getElementById('investContainer');
  if (!container) return;
  if (!data.length) { container.innerHTML = '<p style="color:var(--gov-muted);">No investigations logged.</p>'; return; }
  container.innerHTML = `
    <table class="gov-table">
      <thead>
        <tr>
          <th>Case ID</th><th>Transaction</th><th>Customer</th>
          <th>Amount</th><th>Fraud Type</th><th>Status</th><th>Opened</th>
        </tr>
      </thead>
      <tbody>
        ${data.map(i => `<tr>
          <td style="font-family:monospace;font-size:11px;">${i.id}</td>
          <td style="font-family:monospace;font-size:11px;">${i.txnId || '—'}</td>
          <td>${i.account}</td>
          <td>${fmt(i.amount)}</td>
          <td>${i.fraudType || '—'}</td>
          <td><span class="badge" style="background:${i.status === 'Open' ? '#553C9A' : '#276749'};color:#fff;">${i.status}</span></td>
          <td style="font-size:11px;">${i.opened ? new Date(i.opened).toLocaleString('en-GH') : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

// ─── REPORTS PAGE ───────────────────────────────────────────────────────────

function renderReportsPage(stat) {
  _setText('rpt-total', stat.total);
  _setText('rpt-rate',  stat.total ? Math.round((stat.safe + stat.mod) / stat.total * 100) + '%' : '—');
  _setText('rpt-saved', fmt(stat.saved || 0));

  // Hurdle failure bars
  const hfArr = Object.entries(stat.hfStats || {});
  const maxHF = hfArr.length ? Math.max(...hfArr.map(([, v]) => v)) : 1;
  _setHTML('hurdleStats', hfArr.length ? hfArr.map(([name, cnt]) => {
    const pct = Math.round((cnt / maxHF) * 100);
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
        <span class="fw-700">${name}</span><span class="text-muted">${cnt} failures</span>
      </div>
      <div style="background:#E2E8F0;border-radius:2px;height:12px;">
        <div style="width:${pct}%;height:100%;background:var(--gov-navy);border-radius:2px;transition:width .4s;"></div>
      </div>
    </div>`;
  }).join('') : '<div class="text-muted text-small">No data.</div>');

  // Risk by segment
  const segArr = Object.entries(stat.seg || {});
  _setHTML('riskBySegment', segArr.map(([type, d]) => {
    const tot = d.safe + d.mod + d.high;
    return `<div style="margin-bottom:12px;">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px;">${type} (${tot} txns)</div>
      <div style="display:flex;height:16px;border-radius:2px;overflow:hidden;">
        <div style="width:${tot ? Math.round((d.safe / tot) * 100) : 0}%;background:var(--safe-green);"></div>
        <div style="width:${tot ? Math.round((d.mod  / tot) * 100) : 0}%;background:var(--warn-amber);"></div>
        <div style="width:${tot ? Math.round((d.high / tot) * 100) : 0}%;background:var(--danger-red);"></div>
      </div>
      <div style="display:flex;gap:12px;font-size:11px;margin-top:4px;color:var(--gov-muted);">
        <span>Safe: ${d.safe}</span><span>Moderate: ${d.mod}</span>
        <span style="color:var(--danger-red);">High: ${d.high}</span>
      </div>
    </div>`;
  }).join(''));

  // Fraud type breakdown
  const ftArr = Object.entries(stat.fTypes || {});
  const ftMax = ftArr.length ? Math.max(...ftArr.map(([, v]) => v)) : 1;
  _setHTML('fraudTypeBreakdown', ftArr.map(([name, cnt]) => {
    const pct = ftMax ? Math.round((cnt / ftMax) * 100) : 0;
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
        <span class="fw-700">${name}</span><span class="text-muted">${cnt} incidents</span>
      </div>
      <div style="background:#E2E8F0;border-radius:2px;height:12px;">
        <div style="width:${pct}%;height:100%;background:var(--danger-red);border-radius:2px;transition:width .4s;"></div>
      </div>
    </div>`;
  }).join(''));
}

// Build the reports stats object from local transactions (used when server is absent)
function _buildLocalReportStats() {
  const stat = {
    total: transactions.length,
    safe:  transactions.filter(t => t.risk === 'safe').length,
    mod:   transactions.filter(t => t.risk === 'moderate').length,
    high:  transactions.filter(t => t.risk === 'high').length,
    saved: transactions.filter(t => t.confirmed === false).reduce((a, t) => a + t.amount, 0),
    hfStats: {},
    seg:  {},
    fTypes: {},
  };
  // Hurdle failure counts
  transactions.forEach(t => {
    t.failedHurdles.forEach(h => { stat.hfStats[h] = (stat.hfStats[h] || 0) + 1; });
    // Segment breakdown
    const type = t.profile.type;
    if (!stat.seg[type]) stat.seg[type] = { safe: 0, mod: 0, high: 0 };
    if (t.risk === 'safe')     stat.seg[type].safe++;
    if (t.risk === 'moderate') stat.seg[type].mod++;
    if (t.risk === 'high')     stat.seg[type].high++;
    // Fraud type
    if (t.fraudType) stat.fTypes[t.fraudType] = (stat.fTypes[t.fraudType] || 0) + 1;
  });
  return stat;
}

// ─── SETTINGS PAGE ──────────────────────────────────────────────────────────

function renderSettingsPage(cfg) {
  const safeInput     = document.getElementById('thresh-safe');
  const modInput      = document.getElementById('thresh-mod');
  const intervalInput = document.getElementById('txnInterval');
  if (safeInput)     safeInput.value     = cfg.threshSafe;
  if (modInput)      modInput.value      = cfg.threshMod;
  if (intervalInput) intervalInput.value = cfg.txnInterval / 1000;
}

function showSettings(id, el) {
  ['risk', 'alerts', 'integration', 'engine', 'users'].forEach(s => {
    const section = document.getElementById('settings-' + s);
    if (section) section.style.display = 'none';
  });
  const target = document.getElementById('settings-' + id);
  if (target) target.style.display = 'block';
  document.querySelectorAll('.sidebar-link').forEach(a => a.classList.remove('active'));
  if (el) el.classList.add('active');
}

function saveThresholds() {
  const safeVal = parseInt(document.getElementById('thresh-safe').value);
  const modVal  = parseInt(document.getElementById('thresh-mod').value);
  const newInterval = parseFloat(document.getElementById('txnInterval').value) * 1000;

  if (isNaN(safeVal) || isNaN(modVal) || safeVal < 0 || modVal > 100 || safeVal >= modVal) {
    alert('Invalid thresholds. Ensure 0 ≤ Safe < Moderate ≤ 100.');
    return;
  }

  threshSafe = safeVal;
  threshMod  = modVal;

  txnInterval = newInterval;
  // Server restarts its own interval when it receives the updated settings

  fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ threshSafe, threshMod, txnInterval }),
  }).catch(() => {});

  addLog('⚙ Thresholds updated: Safe ≤' + threshSafe + ', Moderate ≤' + threshMod + ', Interval ' + txnInterval / 1000 + 's');
  alert('Configuration saved.\nSafe ≤ ' + threshSafe + '  |  Moderate ≤ ' + threshMod + '  |  Interval: ' + txnInterval / 1000 + 's');
}

function generateReport() {
  const stat = _buildLocalReportStats();
  renderReportsPage(stat);
  addLog('📊 Report generated from ' + stat.total + ' local transactions.');
}

// ─── PAGE INITIALIZATION ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Sync engine button state with server on every page load
  syncEngineState();
  setInterval(syncEngineState, 5000);

  const path = window.location.pathname;

  // ── Always fetch fresh data from server (engine is server-side) ────────────
  if (path === '/') {
    const refresh = () => {
      fetch('/api/transactions')
        .then(r => r.json())
        .then(data => { transactions = data; renderDashboard(transactions); })
        .catch(() => {});
    };
    refresh();
    setInterval(refresh, 2000);
  }

  if (path === '/monitor') {
    const poll = () => {
      fetch('/api/monitor')
        .then(r => r.json())
        .then(data => { renderMonitorPage(data); })
        .catch(() => {});
    };
    poll();
    setInterval(poll, 2000);
  }

  if (path === '/transactions') {
    renderTxnTable();
    setInterval(renderTxnTable, 3000);
  }

  if (path === '/profiles') {
    fetch('/api/profiles')
      .then(r => r.json())
      .then(renderProfilesPage)
      .catch(() => renderProfilesPage(PROFILES));
  }

  if (path === '/investigations') {
    const pollInvest = () => {
      fetch('/api/investigations')
        .then(r => r.json())
        .then(renderInvestPage)
        .catch(() => {});
    };
    pollInvest();
    setInterval(pollInvest, 3000);
  }

  if (path === '/reports') {
    const pollReports = () => {
      fetch('/api/reports')
        .then(r => r.json())
        .then(renderReportsPage)
        .catch(() => {});
    };
    pollReports();
    setInterval(pollReports, 5000);
  }

  if (path === '/settings') {
    fetch('/api/settings')
      .then(r => r.json())
      .then(cfg => { renderSettingsPage(cfg); showSettings('risk'); })
      .catch(() => {
        renderSettingsPage({ threshSafe, threshMod, txnInterval });
        showSettings('risk');
      });
  }

  // Clock widget
  const clockEl = document.getElementById('dashTime');
  if (clockEl) {
    const updateClock = () => {
      const now = new Date();
      clockEl.innerHTML = `
        <div style="font-size:16px;font-weight:700;">${fmtTime(now)}</div>
        <div>${now.toLocaleDateString('en-GH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
      `;
    };
    updateClock();
    setInterval(updateClock, 1000);
  }
});

// ─── MICRO-HELPERS ──────────────────────────────────────────────────────────
function _setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function _setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
