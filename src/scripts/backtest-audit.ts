#!/usr/bin/env npx tsx
/**
 * backtest-audit.ts — Multi-day system audit that answers three questions:
 *
 *   1. MISSED ENTRIES — Does the system fire all good entries?
 *   2. ENTRY TIMING   — Does it fire each entry at the right time?
 *   3. FILTER COSTS   — What's the cost/benefit of every gate, threshold, and filter?
 *
 * Usage:
 *   npx tsx src/scripts/backtest-audit.ts [START] [END] [TICKER]
 *   npx tsx src/scripts/backtest-audit.ts 2025-10-01 2026-03-28             # all tickers
 *   npx tsx src/scripts/backtest-audit.ts 2025-10-01 2026-03-28 SPY         # SPY only
 *
 * Runs backtest-day.ts --json for each trading day and aggregates the JSON output
 * into three comprehensive reports.
 */

import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2025-10-01';
const END = process.argv[3] || '2026-03-28';
const TICKER_ARG = process.argv[4]?.toUpperCase();
const TICKERS = TICKER_ARG ? [TICKER_ARG] : ['SPY', 'QQQ', 'IWM', 'NVDA'];

// ── Date helpers ─────────────────────────────────────────────────────────────

function getTradingDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T12:00:00Z');
  const endD = new Date(end + 'T12:00:00Z');
  while (d <= endD) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

const HOLIDAYS = new Set([
  '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16',
]);

// ── Types ────────────────────────────────────────────────────────────────────

interface ConfirmedEntry {
  time: string; timeET: string; direction: string; alignment: string;
  mode: string; confidence: number; price: number; strength: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F'; outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  gate: string;
  mfePct: number; maePct: number; mfeOverMae: number; mfePeakMinutes: number;
  move5m: number | null; move10m: number | null; move15m: number | null; move30m: number | null;
  dirCorrect: boolean; atr: number;
  sim: { pnlPct: number; exitReason: string; holdMin: number; peakPnl: number };
  breakdown: Record<string, number>;
}

interface BlockedEntry {
  time: string; timeET: string; direction: string; alignment: string;
  mode: string; confidence: number; price: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F'; outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  gate: string;
  mfePct: number; maePct: number; mfeOverMae: number; mfePeakMinutes: number;
  move5m: number | null; move10m: number | null; move15m: number | null; move30m: number | null;
  dirCorrect: boolean;
}

interface FilteredEntry {
  time: string; timeET: string; direction: string; mode: string;
  confidence: number; price: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F'; outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  filterRule: string; filterCategory: string;
  mfePct: number; maePct: number; mfeOverMae: number; mfePeakMinutes: number;
}

interface DaySummary {
  date: string; ticker: string;
  confirmed: ConfirmedEntry[];
  blocked: BlockedEntry[];
  filtered: FilteredEntry[];
}

// ── Run backtest-day with --json flag ────────────────────────────────────────

function runBacktestDay(date: string, ticker: string): DaySummary | null {
  try {
    const output = execSync(
      `npx tsx src/scripts/backtest-day.ts ${date} ${ticker} --json 2>&1`,
      { timeout: 180_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const jsonMatch = output.match(/__JSON_START__(.+?)__JSON_END__/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[1]!) as DaySummary;
  } catch {
    return null;
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

function minutesToTimeET(minsAfterOpen: number): string {
  const totalMins = 9 * 60 + 30 + minsAfterOpen;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h;
  return `${h12}:${String(Math.round(m)).padStart(2, '0')} ${ampm}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const allDays = getTradingDays(START, END).filter(d => !HOLIDAYS.has(d));

for (const ticker of TICKERS) {
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  SYSTEM AUDIT: ${ticker}  |  ${START} → ${END}  |  ${allDays.length} trading days`);
  console.log(`${'═'.repeat(90)}\n`);

  const allConfirmed: (ConfirmedEntry & { date: string })[] = [];
  const allBlocked: (BlockedEntry & { date: string })[] = [];
  const allFiltered: (FilteredEntry & { date: string })[] = [];
  let processed = 0;
  let skipped = 0;

  for (const date of allDays) {
    processed++;
    const pct = ((processed / allDays.length) * 100).toFixed(0);
    process.stdout.write(`  [${pct}%] ${date} ${ticker} ...`);

    const result = runBacktestDay(date, ticker);
    if (!result) {
      skipped++;
      process.stdout.write(` SKIP\n`);
      continue;
    }

    const nConf = result.confirmed.length;
    const nBlock = result.blocked.length;
    const nFilt = result.filtered.length;
    const grades = result.confirmed.map(e => e.grade).join('');
    process.stdout.write(` ${nConf} confirmed [${grades}] ${nBlock} blocked ${nFilt} filtered\n`);

    for (const e of result.confirmed) allConfirmed.push({ ...e, date });
    for (const e of result.blocked) allBlocked.push({ ...e, date });
    for (const e of result.filtered) allFiltered.push({ ...e, date });
  }

  const totalEntries = allConfirmed.length;
  const totalBlocked = allBlocked.length;
  const totalFiltered = allFiltered.length;
  const daysWithEntries = new Set(allConfirmed.map(e => e.date)).size;

  console.log(`\n  Processed: ${processed - skipped} days (${skipped} skipped) | ${totalEntries} confirmed, ${totalBlocked} gate-blocked, ${totalFiltered} filter-blocked\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORT 1: MISSED ENTRIES — Does the system fire all good entries?
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`${'─'.repeat(90)}`);
  console.log(`  REPORT 1: MISSED ENTRIES`);
  console.log(`  Does the system capture all A/B-grade setups?`);
  console.log(`${'─'.repeat(90)}\n`);

  // Good entries that were blocked by gates (confirmation, stage-1, etc.)
  const gateBlockedGood = allBlocked.filter(e => e.outcome === 'GOOD');
  const gateBlockedBad = allBlocked.filter(e => e.outcome === 'BAD');
  // Good entries that were blocked by filters (per-ticker, entry window, mode-specific)
  const filterBlockedGood = allFiltered.filter(e => e.outcome === 'GOOD');
  const filterBlockedBad = allFiltered.filter(e => e.outcome === 'BAD');

  const confirmedGood = allConfirmed.filter(e => e.outcome === 'GOOD').length;
  const confirmedBad = allConfirmed.filter(e => e.outcome === 'BAD').length;
  const totalGoodOpportunities = confirmedGood + gateBlockedGood.length + filterBlockedGood.length;
  const captureRate = totalGoodOpportunities > 0
    ? ((confirmedGood / totalGoodOpportunities) * 100).toFixed(1)
    : 'N/A';

  console.log(`  CAPTURE RATE: ${captureRate}% of good entries fired`);
  console.log(`    Confirmed good (A/B):     ${confirmedGood}`);
  console.log(`    Gate-blocked good:        ${gateBlockedGood.length} MISSED (${gateBlockedBad.length} bad correctly blocked)`);
  console.log(`    Filter-blocked good:      ${filterBlockedGood.length} MISSED (${filterBlockedBad.length} bad correctly blocked)`);
  console.log(`    Total good opportunities: ${totalGoodOpportunities}\n`);

  // Confirmed bad entries (system should NOT have fired)
  console.log(`  FALSE POSITIVES: ${confirmedBad} bad entries (F-grade) that fired`);
  if (confirmedBad > 0) {
    for (const e of allConfirmed.filter(e => e.outcome === 'BAD')) {
      console.log(`    ${e.date} ${e.timeET} ET ${e.direction} [${e.mode}] conf=${(e.confidence * 100).toFixed(0)}% gate=${e.gate}`);
    }
  }
  console.log('');

  // Detail: all missed good entries
  if (gateBlockedGood.length + filterBlockedGood.length > 0) {
    console.log(`  ALL MISSED GOOD ENTRIES:\n`);
    console.log(`  ${pad('Date', 12)} ${pad('Time', 8)} ${pad('Dir', 8)} ${pad('Mode', 10)} ${rpad('Conf', 5)} ${rpad('Grade', 3)} ${rpad('MFE%', 7)} ${rpad('MAE%', 7)} ${pad('Block Reason', 40)}`);
    console.log(`  ${'-'.repeat(100)}`);

    for (const e of gateBlockedGood) {
      console.log(`  ${pad(e.date, 12)} ${pad(e.timeET, 8)} ${pad(e.direction, 8)} ${pad(e.mode, 10)} ${rpad((e.confidence * 100).toFixed(0) + '%', 5)} ${rpad(e.grade, 3)} ${rpad(e.mfePct.toFixed(2) + '%', 7)} ${rpad(e.maePct.toFixed(2) + '%', 7)} ${pad('GATE: ' + e.gate, 40)}`);
    }
    for (const e of filterBlockedGood) {
      console.log(`  ${pad(e.date, 12)} ${pad(e.timeET, 8)} ${pad(e.direction, 8)} ${pad(e.mode, 10)} ${rpad((e.confidence * 100).toFixed(0) + '%', 5)} ${rpad(e.grade, 3)} ${rpad(e.mfePct.toFixed(2) + '%', 7)} ${rpad(e.maePct.toFixed(2) + '%', 7)} ${pad('FILTER: ' + e.filterRule.slice(0, 34), 40)}`);
    }
    console.log('');
  }

  // By gate type: which gates block the most good entries?
  if (gateBlockedGood.length > 0) {
    const gateStats = new Map<string, { good: number; bad: number; marginal: number }>();
    for (const e of allBlocked) {
      const g = e.gate;
      if (!gateStats.has(g)) gateStats.set(g, { good: 0, bad: 0, marginal: 0 });
      const s = gateStats.get(g)!;
      if (e.outcome === 'GOOD') s.good++;
      else if (e.outcome === 'BAD') s.bad++;
      else s.marginal++;
    }
    console.log(`  GATE BLOCK BREAKDOWN:\n`);
    console.log(`  ${pad('Gate', 30)} ${rpad('Good', 5)} ${rpad('Bad', 5)} ${rpad('Marg', 5)} ${rpad('Net', 5)}  Verdict`);
    console.log(`  ${'-'.repeat(65)}`);
    for (const [gate, s] of [...gateStats.entries()].sort((a, b) => b[1].good - a[1].good)) {
      const net = s.good - s.bad;
      const verdict = net > 2 ? '⚠️  COSTLY' : net < -1 ? '✅ HELPFUL' : '── NEUTRAL';
      console.log(`  ${pad(gate, 30)} ${rpad(String(s.good), 5)} ${rpad(String(s.bad), 5)} ${rpad(String(s.marginal), 5)} ${rpad((net >= 0 ? '+' : '') + net, 5)}  ${verdict}`);
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORT 2: ENTRY TIMING — Is each entry firing at the right time?
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`${'─'.repeat(90)}`);
  console.log(`  REPORT 2: ENTRY TIMING`);
  console.log(`  Does the system enter at the right moment? (MFE peak = optimal entry)`);
  console.log(`${'─'.repeat(90)}\n`);

  if (allConfirmed.length > 0) {
    // MFE peak timing: how long after entry does MFE peak?
    const peakMinutes = allConfirmed.map(e => e.mfePeakMinutes).filter(m => m > 0);
    const avgPeak = peakMinutes.length > 0 ? peakMinutes.reduce((s, v) => s + v, 0) / peakMinutes.length : 0;
    const medianPeak = peakMinutes.length > 0 ? peakMinutes.sort((a, b) => a - b)[Math.floor(peakMinutes.length / 2)]! : 0;

    // Distribution of MFE peak times
    const buckets = [
      { label: '0-5m', min: 0, max: 5 },
      { label: '5-15m', min: 5, max: 15 },
      { label: '15-30m', min: 15, max: 30 },
      { label: '30-60m', min: 30, max: 60 },
      { label: '60m+', min: 60, max: 999 },
    ];

    console.log(`  MFE PEAK TIMING (when does the best move happen after entry?):\n`);
    console.log(`    Average:  ${avgPeak.toFixed(0)} minutes after entry`);
    console.log(`    Median:   ${medianPeak} minutes after entry\n`);
    console.log(`    ${pad('Window', 10)} ${rpad('Count', 6)} ${rpad('Pct', 6)} ${'█'.repeat(30)}`);
    console.log(`    ${'-'.repeat(55)}`);
    for (const b of buckets) {
      const count = peakMinutes.filter(m => m >= b.min && m < b.max).length;
      const pct = peakMinutes.length > 0 ? (count / peakMinutes.length) * 100 : 0;
      const bar = '█'.repeat(Math.round(pct / 2));
      console.log(`    ${pad(b.label, 10)} ${rpad(String(count), 6)} ${rpad(pct.toFixed(0) + '%', 6)} ${bar}`);
    }
    console.log('');

    // Directional move checkpoints — does the move materialize quickly or slowly?
    const withMoves = allConfirmed.filter(e => e.move5m !== null);
    if (withMoves.length > 0) {
      const avg5m = withMoves.reduce((s, e) => s + (e.move5m ?? 0), 0) / withMoves.length;
      const avg10m = withMoves.filter(e => e.move10m !== null).reduce((s, e) => s + (e.move10m ?? 0), 0) / (withMoves.filter(e => e.move10m !== null).length || 1);
      const avg15m = withMoves.filter(e => e.move15m !== null).reduce((s, e) => s + (e.move15m ?? 0), 0) / (withMoves.filter(e => e.move15m !== null).length || 1);
      const avg30m = withMoves.filter(e => e.move30m !== null).reduce((s, e) => s + (e.move30m ?? 0), 0) / (withMoves.filter(e => e.move30m !== null).length || 1);

      console.log(`  DIRECTIONAL MOVE AFTER ENTRY (avg % in signal direction):\n`);
      console.log(`    5min:   ${avg5m >= 0 ? '+' : ''}${avg5m.toFixed(3)}%`);
      console.log(`    10min:  ${avg10m >= 0 ? '+' : ''}${avg10m.toFixed(3)}%`);
      console.log(`    15min:  ${avg15m >= 0 ? '+' : ''}${avg15m.toFixed(3)}%`);
      console.log(`    30min:  ${avg30m >= 0 ? '+' : ''}${avg30m.toFixed(3)}%`);
      console.log('');
    }

    // Timing by mode
    const modes = [...new Set(allConfirmed.map(e => e.mode))].sort();
    if (modes.length > 1) {
      console.log(`  MFE PEAK BY MODE:\n`);
      console.log(`  ${pad('Mode', 16)} ${rpad('Entries', 8)} ${rpad('AvgPeak', 10)} ${rpad('MedianPk', 10)} ${rpad('AvgMFE%', 8)} ${rpad('AvgMAE%', 8)}`);
      console.log(`  ${'-'.repeat(62)}`);
      for (const mode of modes) {
        const me = allConfirmed.filter(e => e.mode === mode);
        const mPeaks = me.map(e => e.mfePeakMinutes).filter(m => m > 0);
        const mAvg = mPeaks.length > 0 ? mPeaks.reduce((s, v) => s + v, 0) / mPeaks.length : 0;
        const mMedian = mPeaks.length > 0 ? mPeaks.sort((a, b) => a - b)[Math.floor(mPeaks.length / 2)]! : 0;
        const mMfe = me.reduce((s, e) => s + e.mfePct, 0) / me.length;
        const mMae = me.reduce((s, e) => s + e.maePct, 0) / me.length;
        console.log(`  ${pad(mode, 16)} ${rpad(String(me.length), 8)} ${rpad(mAvg.toFixed(0) + 'm', 10)} ${rpad(mMedian + 'm', 10)} ${rpad(mMfe.toFixed(3) + '%', 8)} ${rpad(mMae.toFixed(3) + '%', 8)}`);
      }
      console.log('');
    }

    // Timing by gate type (2-stage vs override vs direct)
    const gateTypes = [...new Set(allConfirmed.map(e => e.gate))].sort();
    if (gateTypes.length > 1) {
      console.log(`  MFE PEAK BY GATE TYPE (earlier entry = override/bypass):\n`);
      console.log(`  ${pad('Gate', 28)} ${rpad('Entries', 8)} ${rpad('AvgPeak', 10)} ${rpad('AvgMFE%', 8)} ${rpad('Good', 5)} ${rpad('Bad', 5)}`);
      console.log(`  ${'-'.repeat(66)}`);
      for (const gate of gateTypes) {
        const ge = allConfirmed.filter(e => e.gate === gate);
        const gPeaks = ge.map(e => e.mfePeakMinutes).filter(m => m > 0);
        const gAvg = gPeaks.length > 0 ? gPeaks.reduce((s, v) => s + v, 0) / gPeaks.length : 0;
        const gMfe = ge.reduce((s, e) => s + e.mfePct, 0) / ge.length;
        const gGood = ge.filter(e => e.outcome === 'GOOD').length;
        const gBad = ge.filter(e => e.outcome === 'BAD').length;
        console.log(`  ${pad(gate, 28)} ${rpad(String(ge.length), 8)} ${rpad(gAvg.toFixed(0) + 'm', 10)} ${rpad(gMfe.toFixed(3) + '%', 8)} ${rpad(String(gGood), 5)} ${rpad(String(gBad), 5)}`);
      }
      console.log('');
    }

    // Early vs late entries: are entries in first vs second half of day better?
    console.log(`  ENTRY TIME-OF-DAY ANALYSIS:\n`);
    const timeBuckets = [
      { label: '10:00-10:30', minET: '10:00', maxET: '10:30' },
      { label: '10:30-11:00', minET: '10:30', maxET: '11:00' },
      { label: '11:00-12:00', minET: '11:00', maxET: '12:00' },
      { label: '12:00-13:00', minET: '12:00', maxET: '13:00' },
      { label: '13:00-14:00', minET: '13:00', maxET: '14:00' },
      { label: '14:00-15:00', minET: '14:00', maxET: '15:00' },
      { label: '15:00-16:00', minET: '15:00', maxET: '16:00' },
    ];
    console.log(`  ${pad('Window', 14)} ${rpad('Count', 6)} ${rpad('Good', 5)} ${rpad('Bad', 5)} ${rpad('GoodRate', 9)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)} ${rpad('AvgPeak', 9)}`);
    console.log(`  ${'-'.repeat(72)}`);
    for (const tb of timeBuckets) {
      const inBucket = allConfirmed.filter(e => e.timeET >= tb.minET && e.timeET < tb.maxET);
      if (inBucket.length === 0) continue;
      const bGood = inBucket.filter(e => e.outcome === 'GOOD').length;
      const bBad = inBucket.filter(e => e.outcome === 'BAD').length;
      const bMfe = inBucket.reduce((s, e) => s + e.mfePct, 0) / inBucket.length;
      const bMae = inBucket.reduce((s, e) => s + e.maePct, 0) / inBucket.length;
      const bPeak = inBucket.map(e => e.mfePeakMinutes).filter(m => m > 0);
      const bAvgPk = bPeak.length > 0 ? bPeak.reduce((s, v) => s + v, 0) / bPeak.length : 0;
      const goodRate = ((bGood / inBucket.length) * 100).toFixed(0);
      console.log(`  ${pad(tb.label, 14)} ${rpad(String(inBucket.length), 6)} ${rpad(String(bGood), 5)} ${rpad(String(bBad), 5)} ${rpad(goodRate + '%', 9)} ${rpad(bMfe.toFixed(3) + '%', 8)} ${rpad(bMae.toFixed(3) + '%', 8)} ${rpad(bAvgPk.toFixed(0) + 'm', 9)}`);
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORT 3: FILTER COST/BENEFIT — What's the ROI of each filter?
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`${'─'.repeat(90)}`);
  console.log(`  REPORT 3: FILTER & GATE COST/BENEFIT`);
  console.log(`  Net value of each threshold, gate, and filter across all days`);
  console.log(`${'─'.repeat(90)}\n`);

  // 3A: Filter-blocked entries by category
  if (allFiltered.length > 0) {
    const catStats = new Map<string, { count: number; good: number; bad: number; marginal: number; mfeSum: number; maeSum: number; entries: (FilteredEntry & { date: string })[] }>();
    for (const fb of allFiltered) {
      const cat = fb.filterCategory;
      if (!catStats.has(cat)) catStats.set(cat, { count: 0, good: 0, bad: 0, marginal: 0, mfeSum: 0, maeSum: 0, entries: [] });
      const s = catStats.get(cat)!;
      s.count++;
      if (fb.outcome === 'GOOD') s.good++;
      else if (fb.outcome === 'BAD') s.bad++;
      else s.marginal++;
      s.mfeSum += fb.mfePct;
      s.maeSum += fb.maePct;
      s.entries.push(fb);
    }

    console.log(`  PER-FILTER COST/BENEFIT (filter-blocked entries):\n`);
    console.log(`  ${pad('Filter', 35)} ${rpad('Blk', 4)} ${rpad('Good', 5)} ${rpad('Bad', 5)} ${rpad('Marg', 5)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)} ${rpad('Net', 5)}  Verdict`);
    console.log(`  ${'-'.repeat(90)}`);

    // Sort: most costly first (highest good-blocked count)
    for (const [cat, s] of [...catStats.entries()].sort((a, b) => (b[1].good - b[1].bad) - (a[1].good - a[1].bad))) {
      const avgMfe = s.mfeSum / s.count;
      const avgMae = s.maeSum / s.count;
      const net = s.good - s.bad;
      const verdict = net > 2 ? '🔴 COSTLY — blocking good entries'
        : net > 0 ? '🟠 SLIGHTLY COSTLY'
        : net < -2 ? '🟢 VERY HELPFUL — blocking bad entries'
        : net < 0 ? '✅ HELPFUL'
        : '── NEUTRAL';
      console.log(`  ${pad(cat, 35)} ${rpad(String(s.count), 4)} ${rpad(String(s.good), 5)} ${rpad(String(s.bad), 5)} ${rpad(String(s.marginal), 5)} ${rpad(avgMfe.toFixed(3) + '%', 8)} ${rpad(avgMae.toFixed(3) + '%', 8)} ${rpad((net >= 0 ? '+' : '') + net, 5)}  ${verdict}`);
    }
    console.log('');
  }

  // 3B: Confirmation gate cost/benefit
  if (allBlocked.length > 0) {
    console.log(`  CONFIRMATION GATE COST/BENEFIT:\n`);
    const gateGood = allBlocked.filter(e => e.outcome === 'GOOD').length;
    const gateBad = allBlocked.filter(e => e.outcome === 'BAD').length;
    const gateMarginal = allBlocked.length - gateGood - gateBad;
    const gateNet = gateGood - gateBad;
    console.log(`    Blocked: ${allBlocked.length} total | ${gateGood} good MISSED | ${gateBad} bad AVOIDED | ${gateMarginal} marginal`);
    console.log(`    Net value: ${gateNet >= 0 ? '+' : ''}${gateNet} (${gateNet > 0 ? 'COSTLY — gate blocks more good than bad' : gateNet < 0 ? 'HELPFUL — gate blocks more bad than good' : 'NEUTRAL'})`);
    console.log('');

    // Breakdown by gate result type
    const byGate = new Map<string, { good: number; bad: number; marginal: number }>();
    for (const e of allBlocked) {
      if (!byGate.has(e.gate)) byGate.set(e.gate, { good: 0, bad: 0, marginal: 0 });
      const s = byGate.get(e.gate)!;
      if (e.outcome === 'GOOD') s.good++;
      else if (e.outcome === 'BAD') s.bad++;
      else s.marginal++;
    }
    for (const [gate, s] of byGate) {
      const net = s.good - s.bad;
      console.log(`    ${pad(gate, 25)}: ${s.good} good, ${s.bad} bad, ${s.marginal} marginal → net ${net >= 0 ? '+' : ''}${net}`);
    }
    console.log('');
  }

  // 3C: Confidence threshold analysis
  console.log(`  CONFIDENCE THRESHOLD SWEEP:\n`);
  console.log(`  What if the threshold were different? (using confirmed + blocked + filtered entries)\n`);

  // Pool all entries with outcomes for threshold analysis
  const allEntries = [
    ...allConfirmed.map(e => ({ confidence: e.confidence, outcome: e.outcome, grade: e.grade, mfePct: e.mfePct, maePct: e.maePct, source: 'confirmed' as const })),
    ...allBlocked.map(e => ({ confidence: e.confidence, outcome: e.outcome, grade: e.grade, mfePct: e.mfePct, maePct: e.maePct, source: 'blocked' as const })),
    ...allFiltered.map(e => ({ confidence: e.confidence, outcome: e.outcome, grade: e.grade, mfePct: e.mfePct, maePct: e.maePct, source: 'filtered' as const })),
  ];

  const thresholds = [0.55, 0.58, 0.60, 0.62, 0.64, 0.65, 0.66, 0.68, 0.70, 0.72, 0.75, 0.80];
  console.log(`  ${pad('Threshold', 10)} ${rpad('Would', 7)} ${rpad('Good', 5)} ${rpad('Bad', 5)} ${rpad('Marg', 5)} ${rpad('GoodRate', 9)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)} ${rpad('Net', 5)}`);
  console.log(`  ${'-'.repeat(68)}`);

  for (const thresh of thresholds) {
    const above = allEntries.filter(e => e.confidence >= thresh);
    if (above.length === 0) continue;
    const good = above.filter(e => e.outcome === 'GOOD').length;
    const bad = above.filter(e => e.outcome === 'BAD').length;
    const marginal = above.length - good - bad;
    const goodRate = ((good / above.length) * 100).toFixed(0);
    const avgMfe = above.reduce((s, e) => s + e.mfePct, 0) / above.length;
    const avgMae = above.reduce((s, e) => s + e.maePct, 0) / above.length;
    const marker = thresh === 0.65 ? ' ← current' : '';
    console.log(`  ${pad((thresh * 100).toFixed(0) + '%', 10)} ${rpad(String(above.length), 7)} ${rpad(String(good), 5)} ${rpad(String(bad), 5)} ${rpad(String(marginal), 5)} ${rpad(goodRate + '%', 9)} ${rpad(avgMfe.toFixed(3) + '%', 8)} ${rpad(avgMae.toFixed(3) + '%', 8)} ${rpad((good - bad >= 0 ? '+' : '') + (good - bad), 5)}${marker}`);
  }
  console.log('');

  // 3D: Confidence bracket quality
  console.log(`  CONFIDENCE BRACKET QUALITY (confirmed entries only):\n`);
  const confBrackets = [
    { label: '60-65%', min: 0.60, max: 0.65 },
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80-85%', min: 0.80, max: 0.85 },
    { label: '85%+  ', min: 0.85, max: 2.00 },
  ];
  console.log(`  ${pad('Conf', 10)} ${rpad('Count', 6)} ${rpad('Good', 5)} ${rpad('Bad', 5)} ${rpad('GoodRate', 9)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)} ${rpad('Ratio', 6)} ${rpad('AvgPeak', 8)}`);
  console.log(`  ${'-'.repeat(70)}`);
  for (const b of confBrackets) {
    const be = allConfirmed.filter(e => e.confidence >= b.min && e.confidence < b.max);
    if (be.length === 0) continue;
    const bGood = be.filter(e => e.outcome === 'GOOD').length;
    const bBad = be.filter(e => e.outcome === 'BAD').length;
    const bMfe = be.reduce((s, e) => s + e.mfePct, 0) / be.length;
    const bMae = be.reduce((s, e) => s + e.maePct, 0) / be.length;
    const bRatio = be.reduce((s, e) => s + e.mfeOverMae, 0) / be.length;
    const bPeak = be.map(e => e.mfePeakMinutes).filter(m => m > 0);
    const bAvgPk = bPeak.length > 0 ? bPeak.reduce((s, v) => s + v, 0) / bPeak.length : 0;
    const goodRate = ((bGood / be.length) * 100).toFixed(0);
    console.log(`  ${pad(b.label, 10)} ${rpad(String(be.length), 6)} ${rpad(String(bGood), 5)} ${rpad(String(bBad), 5)} ${rpad(goodRate + '%', 9)} ${rpad(bMfe.toFixed(3) + '%', 8)} ${rpad(bMae.toFixed(3) + '%', 8)} ${rpad(bRatio.toFixed(1), 6)} ${rpad(bAvgPk.toFixed(0) + 'm', 8)}`);
  }
  console.log('');

  // 3E: Per-mode filter summary
  const allModes = [...new Set([...allConfirmed.map(e => e.mode), ...allFiltered.map(e => e.mode)])].sort();
  if (allModes.length > 1) {
    console.log(`  PER-MODE SUMMARY:\n`);
    console.log(`  ${pad('Mode', 16)} ${rpad('Fired', 6)} ${rpad('Good', 5)} ${rpad('Bad', 5)} ${rpad('GoodRate', 9)} ${rpad('Blocked', 8)} ${rpad('BlkGood', 8)} ${rpad('BlkBad', 7)}`);
    console.log(`  ${'-'.repeat(68)}`);
    for (const mode of allModes) {
      const fired = allConfirmed.filter(e => e.mode === mode);
      const fGood = fired.filter(e => e.outcome === 'GOOD').length;
      const fBad = fired.filter(e => e.outcome === 'BAD').length;
      const blocked = allFiltered.filter(e => e.mode === mode);
      const bGood = blocked.filter(e => e.outcome === 'GOOD').length;
      const bBad = blocked.filter(e => e.outcome === 'BAD').length;
      const goodRate = fired.length > 0 ? ((fGood / fired.length) * 100).toFixed(0) : 'N/A';
      console.log(`  ${pad(mode, 16)} ${rpad(String(fired.length), 6)} ${rpad(String(fGood), 5)} ${rpad(String(fBad), 5)} ${rpad(goodRate + '%', 9)} ${rpad(String(blocked.length), 8)} ${rpad(String(bGood), 8)} ${rpad(String(bBad), 7)}`);
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERALL SYSTEM SCORECARD
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`${'═'.repeat(90)}`);
  console.log(`  SYSTEM SCORECARD: ${ticker}`);
  console.log(`${'═'.repeat(90)}\n`);

  const dirCorrect = allConfirmed.filter(e => e.dirCorrect).length;
  const avgMfe = allConfirmed.length > 0 ? allConfirmed.reduce((s, e) => s + e.mfePct, 0) / allConfirmed.length : 0;
  const avgMae = allConfirmed.length > 0 ? allConfirmed.reduce((s, e) => s + e.maePct, 0) / allConfirmed.length : 0;
  const simWins = allConfirmed.filter(e => e.sim.pnlPct > 0).length;
  const simAvgPnl = allConfirmed.length > 0 ? allConfirmed.reduce((s, e) => s + e.sim.pnlPct, 0) / allConfirmed.length : 0;
  const gradeA = allConfirmed.filter(e => e.grade === 'A').length;
  const gradeB = allConfirmed.filter(e => e.grade === 'B').length;
  const gradeC = allConfirmed.filter(e => e.grade === 'C').length;
  const gradeD = allConfirmed.filter(e => e.grade === 'D').length;
  const gradeF = allConfirmed.filter(e => e.grade === 'F').length;

  console.log(`  Entries:        ${totalEntries} fired across ${daysWithEntries} days`);
  console.log(`  Direction:      ${dirCorrect}/${totalEntries} correct (${totalEntries > 0 ? ((dirCorrect / totalEntries) * 100).toFixed(0) : 0}%)`);
  console.log(`  Grades:         A:${gradeA}  B:${gradeB}  C:${gradeC}  D:${gradeD}  F:${gradeF}`);
  console.log(`  Good rate:      ${confirmedGood}/${totalEntries} (${totalEntries > 0 ? ((confirmedGood / totalEntries) * 100).toFixed(0) : 0}% A+B)`);
  console.log(`  Capture rate:   ${captureRate}% of good setups fired`);
  console.log(`  Avg MFE/MAE:    ${avgMfe.toFixed(3)}% / ${avgMae.toFixed(3)}% (ratio ${avgMae > 0 ? (avgMfe / avgMae).toFixed(1) : 'N/A'})`);
  console.log(`  Sim W/L:        ${simWins}W / ${totalEntries - simWins}L (avg ${simAvgPnl >= 0 ? '+' : ''}${simAvgPnl.toFixed(1)}%)`);
  console.log(`  Missed good:    ${gateBlockedGood.length + filterBlockedGood.length} (${gateBlockedGood.length} gate, ${filterBlockedGood.length} filter)`);
  console.log(`  False positives: ${confirmedBad} F-grade entries that fired`);
  console.log('');
}
