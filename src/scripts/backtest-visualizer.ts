/**
 * backtest-visualizer.ts — Generates an interactive HTML chart from backtest data.
 *
 * Shows:
 *   - Underlying price chart (1-min bars)
 *   - Per-entry option premium path with entry/exit markers
 *   - Entry/exit annotations (direction, delta, P&L, exit reason)
 *   - Stop and TP levels per trade
 *
 * Usage: called from backtest-day.ts when --html flag is passed.
 */

import type { SimResult, PremiumTracePoint } from '../lib/order-agent-sim.js';
import type { SignalDirection } from '../types/signal.js';
import * as fs from 'fs';

export interface VisEntry {
  index: number;
  time: string;       // UTC
  timeET: string;     // ET display
  direction: SignalDirection;
  price: number;      // underlying at entry
  confidence: number;
  entryGrade: string;
  signalMode: string;
  sim: SimResult;
}

export interface VisBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VisData {
  ticker: string;
  date: string;
  bars: VisBar[];
  entries: VisEntry[];
}

export function generateVisualizerHTML(data: VisData): string {
  const barsJSON = JSON.stringify(data.bars);
  const entriesJSON = JSON.stringify(data.entries);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${data.ticker} Backtest — ${data.date}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0d1117; color: #c9d1d9; }
  .header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; font-weight: 600; color: #f0f6fc; }
  .header .meta { font-size: 13px; color: #8b949e; }
  .chart-container { position: relative; padding: 12px 24px; overflow-x: auto; }
  .chart-scroll { min-width: 100%; }
  canvas { display: block; cursor: crosshair; }
  .legend { display: flex; gap: 20px; padding: 8px 24px; font-size: 12px; color: #8b949e; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
  .trades-table { margin: 16px 24px; border: 1px solid #21262d; border-radius: 6px; overflow: hidden; }
  .trades-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .trades-table th { background: #161b22; padding: 8px 12px; text-align: left; color: #8b949e; font-weight: 500; border-bottom: 1px solid #21262d; }
  .trades-table td { padding: 6px 12px; border-bottom: 1px solid #21262d; }
  .trades-table tr:last-child td { border-bottom: none; }
  .trades-table tr:hover { background: #161b22; }
  .win { color: #3fb950; }
  .loss { color: #f85149; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 500; }
  .tag-a { background: #23863620; color: #3fb950; border: 1px solid #23863650; }
  .tag-b { background: #1f6feb20; color: #58a6ff; border: 1px solid #1f6feb50; }
  .tag-c { background: #d2992220; color: #d29922; border: 1px solid #d2992250; }
  .tag-d { background: #db610020; color: #db6100; border: 1px solid #db610050; }
  .tag-f { background: #f8514920; color: #f85149; border: 1px solid #f8514950; }
  .tag-bull { background: #23863620; color: #3fb950; }
  .tag-bear { background: #f8514920; color: #f85149; }
  .summary-row { display: flex; gap: 24px; padding: 12px 24px; font-size: 13px; flex-wrap: wrap; }
  .summary-card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 12px 16px; min-width: 140px; }
  .summary-card .label { color: #8b949e; font-size: 11px; margin-bottom: 4px; }
  .summary-card .value { font-size: 18px; font-weight: 600; }
  .tooltip { position: absolute; display: none; background: #1c2128; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 11px; pointer-events: none; z-index: 10; white-space: nowrap; }
  .section-title { padding: 16px 24px 8px; font-size: 14px; font-weight: 600; color: #f0f6fc; }
  .premium-charts { padding: 0 24px 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 12px; }
  .premium-card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 12px; }
  .premium-card .card-header { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; }
  .premium-card canvas { width: 100%; height: 150px; }
</style>
</head>
<body>

<div class="header">
  <h1>${data.ticker} Backtest — ${data.date}</h1>
  <div class="meta">Option Delta Simulation (0.30–0.50) | Dynamic Delta + Gamma + Theta</div>
</div>

<div id="summary" class="summary-row"></div>

<div class="chart-container">
  <div class="chart-scroll">
    <canvas id="priceChart" height="500"></canvas>
  </div>
  <div id="tooltip" class="tooltip"></div>
</div>

<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#3fb950"></div> Entry (Bullish)</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f85149"></div> Entry (Bearish)</div>
  <div class="legend-item"><div class="legend-dot" style="background:#d2a8ff"></div> Exit (TP)</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f0883e"></div> Exit (Stop/Loss)</div>
  <div class="legend-item"><div class="legend-dot" style="background:#8b949e"></div> Exit (Other)</div>
</div>

<div class="section-title">Option Premium Paths (per trade)</div>
<div id="premiumCharts" class="premium-charts"></div>

<div class="section-title">Trade Details</div>
<div class="trades-table">
  <table id="tradesTable">
    <thead>
      <tr>
        <th>#</th>
        <th>Entry</th>
        <th>Dir</th>
        <th>Mode</th>
        <th>Grade</th>
        <th>Delta</th>
        <th>Premium</th>
        <th>Exit</th>
        <th>Exit Reason</th>
        <th>Hold</th>
        <th>P&L</th>
        <th>Peak</th>
        <th>DD</th>
      </tr>
    </thead>
    <tbody id="tradesBody"></tbody>
  </table>
</div>

<script>
const BARS = ${barsJSON};
const ENTRIES = ${entriesJSON};

// ── Helpers ──
function toET(utc) {
  const d = new Date(utc);
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtPnl(v) { return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function fmtDollar(v) { return '$' + v.toFixed(2); }

// ── Summary Cards ──
(function renderSummary() {
  const div = document.getElementById('summary');
  const wins = ENTRIES.filter(e => e.sim.pnlPct > 0).length;
  const losses = ENTRIES.length - wins;
  const totalPnl = ENTRIES.reduce((s, e) => s + e.sim.pnlPct, 0);
  const avgPnl = ENTRIES.length > 0 ? totalPnl / ENTRIES.length : 0;
  const avgDelta = ENTRIES.length > 0 ? ENTRIES.reduce((s, e) => s + (e.sim.entryDelta || 0.40), 0) / ENTRIES.length : 0;
  const cards = [
    { label: 'Entries', value: ENTRIES.length, cls: '' },
    { label: 'Win / Loss', value: wins + 'W / ' + losses + 'L', cls: wins > losses ? 'win' : 'loss' },
    { label: 'Total P&L', value: fmtPnl(totalPnl), cls: totalPnl >= 0 ? 'win' : 'loss' },
    { label: 'Avg P&L', value: fmtPnl(avgPnl), cls: avgPnl >= 0 ? 'win' : 'loss' },
    { label: 'Avg Entry Delta', value: avgDelta.toFixed(2), cls: '' },
  ];
  div.innerHTML = cards.map(c =>
    '<div class="summary-card"><div class="label">' + c.label + '</div><div class="value ' + c.cls + '">' + c.value + '</div></div>'
  ).join('');
})();

// ── Candlestick Chart ──
(function renderCandlestickChart() {
  const canvas = document.getElementById('priceChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  if (BARS.length === 0) return;

  // Sizing: each candle gets a fixed width so the chart scrolls for many bars
  const candleWidth = 6;
  const candleGap = 2;
  const candleStep = candleWidth + candleGap;
  const H = 500;
  const pad = { top: 30, right: 80, bottom: 50, left: 80 };
  const minChartWidth = BARS.length * candleStep + pad.left + pad.right;
  const W = Math.max(canvas.parentElement.getBoundingClientRect().width, minChartWidth);

  // Set canvas size
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const prices = BARS.map(b => [b.high, b.low]).flat();
  const pMin = Math.min(...prices), pMax = Math.max(...prices);
  const pRange = pMax - pMin || 1;
  const pPad = pRange * 0.08;

  const xScale = (i) => pad.left + i * candleStep + candleWidth / 2;
  const yScale = (p) => pad.top + ch - ((p - (pMin - pPad)) / (pRange + 2 * pPad)) * ch;

  // ── Background ──
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // ── Grid lines ──
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 0.5;
  const priceSteps = 8;
  for (let i = 0; i <= priceSteps; i++) {
    const p = pMin - pPad + (pRange + 2 * pPad) * (i / priceSteps);
    const y = yScale(p);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#8b949e'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText(fmtDollar(p), pad.left - 8, y + 3);
    // Right-side price labels too
    ctx.textAlign = 'left';
    ctx.fillText(fmtDollar(p), W - pad.right + 8, y + 3);
  }

  // ── Time labels (every 15 min) ──
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b949e'; ctx.font = '10px monospace';
  let lastLabel = '';
  BARS.forEach((b, i) => {
    const et = toET(b.time);
    const min = parseInt(et.split(':')[1]);
    if (min % 15 === 0 && et !== lastLabel) {
      lastLabel = et;
      const x = xScale(i);
      // Vertical grid line at time marks
      ctx.strokeStyle = '#21262d30';
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, H - pad.bottom); ctx.stroke();
      ctx.fillStyle = '#8b949e';
      ctx.fillText(et, x, H - pad.bottom + 16);
    }
  });

  // ── Draw candlesticks ──
  const bullColor = '#3fb950';
  const bearColor = '#f85149';
  const bullColorDim = '#3fb95080';
  const bearColorDim = '#f8514980';

  BARS.forEach((b, i) => {
    const x = xScale(i);
    const isBull = b.close >= b.open;
    const color = isBull ? bullColor : bearColor;
    const colorDim = isBull ? bullColorDim : bearColorDim;

    const bodyTop = yScale(Math.max(b.open, b.close));
    const bodyBot = yScale(Math.min(b.open, b.close));
    const bodyH = Math.max(bodyBot - bodyTop, 1); // min 1px body

    // Wick (high-low line)
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yScale(b.high));
    ctx.lineTo(x, yScale(b.low));
    ctx.stroke();

    // Body
    ctx.fillStyle = isBull ? '#0d1117' : color; // hollow bull, filled bear
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyH);
  });

  // ── Find bar index for a UTC time ──
  function findBarIdx(time) {
    const t = new Date(time).getTime();
    let best = 0, bestDiff = Infinity;
    BARS.forEach((b, i) => {
      const diff = Math.abs(new Date(b.time).getTime() - t);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    return best;
  }

  // ── Draw trade entry/exit overlays ──
  ENTRIES.forEach((e, idx) => {
    const entryIdx = findBarIdx(e.time);
    const ex = xScale(entryIdx);
    const ey = yScale(e.price);
    const entryColor = e.direction === 'bullish' ? '#3fb950' : '#f85149';
    const isWin = e.sim && e.sim.pnlPct >= 0;

    // Find exit bar
    let exitBarIdx = entryIdx + (e.sim ? e.sim.holdMinutes : 0);
    if (e.sim && e.sim.premiumTrace && e.sim.premiumTrace.length > 0) {
      const exitPt = e.sim.premiumTrace.find(p => p.isExit);
      if (exitPt) exitBarIdx = findBarIdx(exitPt.time);
    }
    exitBarIdx = Math.min(exitBarIdx, BARS.length - 1);
    const exx = xScale(exitBarIdx);
    const exitPrice = e.sim ? e.sim.exitPrice : e.price;
    const exy = yScale(exitPrice);

    // Shaded region between entry and exit
    const regionLeft = Math.min(ex, exx) - candleStep / 2;
    const regionRight = Math.max(ex, exx) + candleStep / 2;
    ctx.fillStyle = isWin ? 'rgba(63,185,80,0.06)' : 'rgba(248,81,73,0.06)';
    ctx.fillRect(regionLeft, pad.top, regionRight - regionLeft, ch);

    // Horizontal entry price line across trade duration
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = entryColor + '60';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(exx, ey); ctx.stroke();
    ctx.setLineDash([]);

    // Dashed line from entry to exit
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = isWin ? '#3fb95090' : '#f8514990';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(exx, exy); ctx.stroke();
    ctx.setLineDash([]);

    // Entry marker — triangle below (bull) or above (bear) the candle
    const entryBar = BARS[entryIdx];
    const markerOffset = 14;
    let my;
    ctx.beginPath();
    if (e.direction === 'bullish') {
      my = yScale(entryBar.low) + markerOffset;
      ctx.moveTo(ex, my - 10); ctx.lineTo(ex - 7, my); ctx.lineTo(ex + 7, my);
    } else {
      my = yScale(entryBar.high) - markerOffset;
      ctx.moveTo(ex, my + 10); ctx.lineTo(ex - 7, my); ctx.lineTo(ex + 7, my);
    }
    ctx.closePath();
    ctx.fillStyle = entryColor;
    ctx.fill();
    ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5; ctx.stroke();

    // Entry label
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    const labelY = e.direction === 'bullish' ? my + 12 : my - 8;
    ctx.fillText('#' + (idx + 1), ex, labelY);

    // Exit marker — circle
    if (e.sim) {
      const exitColor = e.sim.exitReason === 'TP' ? '#d2a8ff'
        : ['STOP', 'BAD_ENTRY', 'PRE_EMPTIVE', 'RAPID_DECLINE'].includes(e.sim.exitReason) ? '#f0883e'
        : '#8b949e';
      ctx.beginPath(); ctx.arc(exx, exy, 5, 0, Math.PI * 2); ctx.closePath();
      ctx.fillStyle = exitColor; ctx.fill();
      ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5; ctx.stroke();

      // P&L + exit reason label
      ctx.fillStyle = isWin ? '#3fb950' : '#f85149';
      ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
      ctx.fillText(fmtPnl(e.sim.pnlPct), exx + 8, exy - 4);
      ctx.fillStyle = '#8b949e'; ctx.font = '9px monospace';
      ctx.fillText(e.sim.exitReason + ' ' + e.sim.holdMinutes + 'm', exx + 8, exy + 8);
    }
  });

  // ── Crosshair + tooltip on hover ──
  const tooltip = document.getElementById('tooltip');
  let crosshairIdx = -1;

  canvas.addEventListener('mousemove', (evt) => {
    const r = canvas.getBoundingClientRect();
    const mx = (evt.clientX - r.left) * (W / r.width); // account for scroll scaling
    // Find nearest bar
    let nearest = -1, nearestDist = Infinity;
    for (let i = 0; i < BARS.length; i++) {
      const bx = xScale(i);
      const dist = Math.abs(mx - bx);
      if (dist < nearestDist) { nearestDist = dist; nearest = i; }
    }
    if (nearest < 0 || nearest >= BARS.length || nearestDist > candleStep * 2) {
      tooltip.style.display = 'none';
      return;
    }
    const bar = BARS[nearest];
    const bx = xScale(nearest);
    const isBull = bar.close >= bar.open;

    // Show tooltip
    tooltip.style.display = 'block';
    const tooltipX = evt.clientX - canvas.parentElement.parentElement.getBoundingClientRect().left + 16;
    const tooltipY = evt.clientY - canvas.parentElement.parentElement.getBoundingClientRect().top - 10;
    tooltip.style.left = tooltipX + 'px';
    tooltip.style.top = tooltipY + 'px';

    const chgPct = bar.open !== 0 ? ((bar.close - bar.open) / bar.open * 100) : 0;
    const chgColor = isBull ? '#3fb950' : '#f85149';
    tooltip.innerHTML = '<b>' + toET(bar.time) + ' ET</b><br>'
      + '<span style="color:#8b949e">O:</span> ' + fmtDollar(bar.open)
      + ' <span style="color:#8b949e">H:</span> ' + fmtDollar(bar.high) + '<br>'
      + '<span style="color:#8b949e">L:</span> ' + fmtDollar(bar.low)
      + ' <span style="color:#8b949e">C:</span> <span style="color:' + chgColor + '">' + fmtDollar(bar.close)
      + ' (' + (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%)</span>';
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
})();

// ── Premium Path Charts (per trade) ──
(function renderPremiumCharts() {
  const container = document.getElementById('premiumCharts');
  ENTRIES.forEach((e, idx) => {
    const trace = e.sim.premiumTrace;
    if (!trace || trace.length < 2) return;

    const card = document.createElement('div');
    card.className = 'premium-card';
    const pnlCls = e.sim.pnlPct >= 0 ? 'win' : 'loss';
    const gradeTag = 'tag-' + e.entryGrade.toLowerCase();
    card.innerHTML = '<div class="card-header">'
      + '<span><b>#' + (idx + 1) + '</b> ' + e.timeET + ' ET '
      + '<span class="tag ' + gradeTag + '">' + e.entryGrade + '</span> '
      + '<span class="tag tag-' + (e.direction === 'bullish' ? 'bull' : 'bear') + '">' + e.direction.toUpperCase() + '</span></span>'
      + '<span class="' + pnlCls + '">' + fmtPnl(e.sim.pnlPct) + ' (' + e.sim.exitReason + ' @ ' + e.sim.holdMinutes + 'm)</span>'
      + '</div>'
      + '<canvas id="prem' + idx + '" height="150"></canvas>'
      + '<div style="font-size:10px;color:#8b949e;margin-top:4px">'
      + 'Entry: ' + fmtDollar(e.sim.entryPremium || 0) + ' | '
      + 'Exit: ' + fmtDollar(e.sim.exitPremium || 0) + ' | '
      + 'Delta: ' + (e.sim.entryDelta || 0).toFixed(2) + ' -> ' + (trace[trace.length-1].delta).toFixed(2) + ' | '
      + 'TP: ' + fmtDollar(e.sim.tpPremium || 0) + ' | '
      + 'Stop: ' + fmtDollar(e.sim.stopPremium || 0)
      + '</div>';
    container.appendChild(card);

    // Draw premium chart
    requestAnimationFrame(() => {
      const canvas = document.getElementById('prem' + idx);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = 150 * dpr;
      ctx.scale(dpr, dpr);
      const W = rect.width, H = 150;
      const pad = { top: 12, right: 50, bottom: 24, left: 50 };
      const cw = W - pad.left - pad.right;
      const ch = H - pad.top - pad.bottom;

      const premiums = trace.map(t => t.premium);
      const stops = trace.map(t => t.stop);
      const allVals = [...premiums, ...stops, e.sim.tpPremium || 0].filter(v => v > 0);
      const vMin = Math.min(...allVals) * 0.97;
      const vMax = Math.max(...allVals) * 1.03;
      const vRange = vMax - vMin || 1;

      const xS = (i) => pad.left + (i / Math.max(trace.length - 1, 1)) * cw;
      const yS = (v) => pad.top + ch - ((v - vMin) / vRange) * ch;

      // Grid
      ctx.strokeStyle = '#21262d'; ctx.lineWidth = 0.5;
      for (let i = 0; i <= 4; i++) {
        const v = vMin + vRange * (i / 4);
        const y = yS(v);
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
        ctx.fillStyle = '#8b949e'; ctx.font = '9px monospace'; ctx.textAlign = 'right';
        ctx.fillText(fmtDollar(v), pad.left - 4, y + 3);
      }

      // TP line
      if (e.sim.tpPremium) {
        const tpY = yS(e.sim.tpPremium);
        ctx.setLineDash([4, 4]); ctx.strokeStyle = '#d2a8ff60'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.left, tpY); ctx.lineTo(W - pad.right, tpY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#d2a8ff'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
        ctx.fillText('TP ' + fmtDollar(e.sim.tpPremium), W - pad.right + 4, tpY + 3);
      }

      // Entry premium line
      const entryY = yS(e.sim.entryPremium || premiums[0]);
      ctx.setLineDash([2, 4]); ctx.strokeStyle = '#8b949e40'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, entryY); ctx.lineTo(W - pad.right, entryY); ctx.stroke();
      ctx.setLineDash([]);

      // Stop line (dynamic)
      ctx.beginPath();
      ctx.strokeStyle = '#f8514960'; ctx.lineWidth = 1;
      trace.forEach((t, i) => {
        const x = xS(i), y = yS(t.stop);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Premium line
      ctx.beginPath();
      ctx.strokeStyle = e.sim.pnlPct >= 0 ? '#3fb950' : '#f85149';
      ctx.lineWidth = 1.5;
      trace.forEach((t, i) => {
        const x = xS(i), y = yS(t.premium);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Fill under premium
      ctx.lineTo(xS(trace.length - 1), yS(vMin));
      ctx.lineTo(xS(0), yS(vMin));
      ctx.closePath();
      const fillColor = e.sim.pnlPct >= 0 ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)';
      ctx.fillStyle = fillColor;
      ctx.fill();

      // Entry dot
      ctx.beginPath(); ctx.arc(xS(0), yS(premiums[0]), 5, 0, Math.PI * 2);
      ctx.fillStyle = e.direction === 'bullish' ? '#3fb950' : '#f85149'; ctx.fill();
      ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5; ctx.stroke();

      // Exit dot
      const exitIdx = trace.findIndex(t => t.isExit);
      if (exitIdx >= 0) {
        const exitColor = e.sim.exitReason === 'TP' ? '#d2a8ff' : '#f0883e';
        ctx.beginPath(); ctx.arc(xS(exitIdx), yS(trace[exitIdx].premium), 5, 0, Math.PI * 2);
        ctx.fillStyle = exitColor; ctx.fill();
        ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5; ctx.stroke();
      }

      // Time labels
      const nLabels = Math.min(6, trace.length);
      ctx.fillStyle = '#8b949e'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      for (let i = 0; i < nLabels; i++) {
        const ti = Math.floor((i / (nLabels - 1)) * (trace.length - 1));
        ctx.fillText(trace[ti].minute + 'm', xS(ti), H - 4);
      }

      // Delta annotation on premium line (every ~25% of trace)
      ctx.fillStyle = '#8b949e80'; ctx.font = '8px monospace'; ctx.textAlign = 'left';
      [0, Math.floor(trace.length * 0.5), trace.length - 1].forEach(ti => {
        if (ti < trace.length) {
          ctx.fillText('d=' + trace[ti].delta.toFixed(2), xS(ti) + 4, yS(trace[ti].premium) - 6);
        }
      });
    });
  });
})();

// ── Trades Table ──
(function renderTradesTable() {
  const tbody = document.getElementById('tradesBody');
  ENTRIES.forEach((e, idx) => {
    const pnlCls = e.sim.pnlPct >= 0 ? 'win' : 'loss';
    const gradeTag = 'tag-' + e.entryGrade.toLowerCase();
    const dirTag = e.direction === 'bullish' ? 'tag-bull' : 'tag-bear';
    const row = document.createElement('tr');
    row.innerHTML = '<td>' + (idx + 1) + '</td>'
      + '<td>' + e.timeET + ' ET</td>'
      + '<td><span class="tag ' + dirTag + '">' + (e.direction === 'bullish' ? 'BULL' : 'BEAR') + '</span></td>'
      + '<td>' + e.signalMode + '</td>'
      + '<td><span class="tag ' + gradeTag + '">' + e.entryGrade + '</span></td>'
      + '<td>' + (e.sim.entryDelta || 0.40).toFixed(2) + '</td>'
      + '<td>' + fmtDollar(e.sim.entryPremium || 0) + ' &rarr; ' + fmtDollar(e.sim.exitPremium || 0) + '</td>'
      + '<td>' + fmtDollar(e.sim.exitPrice) + '</td>'
      + '<td>' + e.sim.exitReason + '</td>'
      + '<td>' + e.sim.holdMinutes + 'm</td>'
      + '<td class="' + pnlCls + '">' + fmtPnl(e.sim.pnlPct) + '</td>'
      + '<td class="win">+' + e.sim.peakPnlPct.toFixed(1) + '%</td>'
      + '<td class="loss">-' + e.sim.maxDrawdownPct.toFixed(1) + '%</td>';
    tbody.appendChild(row);
  });
})();
</script>
</body>
</html>`;
}

export function writeVisualizerHTML(data: VisData, outputPath: string): void {
  const html = generateVisualizerHTML(data);
  fs.writeFileSync(outputPath, html, 'utf-8');
}
