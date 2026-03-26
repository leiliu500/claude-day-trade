#!/usr/bin/env npx tsx
/**
 * backtest-signal-quality.ts — Run backtest across a date range for SPY and QQQ,
 * reporting signal quality (entry grades, MFE/MAE, direction accuracy) — no sim P&L.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-signal-quality.ts [START] [END] [TICKER]
 *   npx tsx src/scripts/backtest-signal-quality.ts 2025-10-01 2026-03-25         # both SPY+QQQ
 *   npx tsx src/scripts/backtest-signal-quality.ts 2025-10-01 2026-03-25 SPY     # SPY only
 */

import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2025-10-01';
const END = process.argv[3] || '2026-03-25';
const TICKER_ARG = process.argv[4]?.toUpperCase(); // optional: SPY, QQQ, or omit for both
const TICKERS = TICKER_ARG ? [TICKER_ARG] : ['SPY', 'QQQ', 'IWM'];

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

// ── Known US market holidays ─────────────────────────────────────────────────
const HOLIDAYS = new Set([
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  '2026-01-01', // New Year
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
]);

interface EntryDetail {
  time: string;
  direction: string;
  mode: string;
  confidence: number;
  price: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  mfePct: number;
  maePct: number;
  mfeOverMae: number;
  directionCorrect: boolean;
  move5m: number | null;
  move10m: number | null;
  move15m: number | null;
  move30m: number | null;
  gateResult: string;
}

interface DayResult {
  date: string;
  month: string;
  ticker: string;
  entries: EntryDetail[];
  skipped: boolean;
  error?: string;
}

function parseEntries(output: string): EntryDetail[] {
  const entries: EntryDetail[] = [];
  const entryBlocks = output.split(/Entry #\d+:/);

  for (let i = 1; i < entryBlocks.length; i++) {
    const block = entryBlocks[i]!;
    // Only count confirmed entries
    if (!block.includes('CONFIRMED') && !block.includes('OVERRIDE')) continue;

    const timeM = block.match(/(\d{2}:\d{2}) ET/);
    const dirM = block.match(/Direction:\s+(BULLISH|BEARISH)/i);
    const modeM = block.match(/\[(TREND|RANGE|BREAKOUT)\]/);
    const confM = block.match(/Confidence:\s+([\d.]+)%/);
    const priceM = block.match(/Price:\s+\$([\d.]+)/);

    // Grade from "Grade 🟢 A" or similar
    const gradeM = block.match(/Grade\s+\S+\s+([ABCDF])\b/);
    // Entry Quality line: MFE=0.45% | MAE=0.12% | MFE/MAE=3.8
    const mfeM = block.match(/MFE=([\d.]+)%/);
    const maeM = block.match(/MAE=([\d.]+)%/);
    const ratioM = block.match(/MFE\/MAE=([\d.]+)/);
    // Direction correct: ✅ or ❌ after direction
    const dirCorrectM = block.includes('✅');
    // Gate result
    const gateM = block.match(/🟢 CONFIRMED|⚡ HIGH-CONV OVERRIDE|⚡ PHASE-CHANGE OVERRIDE/);

    // Move at intervals: "5m :  $xxx.xx (+0.123%)" or "5m :  $xxx.xx (-0.123%)"
    const parseMove = (label: string): number | null => {
      const m = block.match(new RegExp(`${label}\\s*:\\s+\\$[\\d.]+\\s+\\(([+-]?[\\d.]+)%\\)`));
      return m ? parseFloat(m[1]!) : null;
    };

    entries.push({
      time: timeM?.[1] ?? '?',
      direction: dirM?.[1]?.toUpperCase() ?? '?',
      mode: modeM?.[1] ?? '?',
      confidence: parseFloat(confM?.[1] ?? '0'),
      price: parseFloat(priceM?.[1] ?? '0'),
      grade: (gradeM?.[1] ?? '?') as EntryDetail['grade'],
      outcome: gradeM?.[1] === 'A' || gradeM?.[1] === 'B' ? 'GOOD'
        : gradeM?.[1] === 'F' ? 'BAD' : 'MARGINAL',
      mfePct: parseFloat(mfeM?.[1] ?? '0'),
      maePct: parseFloat(maeM?.[1] ?? '0'),
      mfeOverMae: parseFloat(ratioM?.[1] ?? '0'),
      directionCorrect: dirCorrectM,
      move5m: parseMove('5m'),
      move10m: parseMove('10m'),
      move15m: parseMove('15m'),
      move30m: parseMove('30m'),
      gateResult: gateM?.[0] ?? '?',
    });
  }

  return entries;
}

// ── Formatting helpers ───────────────────────────────────────────────────────
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

function printTickerReport(ticker: string, results: DayResult[]) {
  const tradingDays = results.filter(r => !r.skipped);
  const entryDays = tradingDays.filter(r => r.entries.length > 0);
  const allEntries = results.flatMap(r => r.entries);

  if (allEntries.length === 0) {
    console.log(`\n  No entries found for ${ticker}.\n`);
    return;
  }

  const dirCorrect = allEntries.filter(e => e.directionCorrect).length;
  const dirAccuracy = (dirCorrect / allEntries.length * 100);
  const avgMfe = allEntries.reduce((s, e) => s + e.mfePct, 0) / allEntries.length;
  const avgMae = allEntries.reduce((s, e) => s + e.maePct, 0) / allEntries.length;
  const avgRatio = allEntries.reduce((s, e) => s + e.mfeOverMae, 0) / allEntries.length;
  const avgConf = allEntries.reduce((s, e) => s + e.confidence, 0) / allEntries.length;

  const gradeA = allEntries.filter(e => e.grade === 'A').length;
  const gradeB = allEntries.filter(e => e.grade === 'B').length;
  const gradeC = allEntries.filter(e => e.grade === 'C').length;
  const gradeD = allEntries.filter(e => e.grade === 'D').length;
  const gradeF = allEntries.filter(e => e.grade === 'F').length;
  const good = allEntries.filter(e => e.outcome === 'GOOD').length;
  const bad = allEntries.filter(e => e.outcome === 'BAD').length;
  const marginal = allEntries.length - good - bad;

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  SIGNAL QUALITY REPORT: ${ticker} ${START} → ${END}`);
  console.log(`${'='.repeat(80)}\n`);

  console.log(`  Trading days:    ${tradingDays.length} (${entryDays.length} with entries, ${tradingDays.length - entryDays.length} no-signal)`);
  console.log(`  Total entries:   ${allEntries.length}`);
  console.log(`  Direction:       ${dirCorrect}/${allEntries.length} correct (${dirAccuracy.toFixed(0)}%)`);
  console.log(`  Avg confidence:  ${avgConf.toFixed(1)}%`);
  console.log(`  Avg MFE:         ${avgMfe.toFixed(3)}%`);
  console.log(`  Avg MAE:         ${avgMae.toFixed(3)}%`);
  console.log(`  Avg MFE/MAE:     ${avgRatio.toFixed(1)}`);
  console.log(`  Grades:          A:${gradeA}  B:${gradeB}  C:${gradeC}  D:${gradeD}  F:${gradeF}`);
  console.log(`  Outcome:         ${good} good (A+B) | ${bad} bad (F) | ${marginal} marginal (C+D)`);
  console.log(`  Signal quality:  ${((good / allEntries.length) * 100).toFixed(0)}% good | ${((bad / allEntries.length) * 100).toFixed(0)}% bad`);

  // ── Monthly Breakdown ────────────────────────────────────────────────────
  console.log(`\n  ── Monthly Breakdown ──\n`);
  console.log(`  ${pad('Month', 10)} ${rpad('Entries', 8)} ${rpad('Dir%', 6)} ${rpad('Good', 6)} ${rpad('Bad', 5)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)} ${rpad('Ratio', 6)} ${rpad('Grades', 12)}`);
  console.log(`  ${'-'.repeat(72)}`);

  const months = [...new Set(results.map(r => r.month))].sort();
  for (const month of months) {
    const me = results.filter(r => r.month === month).flatMap(r => r.entries);
    if (me.length === 0) continue;
    const mDir = me.filter(e => e.directionCorrect).length;
    const mGood = me.filter(e => e.outcome === 'GOOD').length;
    const mBad = me.filter(e => e.outcome === 'BAD').length;
    const mMfe = me.reduce((s, e) => s + e.mfePct, 0) / me.length;
    const mMae = me.reduce((s, e) => s + e.maePct, 0) / me.length;
    const mRatio = me.reduce((s, e) => s + e.mfeOverMae, 0) / me.length;
    const mGrades = `${me.filter(e => e.grade === 'A').length}A ${me.filter(e => e.grade === 'B').length}B ${me.filter(e => e.grade === 'F').length}F`;
    console.log(`  ${pad(month, 10)} ${rpad(String(me.length), 8)} ${rpad(`${(mDir / me.length * 100).toFixed(0)}%`, 6)} ${rpad(String(mGood), 6)} ${rpad(String(mBad), 5)} ${rpad(mMfe.toFixed(3) + '%', 8)} ${rpad(mMae.toFixed(3) + '%', 8)} ${rpad(mRatio.toFixed(1), 6)} ${rpad(mGrades, 12)}`);
  }

  // ── Entry Mode Breakdown ─────────────────────────────────────────────────
  console.log(`\n  ── Entry Mode Breakdown ──\n`);
  console.log(`  ${pad('Mode', 12)} ${rpad('Count', 6)} ${rpad('Dir%', 6)} ${rpad('Good', 6)} ${rpad('Bad', 5)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)} ${rpad('Ratio', 6)}`);
  console.log(`  ${'-'.repeat(56)}`);

  const modes = [...new Set(allEntries.map(e => e.mode))].sort();
  for (const mode of modes) {
    const me = allEntries.filter(e => e.mode === mode);
    const mDir = me.filter(e => e.directionCorrect).length;
    const mGood = me.filter(e => e.outcome === 'GOOD').length;
    const mBad = me.filter(e => e.outcome === 'BAD').length;
    const mMfe = me.reduce((s, e) => s + e.mfePct, 0) / me.length;
    const mMae = me.reduce((s, e) => s + e.maePct, 0) / me.length;
    const mRatio = me.reduce((s, e) => s + e.mfeOverMae, 0) / me.length;
    console.log(`  ${pad(mode, 12)} ${rpad(String(me.length), 6)} ${rpad(`${(mDir / me.length * 100).toFixed(0)}%`, 6)} ${rpad(String(mGood), 6)} ${rpad(String(mBad), 5)} ${rpad(mMfe.toFixed(3) + '%', 8)} ${rpad(mMae.toFixed(3) + '%', 8)} ${rpad(mRatio.toFixed(1), 6)}`);
  }

  // ── Direction Breakdown ──────────────────────────────────────────────────
  console.log(`\n  ── Direction Breakdown ──\n`);
  for (const dir of ['BULLISH', 'BEARISH']) {
    const de = allEntries.filter(e => e.direction === dir);
    if (de.length === 0) continue;
    const dDir = de.filter(e => e.directionCorrect).length;
    const dGood = de.filter(e => e.outcome === 'GOOD').length;
    const dBad = de.filter(e => e.outcome === 'BAD').length;
    const dMfe = de.reduce((s, e) => s + e.mfePct, 0) / de.length;
    const dMae = de.reduce((s, e) => s + e.maePct, 0) / de.length;
    console.log(`  ${dir}: ${de.length} entries | ${dDir}/${de.length} correct (${(dDir / de.length * 100).toFixed(0)}%) | ${dGood} good, ${dBad} bad | MFE ${dMfe.toFixed(3)}% MAE ${dMae.toFixed(3)}%`);
  }

  // ── Confidence Bracket Analysis ──────────────────────────────────────────
  console.log(`\n  ── Confidence Bracket Analysis ──\n`);
  const brackets = [
    { label: '65-70%', min: 65, max: 70 },
    { label: '70-75%', min: 70, max: 75 },
    { label: '75-80%', min: 75, max: 80 },
    { label: '80-85%', min: 80, max: 85 },
    { label: '85%+  ', min: 85, max: 200 },
  ];
  console.log(`  ${pad('Conf', 8)} ${rpad('Count', 6)} ${rpad('Dir%', 6)} ${rpad('Good', 6)} ${rpad('Bad', 5)} ${rpad('AvgMFE', 8)} ${rpad('Grades', 15)}`);
  console.log(`  ${'-'.repeat(55)}`);
  for (const b of brackets) {
    const be = allEntries.filter(e => e.confidence >= b.min && e.confidence < b.max);
    if (be.length === 0) continue;
    const bDir = be.filter(e => e.directionCorrect).length;
    const bGood = be.filter(e => e.outcome === 'GOOD').length;
    const bBad = be.filter(e => e.outcome === 'BAD').length;
    const bMfe = be.reduce((s, e) => s + e.mfePct, 0) / be.length;
    const bGrades = `${be.filter(e => e.grade === 'A').length}A ${be.filter(e => e.grade === 'B').length}B ${be.filter(e => e.grade === 'C').length}C ${be.filter(e => e.grade === 'D').length}D ${be.filter(e => e.grade === 'F').length}F`;
    console.log(`  ${pad(b.label, 8)} ${rpad(String(be.length), 6)} ${rpad(`${(bDir / be.length * 100).toFixed(0)}%`, 6)} ${rpad(String(bGood), 6)} ${rpad(String(bBad), 5)} ${rpad(bMfe.toFixed(3) + '%', 8)} ${rpad(bGrades, 15)}`);
  }

  // ── All Entries Detail ────────────────────────────────────────────────────
  console.log(`\n  ── All Entries ──\n`);
  console.log(`  ${pad('Date', 12)} ${rpad('Time', 6)} ${rpad('Dir', 8)} ${rpad('Mode', 10)} ${rpad('Conf', 6)} ${rpad('Grade', 6)} ${rpad('MFE%', 7)} ${rpad('MAE%', 7)} ${rpad('Ratio', 6)} ${rpad('Dir?', 4)}`);
  console.log(`  ${'-'.repeat(78)}`);
  for (const r of results) {
    for (const e of r.entries) {
      const gradeIcon = { A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' }[e.grade] ?? ' ';
      const dirIcon = e.directionCorrect ? '✅' : '❌';
      console.log(`  ${pad(r.date, 12)} ${rpad(e.time, 6)} ${rpad(e.direction, 8)} ${rpad(e.mode, 10)} ${rpad(e.confidence.toFixed(0) + '%', 6)} ${gradeIcon}${rpad(e.grade, 2)} ${rpad(e.mfePct.toFixed(2) + '%', 7)} ${rpad(e.maePct.toFixed(2) + '%', 7)} ${rpad(e.mfeOverMae.toFixed(1), 6)} ${dirIcon}`);
    }
  }

  console.log(`\n${'='.repeat(80)}\n`);
}

// ── Main execution ──────────────────────────────────────────────────────────

const allDays = getTradingDays(START, END).filter(d => !HOLIDAYS.has(d));
const allTickerResults = new Map<string, DayResult[]>();

for (const ticker of TICKERS) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${ticker} SIGNAL QUALITY BACKTEST: ${START} → ${END} (${allDays.length} trading days)`);
  console.log(`${'='.repeat(80)}\n`);

  const results: DayResult[] = [];
  let processed = 0;

  for (const date of allDays) {
    processed++;
    const pct = ((processed / allDays.length) * 100).toFixed(0);
    process.stdout.write(`  [${pct}%] ${date} ...`);

    try {
      const output = execSync(
        `npx tsx src/scripts/backtest-day.ts ${date} ${ticker} 2>&1`,
        { timeout: 120_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const hasResults = output.includes('ticks processed');
      const skipped = !hasResults;
      const entries = skipped ? [] : parseEntries(output);
      const month = date.slice(0, 7);

      results.push({ date, month, ticker, entries, skipped });

      if (skipped) {
        process.stdout.write(` SKIP (no data)\n`);
      } else if (entries.length === 0) {
        process.stdout.write(` no entries\n`);
      } else {
        const good = entries.filter(e => e.outcome === 'GOOD').length;
        const bad = entries.filter(e => e.outcome === 'BAD').length;
        const grades = entries.map(e => e.grade).join('');
        process.stdout.write(` ${entries.length} entries [${grades}] ${good}G/${bad}B\n`);
      }
    } catch (err: any) {
      const msg = err.stderr?.toString().slice(0, 100) || err.message?.slice(0, 100) || 'unknown error';
      results.push({ date, month: date.slice(0, 7), ticker, entries: [], skipped: true, error: msg });
      process.stdout.write(` ERROR\n`);
    }
  }

  allTickerResults.set(ticker, results);
  printTickerReport(ticker, results);
}

// ── Combined comparison (when running both tickers) ─────────────────────────
if (TICKERS.length > 1) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  COMBINED SIGNAL QUALITY COMPARISON: ${START} → ${END}`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`  ${pad('Ticker', 8)} ${rpad('Entries', 8)} ${rpad('Dir%', 6)} ${rpad('Good%', 6)} ${rpad('Bad%', 6)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)} ${rpad('Ratio', 6)} ${rpad('Grades', 20)}`);
  console.log(`  ${'-'.repeat(74)}`);

  for (const ticker of TICKERS) {
    const results = allTickerResults.get(ticker)!;
    const entries = results.flatMap(r => r.entries);
    if (entries.length === 0) {
      console.log(`  ${pad(ticker, 8)} ${rpad('0', 8)}`);
      continue;
    }
    const dirPct = (entries.filter(e => e.directionCorrect).length / entries.length * 100);
    const goodPct = (entries.filter(e => e.outcome === 'GOOD').length / entries.length * 100);
    const badPct = (entries.filter(e => e.outcome === 'BAD').length / entries.length * 100);
    const avgMfe = entries.reduce((s, e) => s + e.mfePct, 0) / entries.length;
    const avgMae = entries.reduce((s, e) => s + e.maePct, 0) / entries.length;
    const avgRatio = entries.reduce((s, e) => s + e.mfeOverMae, 0) / entries.length;
    const grades = `${entries.filter(e => e.grade === 'A').length}A ${entries.filter(e => e.grade === 'B').length}B ${entries.filter(e => e.grade === 'C').length}C ${entries.filter(e => e.grade === 'D').length}D ${entries.filter(e => e.grade === 'F').length}F`;
    console.log(`  ${pad(ticker, 8)} ${rpad(String(entries.length), 8)} ${rpad(dirPct.toFixed(0) + '%', 6)} ${rpad(goodPct.toFixed(0) + '%', 6)} ${rpad(badPct.toFixed(0) + '%', 6)} ${rpad(avgMfe.toFixed(3) + '%', 8)} ${rpad(avgMae.toFixed(3) + '%', 8)} ${rpad(avgRatio.toFixed(1), 6)} ${rpad(grades, 20)}`);
  }

  // Combined totals
  const allEntries = TICKERS.flatMap(t => allTickerResults.get(t)!.flatMap(r => r.entries));
  if (allEntries.length > 0) {
    const dirPct = (allEntries.filter(e => e.directionCorrect).length / allEntries.length * 100);
    const goodPct = (allEntries.filter(e => e.outcome === 'GOOD').length / allEntries.length * 100);
    const badPct = (allEntries.filter(e => e.outcome === 'BAD').length / allEntries.length * 100);
    const avgMfe = allEntries.reduce((s, e) => s + e.mfePct, 0) / allEntries.length;
    const avgMae = allEntries.reduce((s, e) => s + e.maePct, 0) / allEntries.length;
    const avgRatio = allEntries.reduce((s, e) => s + e.mfeOverMae, 0) / allEntries.length;
    console.log(`  ${'-'.repeat(74)}`);
    console.log(`  ${pad('TOTAL', 8)} ${rpad(String(allEntries.length), 8)} ${rpad(dirPct.toFixed(0) + '%', 6)} ${rpad(goodPct.toFixed(0) + '%', 6)} ${rpad(badPct.toFixed(0) + '%', 6)} ${rpad(avgMfe.toFixed(3) + '%', 8)} ${rpad(avgMae.toFixed(3) + '%', 8)} ${rpad(avgRatio.toFixed(1), 6)}`);
  }

  console.log(`\n${'='.repeat(80)}\n`);
}
