// Day Trade Dashboard — vanilla JS SPA

const API = '';
let currentTab = 'positions';
let refreshInterval = null;

// ── Tab switching ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    document.getElementById(`tab-${currentTab}`).classList.add('active');
    loadTab(currentTab);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(val, decimals = 2) {
  if (val === null || val === undefined) return '—';
  return parseFloat(val).toFixed(decimals);
}

function fmtPnl(val) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  const cls = n > 0 ? 'bullish' : n < 0 ? 'bearish' : '';
  return `<span class="${cls}">${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}</span>`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function setRows(tableId, rows) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  tbody.innerHTML = rows.length === 0
    ? `<tr><td colspan="20" class="empty-state">No data</td></tr>`
    : rows.join('');
}

// ── Loaders ───────────────────────────────────────────────────────────────────
async function loadPositions() {
  const data = await fetch(`${API}/api/positions`).then(r => r.json()).catch(() => ({ positions: [] }));
  const rows = (data.positions || []).map(p => `
    <tr>
      <td><code>${p.option_symbol}</code></td>
      <td class="${p.option_right}">${p.option_right?.toUpperCase()}</td>
      <td>${p.qty}</td>
      <td>$${fmt(p.entry_price)}</td>
      <td>$${p.current_stop ? fmt(p.current_stop) : '—'}</td>
      <td>$${p.current_tp ? fmt(p.current_tp) : '—'}</td>
      <td>${fmtTime(p.opened_at)}</td>
    </tr>
  `);
  setRows('tbl-positions', rows);
  document.getElementById('val-positions').textContent = data.positions?.length ?? 0;
}

async function loadSignals() {
  const data = await fetch(`${API}/api/signals?limit=50`).then(r => r.json()).catch(() => ({ signals: [] }));
  const rows = (data.signals || []).map(s => `
    <tr>
      <td>${fmtTime(s.created_at)}</td>
      <td><b>${s.ticker}</b></td>
      <td class="${s.direction}">${s.direction}</td>
      <td>${s.alignment}</td>
      <td>${(parseFloat(s.confidence) * 100).toFixed(0)}%</td>
      <td>${s.triggered_by}</td>
      <td>${s.selected_right?.toUpperCase() ?? '—'}</td>
      <td>${s.entry_premium ? '$' + fmt(s.entry_premium) : '—'}</td>
      <td>${s.risk_reward ? fmt(s.risk_reward) : '—'}</td>
    </tr>
  `);
  setRows('tbl-signals', rows);
  document.getElementById('val-signals').textContent = data.signals?.length ?? 0;
}

async function loadDecisions() {
  const data = await fetch(`${API}/api/decisions`).then(r => r.json()).catch(() => ({ decisions: [] }));
  const rows = (data.decisions || []).map(d => `
    <tr>
      <td>${fmtTime(d.created_at)}</td>
      <td><b>${d.ticker}</b></td>
      <td class="decision-${d.decision_type}"><b>${d.decision_type}</b></td>
      <td>${d.confirmation_count}</td>
      <td>${d.orchestration_confidence ? (parseFloat(d.orchestration_confidence) * 100).toFixed(0) + '%' : '—'}</td>
      <td>${d.should_execute ? '✅' : '—'}</td>
      <td class="reasoning" title="${d.reasoning || ''}">${d.reasoning || '—'}</td>
    </tr>
  `);
  setRows('tbl-decisions', rows);
}

async function loadEvaluations() {
  const data = await fetch(`${API}/api/evaluations`).then(r => r.json()).catch(() => ({ evaluations: [] }));
  const rows = (data.evaluations || []).map(e => `
    <tr>
      <td>${fmtDate(e.evaluated_at)}</td>
      <td><b>${e.ticker}</b></td>
      <td class="grade-${e.evaluation_grade}">${e.evaluation_grade}</td>
      <td>${e.evaluation_score}</td>
      <td>${e.outcome}</td>
      <td>${fmtPnl(e.pnl_total)}</td>
      <td>${e.hold_duration_min}m</td>
      <td class="reasoning" title="${e.lessons_learned || ''}">${e.lessons_learned || '—'}</td>
    </tr>
  `);
  setRows('tbl-evaluations', rows);

  // Last grade card
  const last = data.evaluations?.[0];
  if (last) {
    const el = document.getElementById('val-grade');
    el.textContent = last.evaluation_grade;
    el.className = `card-value grade-${last.evaluation_grade}`;
  }
}

async function loadOrders() {
  const data = await fetch(`${API}/api/orders`).then(r => r.json()).catch(() => ({ orders: [] }));
  const rows = (data.orders || []).map(o => `
    <tr>
      <td>${fmtTime(o.submitted_at)}</td>
      <td><code>${o.option_symbol}</code></td>
      <td>${o.order_side}</td>
      <td>${o.submitted_qty}</td>
      <td>${o.submitted_price ? '$' + fmt(o.submitted_price) : '—'}</td>
      <td>${o.fill_price ? '$' + fmt(o.fill_price) : '—'}</td>
      <td>${o.alpaca_status ?? '—'}</td>
    </tr>
  `);
  setRows('tbl-orders', rows);
}

async function loadPnl() {
  const data = await fetch(`${API}/api/pnl/daily`).then(r => r.json()).catch(() => ({ daily: [] }));
  const today = data.daily?.[0];
  if (today) {
    const el = document.getElementById('val-pnl');
    const pnl = parseFloat(today.total_pnl ?? 0);
    el.innerHTML = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
    el.className = `card-value ${pnl > 0 ? 'green' : pnl < 0 ? 'red' : ''}`;
  }
}

// ── Main refresh ──────────────────────────────────────────────────────────────
function loadTab(tab) {
  switch (tab) {
    case 'positions':   loadPositions(); break;
    case 'signals':     loadSignals();   break;
    case 'decisions':   loadDecisions(); break;
    case 'evaluations': loadEvaluations(); break;
    case 'orders':      loadOrders();    break;
  }
}

async function refreshAll() {
  loadPositions();
  loadPnl();
  loadEvaluations();
  loadTab(currentTab);
  document.getElementById('last-updated').textContent =
    `Last updated: ${new Date().toLocaleTimeString()}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
refreshAll();
refreshInterval = setInterval(refreshAll, 30_000);  // 30 second auto-refresh
