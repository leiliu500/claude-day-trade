"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmtUsd = (n) => {
  if (n === null || n === undefined) return "—";
  const sign = Number(n) >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(Number(n)).toFixed(2)}`;
};
const fmtTime = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
};
const cls = (n) => (n === null || n === undefined ? "muted" : Number(n) >= 0 ? "good" : "bad");

let symbols = [];
let currentSymbol = localStorage.getItem("odt.symbol") || "SPY";

/* ---------------- symbols + filter bar ---------------- */
async function loadSymbols() {
  try {
    const r = await fetch("/api/symbols");
    const data = await r.json();
    symbols = data.symbols && data.symbols.length ? data.symbols : [currentSymbol];
  } catch {
    symbols = [currentSymbol];
  }
  const sel = $("#filter-ticker");
  sel.innerHTML = symbols.map((s) => `<option value="${s}">${s}</option>`).join("");
  if (!symbols.includes(currentSymbol)) currentSymbol = symbols[0];
  sel.value = currentSymbol;
  $("#bt-symbol").value = currentSymbol;
}

$("#filter-ticker")?.addEventListener("change", (e) => {
  currentSymbol = e.target.value;
  localStorage.setItem("odt.symbol", currentSymbol);
  $("#bt-symbol").value = currentSymbol;
  refreshCurrentPage();
});

/* ---------------- page switching ---------------- */
$$(".page-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".page-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const p = btn.dataset.page;
    $$(".page").forEach((s) => s.classList.toggle("active", s.id === `page-${p}`));
    refreshCurrentPage();
  });
});

function currentPage() {
  const btn = $(".page-btn.active");
  return btn ? btn.dataset.page : "live";
}

function refreshCurrentPage() {
  const p = currentPage();
  if (p === "live") refreshLive();
  else if (p === "tests") refreshJobs();
  else if (p === "compare") {
    if (!$("#cmp-day").value) $("#cmp-day").value = new Date().toISOString().slice(0, 10);
  }
}

/* ---------------- clock ---------------- */
setInterval(() => {
  $("#now").textContent = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
  }) + " ET";
}, 1000);

/* ---------------- LIVE ---------------- */
async function refreshLive() {
  const symbol = currentSymbol;
  $("#val-symbol").textContent = symbol;
  try {
    const r = await fetch(`/api/live/today?symbol=${encodeURIComponent(symbol)}`);
    const data = await r.json();

    const open = (data.positions || []).filter((p) => !p.closed_ts);
    const closed = (data.positions || []).length - open.length;
    $("#val-positions").textContent = String(open.length);

    const d = data.daily;
    const pnl = d ? Number(d.pnl_realized) : null;
    const pnlEl = $("#val-pnl");
    pnlEl.textContent = pnl != null ? fmtUsd(pnl) : "—";
    pnlEl.className = "card-value " + (pnl == null ? "" : pnl >= 0 ? "green" : "red");

    $("#val-signals").textContent = d ? `${d.signals_accepted}/${d.signals_total}` : "—";
    $("#val-kill").textContent = d && d.kill_switch_reason ? d.kill_switch_reason : "off";
    $("#val-kill").className = "card-value " + (d && d.kill_switch_reason ? "red" : "");

    $("#filter-meta").textContent = data.run
      ? `run ${data.run.id.slice(0, 8)} • ${data.run.strategy}/${data.run.vehicle}`
      : `no live run for ${symbol}`;

    $("#live-run").innerHTML = data.run
      ? `<dl class="kv">
          <dt>run id</dt><dd><code>${data.run.id.slice(0, 8)}…</code></dd>
          <dt>symbol</dt><dd><b>${data.run.symbol}</b></dd>
          <dt>strategy</dt><dd><b>${data.run.strategy}</b></dd>
          <dt>vehicle</dt><dd><b>${data.run.vehicle}</b></dd>
          <dt>started</dt><dd>${fmtTime(data.run.started_at)}</dd>
          <dt>ended</dt><dd>${data.run.ended_at ? fmtTime(data.run.ended_at) : "<span class=warn>running</span>"}</dd>
        </dl>`
      : `<div class="muted">no live run for ${symbol}</div>`;

    $("#live-daily").innerHTML = d
      ? `<dl class="kv">
          <dt>equity</dt><dd>$${Number(d.equity_end).toFixed(2)}</dd>
          <dt>P&L today</dt><dd class="${cls(d.pnl_realized)}">${fmtUsd(d.pnl_realized)}</dd>
          <dt>trades</dt><dd>${d.entries_total} (${d.wins}W/${d.losses}L)</dd>
          <dt>signals</dt><dd>${d.signals_accepted}/${d.signals_total} taken</dd>
          <dt>max DD</dt><dd>$${Number(d.max_drawdown).toFixed(2)}</dd>
          <dt>kill</dt><dd>${d.kill_switch_reason ? `<span class="bad">${d.kill_switch_reason}</span>` : "off"}</dd>
        </dl>`
      : `<div class="muted">no EOD record yet today</div>`;

    $("#live-pos-count").textContent = `(${open.length} open, ${closed} closed)`;
    $("#live-positions").innerHTML = (data.positions || []).length
      ? renderPositionsTable(data.positions, true)
      : `<div class="muted">no positions yet today</div>`;

    $("#live-signals").innerHTML = (data.signals || []).length
      ? renderSignalsTable(data.signals)
      : `<div class="muted">no signals today</div>`;
  } catch (e) {
    $("#live-run").innerHTML = `<span class="bad">error: ${e.message}</span>`;
  }
}

function renderPositionsTable(rows, includeMark) {
  const header = `<tr>
    <th>open</th><th>close</th><th>side</th><th>qty</th>
    <th>symbols</th><th>entry</th><th>exit</th>
    ${includeMark ? "<th>mark</th><th>% P&L</th>" : ""}
    <th>rule</th><th>P&L $</th>
  </tr>`;
  const body = rows
    .map((p) => {
      const mark = p.latest_mark;
      const pct = mark ? Number(mark.pnl_pct) * 100 : null;
      return `<tr>
        <td>${fmtTime(p.opened_ts).split(", ")[1] ?? fmtTime(p.opened_ts)}</td>
        <td>${p.closed_ts ? fmtTime(p.closed_ts).split(", ")[1] : "—"}</td>
        <td>${p.side}</td>
        <td>${p.qty}</td>
        <td><code>${(p.symbols || []).join(" / ")}</code></td>
        <td>$${Number(p.filled_debit).toFixed(2)}</td>
        <td>${p.exit_debit != null ? `$${Number(p.exit_debit).toFixed(2)}` : "—"}</td>
        ${includeMark ? `<td>${mark ? `$${Number(mark.mark_debit).toFixed(2)}` : "—"}</td>
        <td class="${cls(pct)}">${pct != null ? pct.toFixed(1) + "%" : "—"}</td>` : ""}
        <td>${p.exit_rule ?? "<span class=muted>open</span>"}</td>
        <td class="${cls(p.pnl_dollars)}">${p.pnl_dollars != null ? fmtUsd(p.pnl_dollars) : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<table><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

function renderSignalsTable(rows) {
  const header = `<tr><th>time</th><th>side</th><th>price</th><th>accepted</th><th>reason / block</th></tr>`;
  const body = rows
    .map((s) => `<tr>
      <td>${fmtTime(s.ts).split(", ")[1] ?? fmtTime(s.ts)}</td>
      <td>${s.side}</td>
      <td>${s.entry_price ? Number(s.entry_price).toFixed(2) : "—"}</td>
      <td>${s.accepted ? `<span class="good">✓</span>` : `<span class="bad">✗</span>`}</td>
      <td class="muted">${s.block_reason ?? s.reason ?? ""}</td>
    </tr>`)
    .join("");
  return `<table><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

$("#live-refresh")?.addEventListener("click", refreshLive);
setInterval(() => {
  if ($("#page-live").classList.contains("active")) refreshLive();
}, 15_000);

/* ---------------- TESTS ---------------- */
let currentJobEvt = null;

async function refreshJobs() {
  try {
    const r = await fetch("/api/jobs");
    const { jobs } = await r.json();
    $("#jobs-list").innerHTML = jobs.length
      ? `<table>
          <thead><tr><th>started</th><th>name</th><th>status</th><th>exit</th><th></th></tr></thead>
          <tbody>${jobs.map((j) => `<tr>
            <td>${fmtTime(j.startedAt).split(", ")[1] ?? ""}</td>
            <td>${j.name}</td>
            <td><span class="pill ${j.status}">${j.status}</span></td>
            <td>${j.exitCode ?? "—"}</td>
            <td><button data-job="${j.id}" class="view-job">view</button></td>
          </tr>`).join("")}</tbody>
        </table>`
      : `<div class="muted">no jobs yet</div>`;
    $$(".view-job").forEach((b) => b.addEventListener("click", () => streamJob(b.dataset.job)));
  } catch (e) {
    $("#jobs-list").innerHTML = `<span class="bad">error: ${e.message}</span>`;
  }
}

function streamJob(id) {
  if (currentJobEvt) currentJobEvt.close();
  $("#job-output").textContent = "";
  $("#current-job-name").textContent = `— ${id.slice(0, 8)}`;
  currentJobEvt = new EventSource(`/api/jobs/${id}/stream`);
  currentJobEvt.onmessage = (ev) => {
    try {
      const { line } = JSON.parse(ev.data);
      if (line !== undefined) appendOutput(line);
    } catch {}
  };
  currentJobEvt.addEventListener("done", (ev) => {
    try {
      const { status, exitCode } = JSON.parse(ev.data);
      appendOutput(`\n[done ${status} exit=${exitCode}]`);
    } catch {}
    currentJobEvt?.close();
    refreshJobs();
  });
  currentJobEvt.onerror = () => {
    appendOutput("\n[stream disconnected]");
    currentJobEvt?.close();
  };
}

function appendOutput(line) {
  const out = $("#job-output");
  out.textContent += line + "\n";
  out.scrollTop = out.scrollHeight;
}

async function startPresetJob(preset, params) {
  const r = await fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset, params }),
  });
  const j = await r.json();
  if (!r.ok) {
    appendOutput(`[error] ${j.error}`);
    return;
  }
  streamJob(j.id);
  setTimeout(refreshJobs, 200);
}

$$(".job-buttons button").forEach((b) =>
  b.addEventListener("click", () => startPresetJob(b.dataset.preset, {})),
);

$("#backtest-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const preset = e.submitter?.dataset.preset ?? "backtest";
  const form = new FormData(e.currentTarget);
  const params = {};
  for (const [k, v] of form.entries()) params[k] = String(v);
  startPresetJob(preset, params);
});

/* ---------------- COMPARE ---------------- */
$("#cmp-run")?.addEventListener("click", async () => {
  const symbol = currentSymbol;
  const day = $("#cmp-day").value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    alert("day must be YYYY-MM-DD");
    return;
  }
  try {
    const r = await fetch(`/api/compare?symbol=${encodeURIComponent(symbol)}&day=${day}`);
    const { live, backtest } = await r.json();
    $("#cmp-live").innerHTML = renderSide(live);
    $("#cmp-backtest").innerHTML = renderSide(backtest);
    $("#cmp-delta").innerHTML = renderDelta(live.daily, backtest.daily, live.positions, backtest.positions);
  } catch (e) {
    $("#cmp-live").innerHTML = `<span class="bad">error: ${e.message}</span>`;
  }
});

function renderSide(side) {
  const d = side.daily;
  if (!d) return `<div class="muted">no data</div>`;
  const summary = `<dl class="kv">
    <dt>trades</dt><dd>${d.entries_total} (${d.wins}W/${d.losses}L)</dd>
    <dt>signals</dt><dd>${d.signals_accepted}/${d.signals_total} taken</dd>
    <dt>P&L</dt><dd class="${cls(d.pnl_realized)}">${fmtUsd(d.pnl_realized)}</dd>
    <dt>max DD</dt><dd>$${Number(d.max_drawdown).toFixed(2)}</dd>
    <dt>kill</dt><dd>${d.kill_switch_reason ?? "—"}</dd>
  </dl>`;
  const positions = side.positions.length ? renderPositionsTable(side.positions, false) : `<div class="muted">no trades</div>`;
  return summary + positions;
}

function renderDelta(liveDaily, btDaily, livePos, btPos) {
  if (!liveDaily && !btDaily) return `<div class="muted">neither side has data for this day</div>`;
  if (!liveDaily || !btDaily) return `<div class="warn">only one side has data for this day — cannot compute delta</div>`;
  const pnlGap = Number(liveDaily.pnl_realized) - Number(btDaily.pnl_realized);
  const tradeGap = Number(liveDaily.entries_total) - Number(btDaily.entries_total);
  const matched = matchTrades(livePos, btPos);
  const tradeRows = matched.map((m) => `<tr>
    <td>${m.live ? fmtTime(m.live.opened_ts).split(", ")[1] : "—"}</td>
    <td>${m.bt ? fmtTime(m.bt.opened_ts).split(", ")[1] : "—"}</td>
    <td>${m.live ? `$${Number(m.live.filled_debit).toFixed(2)}` : "—"}</td>
    <td>${m.bt ? `$${Number(m.bt.filled_debit).toFixed(2)}` : "—"}</td>
    <td class="${m.entryGap != null ? cls(m.entryGap) : "muted"}">${m.entryGap != null ? `$${m.entryGap.toFixed(2)}` : "—"}</td>
    <td class="${cls(m.live?.pnl_dollars)}">${m.live?.pnl_dollars != null ? fmtUsd(m.live.pnl_dollars) : "—"}</td>
    <td class="${cls(m.bt?.pnl_dollars)}">${m.bt?.pnl_dollars != null ? fmtUsd(m.bt.pnl_dollars) : "—"}</td>
    <td class="${m.pnlGap != null ? cls(m.pnlGap) : "muted"}">${m.pnlGap != null ? fmtUsd(m.pnlGap) : "—"}</td>
  </tr>`).join("");
  return `<dl class="kv">
    <dt>trade count Δ</dt><dd>${tradeGap > 0 ? "+" : ""}${tradeGap}</dd>
    <dt>P&L Δ (live − backtest)</dt><dd class="${cls(pnlGap)}">${fmtUsd(pnlGap)}</dd>
    <dt>matched trades</dt><dd>${matched.filter((m) => m.live && m.bt).length} / ${matched.length}</dd>
  </dl>
  <table>
    <thead><tr>
      <th>live open</th><th>bt open</th>
      <th>live entry</th><th>bt entry</th><th>entry Δ</th>
      <th>live P&L</th><th>bt P&L</th><th>P&L Δ</th>
    </tr></thead>
    <tbody>${tradeRows || `<tr><td colspan=8 class=muted>no matching trades</td></tr>`}</tbody>
  </table>`;
}

function matchTrades(live, bt) {
  const result = [];
  const btUsed = new Set();
  for (const l of live) {
    let best = null;
    let bestDelta = Infinity;
    for (let i = 0; i < bt.length; i++) {
      if (btUsed.has(i)) continue;
      const d = Math.abs(new Date(l.signal_ts).getTime() - new Date(bt[i].signal_ts).getTime());
      if (d < bestDelta) { bestDelta = d; best = i; }
    }
    if (best !== null && bestDelta <= 10 * 60_000) {
      btUsed.add(best);
      const entryGap = Number(l.filled_debit) - Number(bt[best].filled_debit);
      const pnlGap = (l.pnl_dollars != null && bt[best].pnl_dollars != null)
        ? Number(l.pnl_dollars) - Number(bt[best].pnl_dollars)
        : null;
      result.push({ live: l, bt: bt[best], entryGap, pnlGap });
    } else {
      result.push({ live: l, bt: null, entryGap: null, pnlGap: null });
    }
  }
  for (let i = 0; i < bt.length; i++) {
    if (!btUsed.has(i)) result.push({ live: null, bt: bt[i], entryGap: null, pnlGap: null });
  }
  return result;
}

/* ---------------- init ---------------- */
(async () => {
  await loadSymbols();
  refreshLive();
})();
