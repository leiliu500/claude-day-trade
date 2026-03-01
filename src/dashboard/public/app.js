// Day Trade Dashboard — vanilla JS SPA

const API = '';
let currentTab = 'positions';
let refreshInterval = null;

// ── Pagination state ──────────────────────────────────────────────────────────
const paging = {
  signals:      { page: 1, limit: 50, total: 0 },
  decisions:    { page: 1, limit: 50, total: 0 },
  evaluations:  { page: 1, limit: 50, total: 0 },
  orders:       { page: 1, limit: 50, total: 0 },
  scheduler:    { page: 1, limit: 50, total: 0 },
  approvals:    { page: 1, limit: 50, total: 0 },
  interactions: { page: 1, limit: 50, total: 0 },
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
// ── Close positions (ticker = specific symbol, undefined = all) ───────────────
let _closePending = null; // { ticker, expiresAt }

async function closePositions(ticker) {
  const label = ticker ?? 'ALL';
  const now = Date.now();

  // Two-tap confirmation
  if (!_closePending || _closePending.ticker !== label || now > _closePending.expiresAt) {
    _closePending = { ticker: label, expiresAt: now + 10_000 };
    const msg = ticker
      ? `Click again within 10s to confirm closing ALL ${ticker} positions.`
      : 'Click again within 10s to confirm closing ALL positions.';
    if (!confirm(`⚠️ ${msg}`)) { _closePending = null; return; }
  }

  _closePending = null;

  const btnAll = document.getElementById('btn-closeall-all');
  if (btnAll) { btnAll.disabled = true; btnAll.textContent = 'Closing…'; }

  try {
    const body = ticker ? JSON.stringify({ ticker }) : '{}';
    const res = await fetch(`${API}/api/closeall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const result = await res.json();
    if (result.ok) {
      const parts = [];
      if (result.agentsNotified)   parts.push(`${result.agentsNotified} agent(s) notified`);
      if (result.dbFallbackClosed) parts.push(`${result.dbFallbackClosed} DB position(s) closed`);
      if (result.ordersCancelled)  parts.push(`${result.ordersCancelled} order(s) cancelled`);
      alert(`✅ Close complete (${label})\n${parts.join(', ') || 'Nothing to close.'}`);
    } else {
      alert(`❌ Close failed: ${result.error}`);
    }
  } catch (e) {
    alert(`❌ Error: ${e.message}`);
  } finally {
    if (btnAll) { btnAll.disabled = false; btnAll.textContent = '🔴 Close All'; }
    loadPositions();
  }
}

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
      <td><button class="btn-close-ticker" onclick="closePositions('${p.ticker}')">Close ${p.ticker}</button></td>
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
    const dir      = (a.direction || '').toLowerCase();
    const dirCls   = dir === 'bullish' ? 'bullish' : dir === 'bearish' ? 'bearish' : 'neutral';
    const sideCls  = a.optionRight === 'call' ? 'bullish' : 'bearish';

    // Use the most-recent AI tick's pnl_pct as the live unrealized P&L estimate
    const latestTick = (a.recentTicks || [])[0];
    const pnlPct     = latestTick?.pnl_pct != null ? parseFloat(latestTick.pnl_pct) : null;
    const pnlStr     = pnlPct != null
      ? `<span class="${pnlPct >= 0 ? 'bullish' : 'bearish'}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</span>`
      : (a.fillPrice ? '<span class="neutral">—</span>' : '<span class="neutral">Unfilled</span>');

    const tierBadge = a.convictionTier
      ? `<span class="meta-sep">·</span><span class="tier-${a.convictionTier}">${a.convictionTier.replace('_', ' ')}</span>`
      : '';

    const posIdShort = a.positionId ? a.positionId.slice(-8) : '—';

    // Recent AI tick rows (newest first)
    const ticksHtml = (a.recentTicks || []).length > 0
      ? `<div class="agent-ticks">
          <div class="ticks-label">Recent AI Decisions</div>
          ${a.recentTicks.map(t => {
            const overrideTag = t.overriding_orchestrator
              ? ' <span class="tick-override">OVERRIDE</span>' : '';
            const price    = t.current_price ? ` @ $${parseFloat(t.current_price).toFixed(2)}` : '';
            const pnl      = t.pnl_pct != null
              ? ` · ${parseFloat(t.pnl_pct) >= 0 ? '+' : ''}${parseFloat(t.pnl_pct).toFixed(1)}%` : '';
            const newStopStr = t.new_stop
              ? ` → stop $${parseFloat(t.new_stop).toFixed(2)}` : '';
            const reason   = (t.reasoning || '').slice(0, 90);
            return `
              <div class="agent-tick">
                <div><span class="tick-action tick-${t.action}">${t.action}${overrideTag}</span><span class="tick-meta">${price}${pnl}${newStopStr}</span></div>
                <div class="tick-reason">${reason}</div>
              </div>`;
          }).join('')}
        </div>`
      : '';

    return `
      <div class="agent-card">
        <div class="agent-card-header">
          <div class="agent-title">
            <span class="agent-ticker">${a.ticker}</span>
            <span class="${sideCls}">${a.optionRight?.toUpperCase()}</span>
            <code class="agent-symbol">${a.optionSymbol}</code>
          </div>
          <span class="phase-badge ${phaseCls}">${a.phase.replace(/_/g, ' ')}</span>
        </div>
        <div class="agent-meta">
          <span class="${dirCls}">${a.direction || '—'}</span>
          <span class="meta-sep">·</span>
          <span>${a.profile}</span>
          <span class="meta-sep">·</span>
          <span>${(a.confidence * 100).toFixed(0)}% conf</span>
          <span class="meta-sep">·</span>
          <span>${a.alignment || '—'}</span>
          ${tierBadge}
        </div>
        <div class="agent-stats">
          <div class="agent-stat"><span class="stat-label">Qty</span><span>${a.qty}</span></div>
          <div class="agent-stat"><span class="stat-label">Entry</span><span>$${fmt(a.limitPrice)}</span></div>
          <div class="agent-stat"><span class="stat-label">Fill</span><span>${a.fillPrice ? '$' + fmt(a.fillPrice) : '—'}</span></div>
          <div class="agent-stat"><span class="stat-label">Stop</span><span>${a.currentStop ? '$' + fmt(a.currentStop) : '—'}</span></div>
          <div class="agent-stat"><span class="stat-label">TP</span><span>${a.currentTp ? '$' + fmt(a.currentTp) : '—'}</span></div>
          <div class="agent-stat"><span class="stat-label">P&amp;L</span><span>${pnlStr}</span></div>
        </div>
        <div class="agent-footer">
          <span class="decision-${a.decisionType}">${a.decisionType}</span>
          <span class="meta-sep">·</span>
          <span>${fmtTime(a.openedAt)}</span>
          <span class="meta-sep">·</span>
          <span class="tick-count-badge">${a.tickCount} ticks</span>
          <span class="meta-sep">·</span>
          <span class="pos-id" title="${a.positionId}">…${posIdShort}</span>
        </div>
        <div class="agent-reasoning" title="${a.decisionReasoning || ''}">${(a.decisionReasoning || '—').slice(0, 200)}</div>
        ${ticksHtml}
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

// ── Approval status badge helper ──────────────────────────────────────────────
function approvalStatusBadge(status) {
  const map = {
    PENDING:  '<span class="approval-pending">PENDING</span>',
    APPROVED: '<span class="approval-approved">APPROVED</span>',
    DENIED:   '<span class="approval-denied">DENIED</span>',
    TIMEOUT:  '<span class="approval-timeout">TIMEOUT</span>',
  };
  return map[status] ?? status;
}

// ── Outcome badge helper ───────────────────────────────────────────────────────
function outcomeBadge(outcome) {
  if (!outcome) return '—';
  const cls = outcome === 'ok' || outcome === 'executed' || outcome === 'approved'
    ? 'bullish'
    : outcome === 'error' || outcome === 'denied'
    ? 'bearish'
    : outcome === 'confirm_requested' || outcome === 'running'
    ? 'neutral'
    : '';
  return `<span class="${cls}">${outcome}</span>`;
}

async function loadApprovals() {
  const s = paging.approvals;
  const data = await fetch(`${API}/api/approvals?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ approvals: [] }));
  s.total = data.total ?? 0;

  // Update summary card
  const pendingEl = document.getElementById('val-pending-approvals');
  if (pendingEl) pendingEl.textContent = data.pending ?? 0;

  const rows = (data.approvals || []).map(a => `
    <tr>
      <td>${fmtTime(a.created_at)}&nbsp;<small style="color:#8b949e">${fmtDate(a.created_at)}</small></td>
      <td><b>${a.ticker}</b></td>
      <td>${a.profile}</td>
      <td class="decision-${a.decision_type}">${a.decision_type}</td>
      <td><code>${a.option_symbol ?? '—'}</code></td>
      <td class="${a.option_side ?? ''}">${a.option_side?.toUpperCase() ?? '—'}</td>
      <td>${a.qty ?? '—'}</td>
      <td>${a.limit_price ? '$' + fmt(a.limit_price) : '—'}</td>
      <td>${a.confidence ? (parseFloat(a.confidence) * 100).toFixed(0) + '%' : '—'}</td>
      <td>${approvalStatusBadge(a.status)}</td>
      <td>${a.responded_by_name ?? '—'}</td>
      <td>${a.responded_at ? fmtTime(a.responded_at) : '—'}</td>
      <td>${a.expires_at ? fmtTime(a.expires_at) : '—'}</td>
    </tr>
  `);
  setRows('tbl-approvals', rows);
  renderPagination('approvals', loadApprovals);
}
loaderMap['loadApprovals'] = loadApprovals;

async function loadInteractions() {
  const s = paging.interactions;
  const data = await fetch(`${API}/api/interactions?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ interactions: [] }));
  s.total = data.total ?? 0;
  const rows = (data.interactions || []).map(i => {
    const paramsStr = i.params ? JSON.stringify(i.params) : '—';
    return `
      <tr>
        <td>${fmtTime(i.created_at)}&nbsp;<small style="color:#8b949e">${fmtDate(i.created_at)}</small></td>
        <td><code>${i.command}</code></td>
        <td>${i.user_name ?? i.user_id}</td>
        <td class="reasoning" title="${i.raw_text || ''}">${i.raw_text ?? '—'}</td>
        <td class="reasoning" title="${paramsStr}">${paramsStr}</td>
        <td>${outcomeBadge(i.outcome)}</td>
        <td class="${i.error_message ? 'bearish' : ''}" title="${i.error_message || ''}">${i.error_message ? i.error_message.slice(0, 40) : '—'}</td>
      </tr>
    `;
  });
  setRows('tbl-interactions', rows);
  renderPagination('interactions', loadInteractions);
}
loaderMap['loadInteractions'] = loadInteractions;

// ── Database cleanup ──────────────────────────────────────────────────────────
let _cleanupPending = null; // { scope, expiresAt }

async function cleanupDb(scope) {
  const now = Date.now();
  const label = scope === 'all' ? 'FULL RESET' : 'Signal History Cleanup';

  if (!_cleanupPending || _cleanupPending.scope !== scope || now > _cleanupPending.expiresAt) {
    _cleanupPending = { scope, expiresAt: now + 15_000 };
    const msg = scope === 'all'
      ? '⚠️ FULL RESET: This will truncate ALL trading tables permanently.\n\nClick OK to arm — then click the button again within 15s to execute.'
      : '🗑️ Delete signal/decision history older than today?\n\nClick OK to arm — then click the button again within 15s to execute.';
    if (!confirm(msg)) { _cleanupPending = null; }
    return; // always return; second button click executes
  }

  // Second click within TTL — confirmed
  _cleanupPending = null;

  const btnSignals = document.getElementById('btn-cleanup-signals');
  const btnAll     = document.getElementById('btn-cleanup-all');
  const resultEl   = document.getElementById('db-cleanup-result');
  if (btnSignals) btnSignals.disabled = true;
  if (btnAll)     btnAll.disabled = true;
  if (resultEl)   { resultEl.style.display = 'none'; resultEl.textContent = ''; }

  try {
    const res = await fetch(`${API}/api/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    });
    const data = await res.json();
    if (resultEl) {
      resultEl.style.display = 'block';
      if (data.ok) {
        if (scope === 'all') {
          resultEl.textContent = `✅ ${label}: All tables truncated.`;
          resultEl.className = 'db-cleanup-result db-result-ok';
        } else {
          const detail = data.tablesAffected?.length
            ? `Deleted ${data.rowsDeleted} row(s) from: ${data.tablesAffected.join(', ')}`
            : 'Nothing to clean — no data older than today.';
          resultEl.textContent = `✅ ${label}: ${detail}`;
          resultEl.className = 'db-cleanup-result db-result-ok';
        }
      } else {
        resultEl.textContent = `❌ Cleanup failed: ${data.error}`;
        resultEl.className = 'db-cleanup-result db-result-err';
      }
    }
  } catch (e) {
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.textContent = `❌ Error: ${e.message}`;
      resultEl.className = 'db-cleanup-result db-result-err';
    }
  } finally {
    if (btnSignals) btnSignals.disabled = false;
    if (btnAll)     btnAll.disabled = false;
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
    case 'activity':    loadApprovals(); loadInteractions(); break;
    case 'database':    /* static panel, nothing to load */ break;
  }
}

async function refreshAll() {
  loadPositions();
  loadPnl();
  loadSignals();
  loadEvaluations();
  loadAgents();
  loadApprovals();   // keeps the pending-approvals card updated
  loadTab(currentTab);
  document.getElementById('last-updated').textContent =
    `Last updated: ${new Date().toLocaleTimeString()}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
refreshAll();
refreshInterval = setInterval(refreshAll, 30_000);  // 30 second auto-refresh
