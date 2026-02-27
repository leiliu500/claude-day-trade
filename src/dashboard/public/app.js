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

function fmtPct(val, decimals = 1) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val) * 100;
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
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
      <td>${p.strike ? '$' + fmt(p.strike, 0) : '—'}</td>
      <td>${p.expiration ? fmtDate(p.expiration) : '—'}</td>
      <td>${p.qty}</td>
      <td>$${fmt(p.entry_price)}</td>
      <td>${p.current_stop ? '$' + fmt(p.current_stop) : '—'}</td>
      <td>${p.current_tp ? '$' + fmt(p.current_tp) : '—'}</td>
      <td>${p.conviction_score ?? '—'}</td>
      <td>${p.conviction_tier ?? '—'}</td>
      <td class="${p.direction ?? ''}">${p.direction ?? '—'}</td>
      <td class="decision-${p.decision_type}">${p.decision_type ?? '—'}</td>
      <td>${p.confirmation_count ?? '—'}</td>
      <td>${fmtTime(p.opened_at)}</td>
      <td class="reasoning" title="${p.entry_reasoning || ''}">${p.entry_reasoning || '—'}</td>
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
      <td>${s.profile}</td>
      <td class="${s.direction}">${s.direction}</td>
      <td>${s.alignment}</td>
      <td>${(parseFloat(s.confidence) * 100).toFixed(0)}%</td>
      <td>${s.confidence_meets_threshold ? '✅' : '—'}</td>
      <td>${s.triggered_by}</td>
      <td class="${s.selected_right ?? ''}">${s.selected_right?.toUpperCase() ?? '—'}</td>
      <td><code>${s.selected_symbol ?? '—'}</code></td>
      <td>${s.entry_premium ? '$' + fmt(s.entry_premium) : '—'}</td>
      <td>${s.stop_premium ? '$' + fmt(s.stop_premium) : '—'}</td>
      <td>${s.tp_premium ? '$' + fmt(s.tp_premium) : '—'}</td>
      <td>${s.risk_reward ? fmt(s.risk_reward) : '—'}</td>
      <td>${s.spread_pct ? fmt(s.spread_pct, 1) + '%' : '—'}</td>
      <td>${s.option_liquidity_ok ? '✅' : '—'}</td>
    </tr>
  `);
  setRows('tbl-signals', rows);
  document.getElementById('val-signals').textContent = data.total_today ?? 0;
}

async function loadDecisions() {
  const data = await fetch(`${API}/api/decisions`).then(r => r.json()).catch(() => ({ decisions: [] }));
  const rows = (data.decisions || []).map(d => `
    <tr>
      <td>${fmtTime(d.created_at)}</td>
      <td><b>${d.ticker}</b></td>
      <td>${d.profile}</td>
      <td class="${d.direction ?? ''}">${d.direction ?? '—'}</td>
      <td class="decision-${d.decision_type}"><b>${d.decision_type}</b></td>
      <td>${d.confirmation_count}</td>
      <td>${d.orchestration_confidence ? (parseFloat(d.orchestration_confidence) * 100).toFixed(0) + '%' : '—'}</td>
      <td>${d.urgency ?? '—'}</td>
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
      <td><code>${e.option_symbol ?? '—'}</code></td>
      <td class="grade-${e.evaluation_grade}">${e.evaluation_grade}</td>
      <td>${e.evaluation_score}</td>
      <td class="${e.outcome === 'WIN' ? 'bullish' : e.outcome === 'LOSS' ? 'bearish' : ''}">${e.outcome}</td>
      <td>${fmtPnl(e.pnl_total)}</td>
      <td>${e.pnl_pct !== null && e.pnl_pct !== undefined ? fmtPct(e.pnl_pct) : '—'}</td>
      <td>${e.entry_price ? '$' + fmt(e.entry_price) : '—'}</td>
      <td>${e.exit_price ? '$' + fmt(e.exit_price) : '—'}</td>
      <td>${e.hold_duration_min != null ? e.hold_duration_min + 'm' : '—'}</td>
      <td>${e.signal_quality ?? '—'}</td>
      <td>${e.timing_quality ?? '—'}</td>
      <td>${e.risk_management_quality ?? '—'}</td>
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
      <td><b>${o.ticker}</b></td>
      <td><code>${o.option_symbol}</code></td>
      <td class="${o.order_side === 'buy' ? 'bullish' : 'bearish'}">${o.order_side}</td>
      <td>${o.order_type ?? '—'}</td>
      <td>${o.submitted_qty}</td>
      <td>${o.filled_qty ?? '—'}</td>
      <td>${o.submitted_price ? '$' + fmt(o.submitted_price) : '—'}</td>
      <td>${o.fill_price ? '$' + fmt(o.fill_price) : '—'}</td>
      <td>${o.alpaca_status ?? '—'}</td>
      <td>${o.filled_at ? fmtTime(o.filled_at) : '—'}</td>
      <td class="${o.error_message ? 'bearish' : ''}" title="${o.error_message || ''}">${o.error_message ? '⚠ ' + o.error_message.slice(0, 30) : '—'}</td>
    </tr>
  `);
  setRows('tbl-orders', rows);
}

async function loadAgents() {
  const data = await fetch(`${API}/api/agents`).then(r => r.json()).catch(() => ({ agents: [] }));
  const agents = data.agents || [];
  document.getElementById('val-agents').textContent = agents.length;

  const container = document.getElementById('agent-cards');
  if (!container) return;

  if (agents.length === 0) {
    container.innerHTML = `<div class="agent-empty">No live agents — no open positions.</div>`;
    return;
  }

  container.innerHTML = agents.map(a => {
    const phaseCls = `phase-${a.phase}`;
    const dirCls   = a.direction === 'BULLISH' ? 'bullish' : a.direction === 'BEARISH' ? 'bearish' : 'neutral';
    const sideCls  = a.optionRight === 'call' ? 'bullish' : 'bearish';
    const pnlEl    = a.fillPrice
      ? (() => {
          const pnl = ((a.fillPrice - a.limitPrice) / a.limitPrice * 100);
          return `<span class="${pnl >= 0 ? 'bullish' : 'bearish'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</span>`;
        })()
      : '—';

    return `
      <div class="agent-card">
        <div class="agent-card-header">
          <div class="agent-title">
            <span class="agent-ticker">${a.ticker}</span>
            <span class="${sideCls}">${a.optionRight?.toUpperCase()}</span>
            <code class="agent-symbol">${a.optionSymbol}</code>
          </div>
          <span class="phase-badge ${phaseCls}">${a.phase.replace('_', ' ')}</span>
        </div>
        <div class="agent-meta">
          <span class="${dirCls}">${a.direction}</span>
          <span class="meta-sep">·</span>
          <span>${a.profile}</span>
          <span class="meta-sep">·</span>
          <span>${(a.confidence * 100).toFixed(0)}% conf</span>
          <span class="meta-sep">·</span>
          <span>${a.alignment}</span>
        </div>
        <div class="agent-stats">
          <div class="agent-stat"><span class="stat-label">Qty</span><span>${a.qty}</span></div>
          <div class="agent-stat"><span class="stat-label">Entry</span><span>$${fmt(a.limitPrice)}</span></div>
          <div class="agent-stat"><span class="stat-label">Fill</span><span>${a.fillPrice ? '$' + fmt(a.fillPrice) : '—'}</span></div>
          <div class="agent-stat"><span class="stat-label">Ticks</span><span>${a.tickCount}</span></div>
          <div class="agent-stat"><span class="stat-label">Opened</span><span>${fmtTime(a.openedAt)}</span></div>
          <div class="agent-stat"><span class="stat-label">Decision</span><span class="decision-${a.decisionType}">${a.decisionType}</span></div>
        </div>
        <div class="agent-reasoning" title="${a.decisionReasoning || ''}">${a.decisionReasoning || '—'}</div>
      </div>
    `;
  }).join('');
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
    case 'positions':   loadPositions();   break;
    case 'signals':     loadSignals();     break;
    case 'decisions':   loadDecisions();   break;
    case 'evaluations': loadEvaluations(); break;
    case 'orders':      loadOrders();      break;
    case 'agents':      loadAgents();      break;
  }
}

async function refreshAll() {
  loadPositions();
  loadPnl();
  loadEvaluations();
  loadAgents();
  loadTab(currentTab);
  document.getElementById('last-updated').textContent =
    `Last updated: ${new Date().toLocaleTimeString()}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
refreshAll();
refreshInterval = setInterval(refreshAll, 30_000);  // 30 second auto-refresh
