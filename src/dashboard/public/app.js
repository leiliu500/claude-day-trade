// Day Trade Dashboard — vanilla JS SPA

const API = '';
let currentTab = 'positions';
let refreshInterval = null;

// ── Pagination state ──────────────────────────────────────────────────────────
const paging = {
  signals:     { page: 1, limit: 50, total: 0 },
  decisions:   { page: 1, limit: 50, total: 0 },
  evaluations: { page: 1, limit: 50, total: 0 },
  orders:      { page: 1, limit: 50, total: 0 },
  scheduler:   { page: 1, limit: 50, total: 0 },
};

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

// ── Pagination UI ─────────────────────────────────────────────────────────────
function renderPagination(key, loadFn) {
  const s = paging[key];
  const totalPages = Math.ceil(s.total / s.limit) || 1;
  const start = s.total === 0 ? 0 : (s.page - 1) * s.limit + 1;
  const end   = Math.min(s.page * s.limit, s.total);

  const el = document.getElementById(`pagination-${key}`);
  if (!el) return;

  el.innerHTML = `
    <div class="pagination">
      <span class="pagination-info">Showing ${start}–${end} of ${s.total}</span>
      <div class="pagination-controls">
        <button class="pg-btn" ${s.page <= 1 ? 'disabled' : ''} onclick="goPage('${key}', 1, ${JSON.stringify(loadFn.name)})">«</button>
        <button class="pg-btn" ${s.page <= 1 ? 'disabled' : ''} onclick="goPage('${key}', ${s.page - 1}, '${loadFn.name}')">‹</button>
        <span class="pg-current">Page ${s.page} / ${totalPages}</span>
        <button class="pg-btn" ${s.page >= totalPages ? 'disabled' : ''} onclick="goPage('${key}', ${s.page + 1}, '${loadFn.name}')">›</button>
        <button class="pg-btn" ${s.page >= totalPages ? 'disabled' : ''} onclick="goPage('${key}', ${totalPages}, '${loadFn.name}')">»</button>
        <select class="pg-limit" onchange="changeLimit('${key}', this.value, '${loadFn.name}')">
          ${[25, 50, 100, 200].map(n => `<option value="${n}" ${s.limit === n ? 'selected' : ''}>${n} / page</option>`).join('')}
        </select>
      </div>
    </div>
  `;
}

const loaderMap = {};
window.goPage = function(key, page, fnName) {
  paging[key].page = page;
  loaderMap[fnName]();
};
window.changeLimit = function(key, val, fnName) {
  paging[key].limit = parseInt(val);
  paging[key].page  = 1;
  loaderMap[fnName]();
};

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
loaderMap['loadPositions'] = loadPositions;

async function loadSignals() {
  const s = paging.signals;
  const data = await fetch(`${API}/api/signals?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ signals: [] }));
  s.total = data.total ?? 0;
  const rows = (data.signals || []).map(sig => `
    <tr>
      <td>${fmtTime(sig.created_at)}</td>
      <td><b>${sig.ticker}</b></td>
      <td>${sig.profile}</td>
      <td class="${sig.direction}">${sig.direction}</td>
      <td>${sig.alignment}</td>
      <td>${(parseFloat(sig.confidence) * 100).toFixed(0)}%</td>
      <td>${sig.confidence_meets_threshold ? '✅' : '—'}</td>
      <td>${sig.triggered_by}</td>
      <td class="${sig.selected_right ?? ''}">${sig.selected_right?.toUpperCase() ?? '—'}</td>
      <td><code>${sig.selected_symbol ?? '—'}</code></td>
      <td>${sig.entry_premium ? '$' + fmt(sig.entry_premium) : '—'}</td>
      <td>${sig.stop_premium ? '$' + fmt(sig.stop_premium) : '—'}</td>
      <td>${sig.tp_premium ? '$' + fmt(sig.tp_premium) : '—'}</td>
      <td>${sig.risk_reward ? fmt(sig.risk_reward) : '—'}</td>
      <td>${sig.spread_pct ? fmt(sig.spread_pct, 1) + '%' : '—'}</td>
      <td>${sig.option_liquidity_ok ? '✅' : '—'}</td>
    </tr>
  `);
  setRows('tbl-signals', rows);
  document.getElementById('val-signals').textContent = data.total_today ?? 0;
  renderPagination('signals', loadSignals);
}
loaderMap['loadSignals'] = loadSignals;

async function loadDecisions() {
  const s = paging.decisions;
  const data = await fetch(`${API}/api/decisions?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ decisions: [] }));
  s.total = data.total ?? 0;
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
  renderPagination('decisions', loadDecisions);
}
loaderMap['loadDecisions'] = loadDecisions;

async function loadEvaluations() {
  const s = paging.evaluations;
  const data = await fetch(`${API}/api/evaluations?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ evaluations: [] }));
  s.total = data.total ?? 0;
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
  renderPagination('evaluations', loadEvaluations);

  // Last grade card
  const last = data.evaluations?.[0];
  if (last) {
    const el = document.getElementById('val-grade');
    el.textContent = last.evaluation_grade;
    el.className = `card-value grade-${last.evaluation_grade}`;
  }
}
loaderMap['loadEvaluations'] = loadEvaluations;

async function loadOrders() {
  const s = paging.orders;
  const data = await fetch(`${API}/api/orders?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ orders: [] }));
  s.total = data.total ?? 0;
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
  renderPagination('orders', loadOrders);
}
loaderMap['loadOrders'] = loadOrders;

async function loadScheduler() {
  const s = paging.scheduler;
  const data = await fetch(`${API}/api/scheduler-runs?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ runs: [] }));
  s.total = data.total ?? 0;
  const rows = (data.runs || []).map(r => {
    const tickerRuns = Array.isArray(r.ticker_runs) ? r.ticker_runs : [];
    const tickers = tickerRuns.map(t => t.ticker + ' ' + t.profile).join(', ') || '—';
    const results = tickerRuns.map(t => {
      const cls = t.status === 'ok' ? 'bullish' : 'bearish';
      const dec = t.decision ? ` → ${t.decision}` : '';
      const err = t.error ? ` ⚠ ${t.error.slice(0, 30)}` : '';
      return `<span class="${cls}">${t.ticker}${dec}${err} (${t.duration_ms}ms)</span>`;
    }).join('<br>') || '—';
    const statusCls = r.status === 'COMPLETED' ? 'bullish' : r.status === 'RUNNING' ? 'neutral' : 'bearish';
    const dur = r.total_duration_ms != null ? (r.total_duration_ms / 1000).toFixed(1) + 's' : '—';
    return `
      <tr>
        <td>${fmtTime(r.run_at)}&nbsp;<small style="color:#8b949e">${fmtDate(r.run_at)}</small></td>
        <td>${r.trigger_type}</td>
        <td class="${statusCls}">${r.status}</td>
        <td>${r.skipped_reason ?? '—'}</td>
        <td style="white-space:nowrap">${tickers}</td>
        <td>${results}</td>
        <td>${dur}</td>
      </tr>
    `;
  });
  setRows('tbl-scheduler', rows);
  renderPagination('scheduler', loadScheduler);
}
loaderMap['loadScheduler'] = loadScheduler;

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
      ? `<span class="${((a.fillPrice - a.limitPrice) / a.limitPrice) >= 0 ? 'bullish' : 'bearish'}">${((a.fillPrice - a.limitPrice) / a.limitPrice) >= 0 ? '+' : ''}${(((a.fillPrice - a.limitPrice) / a.limitPrice) * 100).toFixed(1)}%</span>`
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
    case 'scheduler':   loadScheduler();   break;
  }
}

async function refreshAll() {
  loadPositions();
  loadPnl();
  loadSignals();
  loadEvaluations();
  loadAgents();
  loadTab(currentTab);
  document.getElementById('last-updated').textContent =
    `Last updated: ${new Date().toLocaleTimeString()}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
refreshAll();
refreshInterval = setInterval(refreshAll, 30_000);  // 30 second auto-refresh
