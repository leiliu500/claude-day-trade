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
  analysis:     { page: 1, limit: 30, total: 0 },
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
  const [data, histData] = await Promise.all([
    fetch(`${API}/api/positions`).then(r => r.json()).catch(() => ({ positions: [] })),
    fetch(`${API}/api/positions/history`).then(r => r.json()).catch(() => ({ positions: [] })),
  ]);

  // Active positions
  const active = data.positions || [];
  const activeRows = active.map(p => `
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
  setRows('tbl-positions', activeRows);
  document.getElementById('val-positions').textContent = active.length;
  const activeCount = document.getElementById('positions-active-count');
  if (activeCount) activeCount.textContent = active.length > 0 ? `(${active.length})` : '';

  // Closed positions history
  const hist = histData.positions || [];
  const histCount = document.getElementById('positions-history-count');
  if (histCount) histCount.textContent = hist.length > 0 ? `(${hist.length})` : '';

  const histRows = hist.map(p => {
    const pnl = p.realized_pnl != null ? parseFloat(p.realized_pnl) : null;
    const pnlStr = pnl != null
      ? `<span class="${pnl >= 0 ? 'bullish' : 'bearish'}">${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}</span>`
      : '—';
    const pnlPct = p.pnl_pct != null ? parseFloat(p.pnl_pct) : null;
    const pnlPctStr = pnlPct != null
      ? `<span class="${pnlPct >= 0 ? 'bullish' : 'bearish'}">${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%</span>`
      : '—';
    const statusCls = p.status === 'CLOSED' ? 'status-CLOSED' : 'status-PARTIALLY_CLOSED';
    const gradeCls  = p.evaluation_grade ? `grade-${p.evaluation_grade}` : '';
    return `
      <tr>
        <td><code>${p.option_symbol}</code></td>
        <td class="${p.option_right}">${p.option_right?.toUpperCase()}</td>
        <td>${p.strike ? '$' + fmt(p.strike, 0) : '—'}</td>
        <td>${p.expiration ? fmtDate(p.expiration) : '—'}</td>
        <td><span class="status-badge ${statusCls}">${p.status.replace('_', ' ')}</span></td>
        <td>${p.qty}</td>
        <td>$${fmt(p.entry_price)}</td>
        <td>${p.exit_price ? '$' + fmt(p.exit_price) : '—'}</td>
        <td>${pnlStr}</td>
        <td>${pnlPctStr}</td>
        <td>${p.hold_duration_min != null ? p.hold_duration_min + 'm' : '—'}</td>
        <td class="${p.direction ?? ''}">${p.direction ?? '—'}</td>
        <td class="decision-${p.decision_type}">${p.decision_type ?? '—'}</td>
        <td class="${gradeCls}">${p.evaluation_grade ?? '—'}</td>
        <td>${fmtTime(p.opened_at)}</td>
        <td>${p.closed_at ? fmtTime(p.closed_at) : '—'}</td>
        <td class="reasoning" title="${p.close_reason || ''}">${p.close_reason || '—'}</td>
      </tr>
    `;
  });
  setRows('tbl-positions-history', histRows);
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
      <td class="${o.error_message ? 'bearish' : ''}" style="word-break:break-word;max-width:200px">${o.error_message ? '⚠ ' + o.error_message : '—'}</td>
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

// ── Agent card renderers ───────────────────────────────────────────────────────

function renderTickRows(ticks, limit = 0) {
  if (!ticks || ticks.length === 0) return '';
  const displayed = limit > 0 ? ticks.slice(0, limit) : ticks;
  return `<div class="agent-ticks">
    <div class="ticks-label">AI Monitoring Ticks${limit > 0 && ticks.length > limit ? ` (showing last ${limit} of ${ticks.length})` : ` (${ticks.length})`}</div>
    ${displayed.map(t => {
      const overrideTag = t.overriding_orchestrator ? ' <span class="tick-override">OVERRIDE</span>' : '';
      const price    = t.current_price ? ` @ $${parseFloat(t.current_price).toFixed(2)}` : '';
      const pnl      = t.pnl_pct != null ? ` · ${parseFloat(t.pnl_pct) >= 0 ? '+' : ''}${parseFloat(t.pnl_pct).toFixed(1)}%` : '';
      const newStopStr = t.new_stop ? ` → stop $${parseFloat(t.new_stop).toFixed(2)}` : '';
      const label    = t.tick_count != null ? `#${t.tick_count} ` : '';
      const reason   = (t.reasoning || '').slice(0, 90);
      return `<div class="agent-tick">
        <div><span class="tick-action tick-${t.action}">${label}${t.action}${overrideTag}</span><span class="tick-meta">${price}${pnl}${newStopStr}</span></div>
        ${reason ? `<div class="tick-reason">${reason}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderLiveAgentCard(a) {
  const phaseCls = `phase-${a.phase}`;
  const dir      = (a.direction || '').toLowerCase();
  const dirCls   = dir === 'bullish' ? 'bullish' : dir === 'bearish' ? 'bearish' : 'neutral';
  const sideCls  = a.optionRight === 'call' ? 'bullish' : 'bearish';

  const latestTick = (a.recentTicks || [])[0];
  const pnlPct     = latestTick?.pnl_pct != null ? parseFloat(latestTick.pnl_pct) : null;
  const pnlStr     = pnlPct != null
    ? `<span class="${pnlPct >= 0 ? 'bullish' : 'bearish'}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</span>`
    : (a.fillPrice ? '<span class="neutral">—</span>' : '<span class="neutral">Unfilled</span>');

  const tierBadge = a.convictionTier
    ? `<span class="meta-sep">·</span><span class="tier-${a.convictionTier}">${a.convictionTier.replace('_', ' ')}</span>`
    : '';

  const posIdShort = a.positionId ? a.positionId.slice(-8) : '—';

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
      <div class="stats-section-label">Suggested (OptionAgent)</div>
      <div class="agent-stats">
        <div class="agent-stat"><span class="stat-label">Entry</span><span>${a.suggestedEntry != null ? '$' + fmt(a.suggestedEntry) : '—'}</span></div>
        <div class="agent-stat"><span class="stat-label">Stop</span><span>${a.suggestedStop != null ? '$' + fmt(a.suggestedStop) : '—'}</span></div>
        <div class="agent-stat"><span class="stat-label">TP</span><span>${a.suggestedTp != null ? '$' + fmt(a.suggestedTp) : '—'}</span></div>
        <div class="agent-stat"><span class="stat-label">RR</span><span>${a.suggestedRR != null ? a.suggestedRR.toFixed(2) + ':1' : '—'}</span></div>
      </div>
      <div class="stats-section-label">Order Agent Decision</div>
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
      ${renderTickRows(a.recentTicks, 3)}
    </div>
  `;
}

function renderHistoryCard(p) {
  const sideCls = p.option_right === 'call' ? 'bullish' : 'bearish';
  const dir     = (p.direction || '').toLowerCase();
  const dirCls  = dir === 'bullish' ? 'bullish' : dir === 'bearish' ? 'bearish' : 'neutral';
  const posIdShort = p.id ? p.id.slice(-8) : '—';

  const gradeBadge = p.evaluation_grade
    ? `<span class="grade-${p.evaluation_grade} agent-grade-badge">${p.evaluation_grade}</span>`
    : '';

  const pnl    = p.realized_pnl != null ? parseFloat(p.realized_pnl) : null;
  const pnlStr = pnl != null
    ? `<span class="${pnl >= 0 ? 'bullish' : 'bearish'}">${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}</span>`
    : '—';

  const tierBadge = p.conviction_tier
    ? `<span class="meta-sep">·</span><span class="tier-${p.conviction_tier}">${p.conviction_tier.replace('_', ' ')}</span>`
    : '';

  const conf = p.confidence ? (parseFloat(p.confidence) * 100).toFixed(0) + '%' : '—';

  const evalHtml = p.evaluation_grade ? `
    <div class="stats-section-label">Evaluation</div>
    <div class="agent-stats">
      <div class="agent-stat"><span class="stat-label">Grade</span><span class="grade-${p.evaluation_grade}">${p.evaluation_grade}</span></div>
      <div class="agent-stat"><span class="stat-label">Score</span><span>${p.evaluation_score ?? '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">Outcome</span><span class="${p.outcome === 'WIN' ? 'bullish' : p.outcome === 'LOSS' ? 'bearish' : ''}">${p.outcome ?? '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">Signal Q</span><span>${p.signal_quality ?? '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">Timing Q</span><span>${p.timing_quality ?? '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">Risk Q</span><span>${p.risk_management_quality ?? '—'}</span></div>
    </div>
    ${p.lessons_learned ? `<div class="agent-reasoning" title="${p.lessons_learned}">${p.lessons_learned.slice(0, 200)}</div>` : ''}
  ` : '';

  return `
    <div class="agent-card agent-card-history ${p.status === 'CLOSED' ? 'agent-card-closed' : ''}">
      <div class="agent-card-header">
        <div class="agent-title">
          <span class="agent-ticker">${p.ticker}</span>
          <span class="${sideCls}">${p.option_right?.toUpperCase()}</span>
          <code class="agent-symbol">${p.option_symbol}</code>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${gradeBadge}
          <span class="status-badge status-${p.status}">${p.status.replace('_', ' ')}</span>
        </div>
      </div>
      <div class="agent-meta">
        <span class="${dirCls}">${p.direction || '—'}</span>
        <span class="meta-sep">·</span>
        <span>${p.profile || '—'}</span>
        <span class="meta-sep">·</span>
        <span>${conf} conf</span>
        ${tierBadge}
      </div>
      <div class="stats-section-label">Position</div>
      <div class="agent-stats">
        <div class="agent-stat"><span class="stat-label">Qty</span><span>${p.qty}</span></div>
        <div class="agent-stat"><span class="stat-label">Entry</span><span>${p.entry_price ? '$' + fmt(p.entry_price) : '—'}</span></div>
        <div class="agent-stat"><span class="stat-label">Exit</span><span>${p.exit_price ? '$' + fmt(p.exit_price) : '—'}</span></div>
        <div class="agent-stat"><span class="stat-label">P&amp;L</span><span>${pnlStr}</span></div>
        <div class="agent-stat"><span class="stat-label">Duration</span><span>${p.hold_duration_min != null ? p.hold_duration_min + 'm' : '—'}</span></div>
        <div class="agent-stat"><span class="stat-label">Stop</span><span>${p.current_stop ? '$' + fmt(p.current_stop) : '—'}</span></div>
      </div>
      ${p.close_reason ? `<div class="agent-close-reason">Close reason: ${p.close_reason}</div>` : ''}
      ${evalHtml}
      <div class="agent-footer">
        <span class="decision-${p.decision_type}">${p.decision_type ?? '—'}</span>
        <span class="meta-sep">·</span>
        <span>${fmtTime(p.opened_at)}</span>
        ${p.closed_at ? `<span class="meta-sep">→</span><span>${fmtTime(p.closed_at)}</span>` : ''}
        <span class="meta-sep">·</span>
        <span class="pos-id" title="${p.id}">…${posIdShort}</span>
      </div>
      ${p.entry_reasoning ? `<div class="agent-reasoning" title="${p.entry_reasoning}">${p.entry_reasoning.slice(0, 200)}</div>` : ''}
      ${renderTickRows(p.ticks)}
    </div>
  `;
}

async function loadAgents() {
  const [data, histData] = await Promise.all([
    fetch(`${API}/api/agents`).then(r => r.json()).catch(() => ({ agents: [] })),
    fetch(`${API}/api/agents/history`).then(r => r.json()).catch(() => ({ positions: [] })),
  ]);

  const agents = data.agents || [];
  document.getElementById('val-agents').textContent = agents.length;

  // Live agents
  const container = document.getElementById('agent-cards');
  if (container) {
    container.innerHTML = agents.length === 0
      ? `<div class="agent-empty">No live agents — no open positions.</div>`
      : agents.map(a => renderLiveAgentCard(a)).join('');
  }

  // History — exclude positions currently tracked by live registry to avoid duplicates
  const liveIds = new Set(agents.map(a => a.positionId));
  const histPositions = (histData.positions || []).filter(p => !liveIds.has(p.id));

  const histCount = document.getElementById('agent-history-count');
  if (histCount) histCount.textContent = histPositions.length > 0 ? `(${histPositions.length})` : '';

  const histContainer = document.getElementById('agent-history-cards');
  if (histContainer) {
    histContainer.innerHTML = histPositions.length === 0
      ? `<div class="agent-empty">No closed agents today.</div>`
      : histPositions.map(p => renderHistoryCard(p)).join('');
  }
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
        <td class="${i.error_message ? 'bearish' : ''}" style="word-break:break-word;max-width:200px">${i.error_message ? i.error_message : '—'}</td>
      </tr>
    `;
  });
  setRows('tbl-interactions', rows);
  renderPagination('interactions', loadInteractions);
}
loaderMap['loadInteractions'] = loadInteractions;

// ── Purge bar cache ───────────────────────────────────────────────────────────
async function purgeCache() {
  const btn = document.getElementById('btn-purge-cache');
  const resultEl = document.getElementById('db-cleanup-result');
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.style.display = 'none'; resultEl.textContent = ''; }

  try {
    const res = await fetch(`${API}/api/purge-cache`, { method: 'POST' });
    const data = await res.json();
    if (resultEl) {
      resultEl.style.display = 'block';
      if (data.ok) {
        const detail = data.tickers?.length
          ? `Cleared ${data.barsRemoved} bar(s) across ${data.tickers.join(', ')}.`
          : 'Cache was already empty.';
        resultEl.textContent = `✅ Cache purged: ${detail}`;
        resultEl.className = 'db-cleanup-result db-result-ok';
      } else {
        resultEl.textContent = `❌ Purge failed: ${data.error}`;
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
    if (btn) btn.disabled = false;
  }
}

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

// ── Analysis Agent card renderer ──────────────────────────────────────────────

function renderConfidenceBar(label, value, maxVal, colorClass) {
  const pct = maxVal > 0 ? Math.min((value / maxVal) * 100, 100) : 0;
  const sign = value >= 0 ? '+' : '';
  return `
    <div class="conf-row">
      <span class="conf-label">${label}</span>
      <div class="conf-bar-wrap">
        <div class="conf-bar ${value < 0 ? 'conf-bar-neg' : colorClass}" style="width:${Math.abs(pct)}%;${value < 0 ? 'margin-left:' + pct + '%;' : ''}"></div>
      </div>
      <span class="conf-value">${sign}${(value * 100).toFixed(1)}%</span>
    </div>
  `;
}

function renderAnalysisCard(sig) {
  const analysis = sig.analysis_payload || {};
  const signal   = sig.signal_payload   || {};
  const cb       = analysis.confidenceBreakdown || {};
  const tfs      = signal.timeframes || [];

  const dirCls  = sig.direction === 'bullish' ? 'bullish' : sig.direction === 'bearish' ? 'bearish' : 'neutral';
  const sideCls = sig.selected_right === 'call' ? 'bullish' : sig.selected_right === 'put' ? 'bearish' : '';
  const thresh  = sig.confidence_meets_threshold;
  const confPct = sig.confidence ? (parseFloat(sig.confidence) * 100).toFixed(0) : '—';

  // Confidence breakdown section
  const cbHtml = cb.total != null ? `
    <div class="stats-section-label">Confidence Breakdown</div>
    <div class="conf-breakdown">
      ${renderConfidenceBar('Base',        cb.base         ?? 0, 0.50, 'conf-bar-base')}
      ${renderConfidenceBar('DI Spread',   cb.diSpreadBonus ?? 0, 0.25, 'conf-bar-bonus')}
      ${renderConfidenceBar('ADX',         cb.adxBonus      ?? 0, 0.10, 'conf-bar-bonus')}
      ${renderConfidenceBar('Alignment',   cb.alignmentBonus ?? 0, 0.10, 'conf-bar-bonus')}
      ${renderConfidenceBar('TD Seq',       cb.tdAdjustment            ?? 0, 0.05, 'conf-bar-bonus')}
      ${renderConfidenceBar('OBV',         cb.obvBonus                ?? 0, 0.03, 'conf-bar-bonus')}
      ${renderConfidenceBar('Price Pos',   cb.pricePositionAdjustment ?? 0, 0.10, 'conf-bar-bonus')}
      ${renderConfidenceBar('OI/Volume',   cb.oiVolumeBonus           ?? 0, 0.05, 'conf-bar-bonus')}
      <div class="conf-total-row">
        <span>Total</span>
        <span class="${thresh ? 'bullish' : 'bearish'}" style="font-weight:700">${confPct}%${thresh ? ' ✅' : ' (below threshold)'}</span>
      </div>
    </div>
  ` : '';

  // Per-timeframe indicator table
  const tfHtml = tfs.length > 0 ? `
    <div class="stats-section-label">Timeframe Indicators</div>
    <table class="analysis-tf-table">
      <thead>
        <tr><th>TF</th><th>DI+</th><th>DI-</th><th>ADX</th><th>Trend</th><th>TD Setup</th><th>Patterns</th></tr>
      </thead>
      <tbody>
        ${tfs.map(tf => {
          const dmi = tf.dmi || {};
          const td  = tf.td?.setup || {};
          const cp  = tf.allCandlePatterns || {};
          const patterns = [
            cp.hammer?.present          ? 'Hammer' : null,
            cp.shootingStar?.present    ? 'ShootStar' : null,
            cp.bullishEngulfing?.present ? 'BullEngulf' : null,
            cp.bearishEngulfing?.present ? 'BearEngulf' : null,
          ].filter(Boolean).join(', ') || '—';
          const trendCls = dmi.trend === 'bullish' ? 'bullish' : dmi.trend === 'bearish' ? 'bearish' : 'neutral';
          const tdStr = td.count != null
            ? `${td.direction === 'buy' ? '▲' : '▼'} ${td.count}${td.completed ? ' ✓' : ''}`
            : '—';
          return `<tr>
            <td><b>${tf.timeframe}</b></td>
            <td class="bullish">${dmi.plusDI != null ? dmi.plusDI.toFixed(1) : '—'}</td>
            <td class="bearish">${dmi.minusDI != null ? dmi.minusDI.toFixed(1) : '—'}</td>
            <td>${dmi.adx != null ? dmi.adx.toFixed(1) : '—'}</td>
            <td class="${trendCls}">${dmi.trend || '—'}</td>
            <td>${tdStr}</td>
            <td style="font-size:0.75rem">${patterns}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  ` : '';

  // AI Explanation
  const explanation = analysis.aiExplanation || '';
  const keyFactors  = analysis.keyFactors || [];
  const risks       = analysis.risks || [];

  const aiHtml = explanation && explanation !== 'Confidence below threshold — AI explanation skipped.' ? `
    <div class="stats-section-label">AI Explanation</div>
    <div class="analysis-explanation">${explanation}</div>
    ${keyFactors.length ? `
      <div class="analysis-lists">
        <div class="analysis-list-col">
          <div class="analysis-list-title bullish">Key Factors</div>
          <ul class="analysis-list">${keyFactors.map(f => `<li>${f}</li>`).join('')}</ul>
        </div>
        ${risks.length ? `
        <div class="analysis-list-col">
          <div class="analysis-list-title bearish">Risks</div>
          <ul class="analysis-list">${risks.map(r => `<li>${r}</li>`).join('')}</ul>
        </div>` : ''}
      </div>
    ` : ''}
  ` : `<div class="analysis-skipped">AI explanation skipped (confidence below threshold)</div>`;

  // Option info
  const optHtml = sig.selected_symbol ? `
    <div class="stats-section-label">Option Selected</div>
    <div class="agent-stats">
      <div class="agent-stat"><span class="stat-label">Symbol</span><code>${sig.selected_symbol}</code></div>
      <div class="agent-stat"><span class="stat-label">Entry</span><span>${sig.entry_premium ? '$' + fmt(sig.entry_premium) : '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">Stop</span><span>${sig.stop_premium ? '$' + fmt(sig.stop_premium) : '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">TP</span><span>${sig.tp_premium ? '$' + fmt(sig.tp_premium) : '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">R:R</span><span>${sig.risk_reward ? fmt(sig.risk_reward) + ':1' : '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">Spread</span><span>${sig.spread_pct ? fmt(sig.spread_pct, 1) + '%' : '—'}</span></div>
      <div class="agent-stat"><span class="stat-label">Liq?</span><span>${sig.option_liquidity_ok ? '✅' : '—'}</span></div>
    </div>
  ` : '';

  return `
    <div class="agent-card">
      <div class="agent-card-header">
        <div class="agent-title">
          <span class="agent-ticker">${sig.ticker}</span>
          <span class="${dirCls}">${sig.direction?.toUpperCase()}</span>
          <span style="font-size:0.8rem;color:#8b949e">${sig.alignment?.replace(/_/g, ' ')}</span>
          ${sig.selected_right ? `<span class="${sideCls}">${sig.selected_right.toUpperCase()}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="phase-badge" style="background:${thresh ? '#1a3a2a' : '#2a1a1a'};color:${thresh ? '#3fb950' : '#f85149'}">${confPct}%</span>
          <span style="font-size:0.75rem;color:#8b949e">${sig.profile} · ${sig.triggered_by} · ${fmtTime(sig.created_at)}</span>
        </div>
      </div>
      ${cbHtml}
      ${tfHtml}
      ${aiHtml}
      ${optHtml}
    </div>
  `;
}

async function loadAnalysis() {
  const s = paging.analysis;
  const data = await fetch(`${API}/api/analysis?limit=${s.limit}&page=${s.page}`).then(r => r.json()).catch(() => ({ signals: [] }));
  s.total = data.total ?? 0;

  const signals = data.signals || [];
  const countEl = document.getElementById('analysis-count');
  if (countEl) countEl.textContent = signals.length > 0 ? `(${s.total} in last 7d)` : '';

  const container = document.getElementById('analysis-cards');
  if (container) {
    container.innerHTML = signals.length === 0
      ? `<div class="agent-empty">No analysis data yet.</div>`
      : signals.map(sig => renderAnalysisCard(sig)).join('');
  }
  renderPagination('analysis', loadAnalysis);
}
loaderMap['loadAnalysis'] = loadAnalysis;

// ── Main refresh ──────────────────────────────────────────────────────────────
function loadTab(tab) {
  switch (tab) {
    case 'positions':   loadPositions();   break;
    case 'signals':     loadSignals();     break;
    case 'analysis':    loadAnalysis();    break;
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
