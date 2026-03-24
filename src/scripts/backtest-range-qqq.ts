#!/usr/bin/env npx tsx
/**
 * backtest-range-spy.ts — Run SPY backtest across a date range and produce a combined report.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-range-spy.ts 2025-10-01 2026-03-31
 */

import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2025-10-01';
const END = process.argv[3] || '2026-03-31';
const TICKER = 'QQQ';

// ── Generate trading days (weekdays) in range ────────────────────────────────
function getTradingDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T12:00:00Z');
  const endD = new Date(end + 'T12:00:00Z');
  while (d <= endD) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      days.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ── Known US market holidays (2025 Q4 + 2026 Q1) ────────────────────────────
const HOLIDAYS = new Set([
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  '2026-01-01', // New Year
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
]);

interface DayResult {
  date: string;
  month: string;
  entries: number;
  wins: number;
  losses: number;
  totalPnl: number;
  details: EntryDetail[];
  skipped: boolean;
  error?: string;
}

interface EntryDetail {
  time: string;
  direction: string;
  mode: string;
  confidence: number;
  price: number;
  pnlPct: number;
  exitReason: string;
  holdMin: number;
  outcome: string;
}

const allDays = getTradingDays(START, END).filter(d => !HOLIDAYS.has(d));
console.log(`\n${'='.repeat(80)}`);
console.log(`  QQQ BACKTEST: ${START} → ${END} (${allDays.length} trading days)`);
console.log(`${'='.repeat(80)}\n`);

const results: DayResult[] = [];
let processed = 0;

for (const date of allDays) {
  processed++;
  const pct = ((processed / allDays.length) * 100).toFixed(0);
  process.stdout.write(`  [${pct}%] ${date} ...`);

  try {
    const output = execSync(
      `npx tsx src/scripts/backtest-day.ts ${date} ${TICKER} 2>&1`,
      { timeout: 120_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Parse entries from output
    const entries: EntryDetail[] = [];
    const entryBlocks = output.split(/Entry #\d+:/);
    for (let i = 1; i < entryBlocks.length; i++) {
      const block = entryBlocks[i]!;
      // Only count confirmed entries (🟢 CONFIRMED)
      if (!block.includes('CONFIRMED')) continue;

      const timeM = block.match(/(\d{2}:\d{2}) ET/);
      const dirM = block.match(/Direction:\s+(BULLISH|BEARISH)/);
      const modeM = block.match(/\[(TREND|RANGE|BREAKOUT)\]/);
      const confM = block.match(/Confidence:\s+([\d.]+)%/);
      const priceM = block.match(/Price:\s+\$([\d.]+)/);
      const pnlM = block.match(/P&L\s+([+-]?[\d.]+)%/);
      const exitM = block.match(/Exit:\s+(\S+)/);
      const holdM = block.match(/after\s+(\d+)m/);
      const outcomeM = block.match(/(GOOD|BAD|MARGINAL)/);

      entries.push({
        time: timeM?.[1] ?? '?',
        direction: dirM?.[1] ?? '?',
        mode: modeM?.[1] ?? '?',
        confidence: parseFloat(confM?.[1] ?? '0'),
        price: parseFloat(priceM?.[1] ?? '0'),
        pnlPct: parseFloat(pnlM?.[1] ?? '0'),
        exitReason: exitM?.[1] ?? '?',
        holdMin: parseInt(holdM?.[1] ?? '0'),
        outcome: outcomeM?.[1] ?? '?',
      });
    }

    const confirmed = entries;
    const wins = confirmed.filter(e => e.pnlPct > 0).length;
    const losses = confirmed.filter(e => e.pnlPct <= 0).length;
    const totalPnl = confirmed.reduce((s, e) => s + e.pnlPct, 0);
    const month = date.slice(0, 7);

    // Check if it was a non-trading day (no bars or backtest error)
    const hasResults = output.includes('ticks processed');
    const skipped = !hasResults;

    results.push({ date, month, entries: confirmed.length, wins, losses, totalPnl, details: confirmed, skipped });

    if (skipped) {
      process.stdout.write(` SKIP (no data)\n`);
    } else if (confirmed.length === 0) {
      process.stdout.write(` no entries\n`);
    } else {
      const pnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(1)}%` : `${totalPnl.toFixed(1)}%`;
      process.stdout.write(` ${wins}W/${losses}L ${pnlStr}\n`);
    }
  } catch (err: any) {
    const msg = err.stderr?.toString().slice(0, 100) || err.message?.slice(0, 100) || 'unknown error';
    results.push({ date, month: date.slice(0, 7), entries: 0, wins: 0, losses: 0, totalPnl: 0, details: [], skipped: true, error: msg });
    process.stdout.write(` ERROR\n`);
  }
}

// ── Combined Report ──────────────────────────────────────────────────────────

const tradingDays = results.filter(r => !r.skipped);
const entryDays = tradingDays.filter(r => r.entries > 0);
const allEntries = results.flatMap(r => r.details);
const allWins = allEntries.filter(e => e.pnlPct > 0);
const allLosses = allEntries.filter(e => e.pnlPct <= 0);
const totalPnl = allEntries.reduce((s, e) => s + e.pnlPct, 0);
const avgPnl = allEntries.length > 0 ? totalPnl / allEntries.length : 0;
const winRate = allEntries.length > 0 ? (allWins.length / allEntries.length * 100) : 0;

console.log(`\n${'='.repeat(80)}`);
console.log(`  COMBINED REPORT: QQQ ${START} → ${END}`);
console.log(`${'='.repeat(80)}\n`);

console.log(`  Trading days:  ${tradingDays.length} (${entryDays.length} with entries, ${tradingDays.length - entryDays.length} no-signal)`);
console.log(`  Total entries: ${allEntries.length}`);
console.log(`  Win/Loss:      ${allWins.length}W / ${allLosses.length}L (${winRate.toFixed(0)}%)`);
console.log(`  Total P&L:     ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`);
console.log(`  Avg P&L/trade: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%`);
console.log(`  Avg win:       ${allWins.length > 0 ? '+' : ''}${allWins.length > 0 ? (allWins.reduce((s, e) => s + e.pnlPct, 0) / allWins.length).toFixed(1) : '0.0'}%`);
console.log(`  Avg loss:      ${allLosses.length > 0 ? (allLosses.reduce((s, e) => s + e.pnlPct, 0) / allLosses.length).toFixed(1) : '0.0'}%`);

// ── Helpers ──
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);
const fmtPnl = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

// ── Monthly breakdown ────────────────────────────────────────────────────────
console.log(`\n  ── Monthly Breakdown ──\n`);
console.log(`  ${pad('Month', 10)} ${rpad('Entries', 8)} ${rpad('W/L', 8)} ${rpad('Win%', 6)} ${rpad('P&L', 8)} ${rpad('Avg', 8)}`);
console.log(`  ${'-'.repeat(50)}`);

const months = [...new Set(results.map(r => r.month))].sort();
for (const month of months) {
  const monthEntries = results.filter(r => r.month === month).flatMap(r => r.details);
  const mWins = monthEntries.filter(e => e.pnlPct > 0).length;
  const mLosses = monthEntries.filter(e => e.pnlPct <= 0).length;
  const mTotal = monthEntries.reduce((s, e) => s + e.pnlPct, 0);
  const mAvg = monthEntries.length > 0 ? mTotal / monthEntries.length : 0;
  const mWinRate = monthEntries.length > 0 ? (mWins / monthEntries.length * 100) : 0;
  console.log(`  ${pad(month, 10)} ${rpad(String(monthEntries.length), 8)} ${rpad(`${mWins}W/${mLosses}L`, 8)} ${rpad(`${mWinRate.toFixed(0)}%`, 6)} ${rpad(fmtPnl(mTotal), 8)} ${rpad(fmtPnl(mAvg), 8)}`);
}

// ── Exit reason breakdown ────────────────────────────────────────────────────
console.log(`\n  ── Exit Reasons ──\n`);
const exitCounts = new Map<string, { count: number; pnl: number }>();
for (const e of allEntries) {
  const cur = exitCounts.get(e.exitReason) ?? { count: 0, pnl: 0 };
  cur.count++;
  cur.pnl += e.pnlPct;
  exitCounts.set(e.exitReason, cur);
}
console.log(`  ${pad('Reason', 18)} ${rpad('Count', 6)} ${rpad('Total P&L', 10)} ${rpad('Avg P&L', 10)}`);
console.log(`  ${'-'.repeat(46)}`);
for (const [reason, data] of [...exitCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const avg = data.pnl / data.count;
  console.log(`  ${pad(reason, 18)} ${rpad(String(data.count), 6)} ${rpad(fmtPnl(data.pnl), 10)} ${rpad(fmtPnl(avg), 10)}`);
}

// ── Mode breakdown ───────────────────────────────────────────────────────────
console.log(`\n  ── Entry Mode Breakdown ──\n`);
const modeCounts = new Map<string, { wins: number; losses: number; pnl: number }>();
for (const e of allEntries) {
  const cur = modeCounts.get(e.mode) ?? { wins: 0, losses: 0, pnl: 0 };
  if (e.pnlPct > 0) cur.wins++; else cur.losses++;
  cur.pnl += e.pnlPct;
  modeCounts.set(e.mode, cur);
}
console.log(`  ${pad('Mode', 12)} ${rpad('W/L', 10)} ${rpad('Win%', 6)} ${rpad('Total P&L', 10)}`);
console.log(`  ${'-'.repeat(40)}`);
for (const [mode, data] of [...modeCounts.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  const total = data.wins + data.losses;
  console.log(`  ${pad(mode, 12)} ${rpad(`${data.wins}W/${data.losses}L`, 10)} ${rpad(`${(data.wins / total * 100).toFixed(0)}%`, 6)} ${rpad(fmtPnl(data.pnl), 10)}`);
}

// ── All entries detail ───────────────────────────────────────────────────────
console.log(`\n  ── All Entries ──\n`);
console.log(`  ${pad('Date', 12)} ${rpad('Time', 6)} ${rpad('Dir', 7)} ${rpad('Mode', 10)} ${rpad('Conf', 6)} ${rpad('Price', 9)} ${rpad('P&L', 8)} ${rpad('Exit', 14)} ${rpad('Hold', 5)}`);
console.log(`  ${'-'.repeat(82)}`);
for (const r of results) {
  for (const e of r.details) {
    const pnlStr = fmtPnl(e.pnlPct);
    const icon = e.pnlPct > 0 ? '📈' : '📉';
    console.log(`  ${pad(r.date, 12)} ${rpad(e.time, 6)} ${rpad(e.direction, 7)} ${rpad(e.mode, 10)} ${rpad(`${e.confidence.toFixed(0)}%`, 6)} ${rpad('$' + e.price.toFixed(2), 9)} ${icon}${rpad(pnlStr, 7)} ${rpad(e.exitReason, 14)} ${rpad(`${e.holdMin}m`, 5)}`);
  }
}

console.log(`\n${'='.repeat(80)}\n`);
