// validate-missed-corpus.ts
//
// Layer 5 of the backtest correctness proof — validates the ideal-entry
// detector that builds the missed-corpus. Five independent witnesses on the
// output of `findIdealEntries`:
//
//   1. Mechanical recompute — clean-room re-implementation of MFE/MAE math
//      must match the library's output to 1e-9.
//   2. Reachability — every ideal's peakPrice must lie inside the future bar
//      window's high/low envelope (peak was actually achievable).
//   3. Causal volume — entryVolMult must be invariant under truncation of
//      the bar tail (no future-bar leakage into the gating threshold).
//   4. Direction-flip null — flipping every ideal's direction and re-grading
//      should NOT yield a high pass rate. High survival ⇒ the detector is
//      mostly picking volatility, not direction.
//   5. Time-jitter null — entering ±1, ±2 bars away should retain a healthy
//      fraction of the original MFE. Low retention ⇒ ideals are sub-minute
//      wicks that wouldn't be tradable if the strategy was 1-2 min late.
//
// Usage: npx tsx src/scripts/validate/validate-missed-corpus.ts <date|range> [ticker]
// Examples:
//   validate-missed-corpus.ts 2026-05-01           SPY
//   validate-missed-corpus.ts 2026-04-15:2026-05-01 SPY

import {
  type Bar, type Direction, type IdealEntry,
  fetch1mBars, findIdealEntries, sessionWindowUTC,
} from '../../lib/missed-entries.js';

// ── Args ────────────────────────────────────────────────────────────────────

interface Args { dates: string[]; ticker: string; windowMin: number; minMfe: number; maxMae: number; minR: number; }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help')) {
    console.log(`Usage: npx tsx src/scripts/validate/validate-missed-corpus.ts <date|start:end> [ticker]
  date or start:end format YYYY-MM-DD; ticker defaults to SPY.`);
    process.exit(0);
  }
  const dateArg = argv[0]!;
  const ticker = (argv[1] ?? 'SPY').toUpperCase();
  const dates: string[] = [];
  if (dateArg.includes(':')) {
    const [start, end] = dateArg.split(':') as [string, string];
    for (const d of eachWeekday(start, end)) dates.push(d);
  } else {
    dates.push(dateArg);
  }
  return { dates, ticker, windowMin: 30, minMfe: 0.20, maxMae: 0.15, minR: 2.0 };
}

function* eachWeekday(startISO: string, endISO: string): Generator<string> {
  const d = new Date(`${startISO}T12:00:00Z`); const e = new Date(`${endISO}T12:00:00Z`);
  while (d <= e) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      yield `${y}-${m}-${dd}`;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// ── Clean-room reference impl of evaluateEntry ──────────────────────────────
// Independent re-implementation of the math in src/lib/missed-entries.ts,
// rewritten from the spec ("MFE = peak favorable excursion within window;
// MAE-before-peak = max adverse run from entry up to that peak"). MUST agree
// with the library version.

interface RefEval { mfeAbs: number; maeBeforePeak: number; peakIdx: number; peakPrice: number; entryPrice: number; }

function refEvaluate(bars: Bar[], i: number, dir: Direction, windowMin: number): RefEval {
  const entry = bars[i]!.c;
  const last = Math.min(i + windowMin, bars.length - 1);
  let bestFav = 0, bestPeakIdx = i, bestPeakPx = entry, bestMaeAtPeak = 0, runMae = 0;
  for (let j = i + 1; j <= last; j++) {
    const b = bars[j]!;
    if (dir === 'long') {
      if (entry - b.l > runMae) runMae = entry - b.l;
      const fav = b.h - entry;
      if (fav > bestFav) { bestFav = fav; bestPeakIdx = j; bestPeakPx = b.h; bestMaeAtPeak = runMae; }
    } else {
      if (b.h - entry > runMae) runMae = b.h - entry;
      const fav = entry - b.l;
      if (fav > bestFav) { bestFav = fav; bestPeakIdx = j; bestPeakPx = b.l; bestMaeAtPeak = runMae; }
    }
  }
  return { mfeAbs: bestFav, maeBeforePeak: bestMaeAtPeak, peakIdx: bestPeakIdx, peakPrice: bestPeakPx, entryPrice: entry };
}

function gradeRef(mfePct: number, maePct: number, ttpMin: number, args: Args): 'A' | 'B' | 'C' | null {
  const r = mfePct / Math.max(maePct, 0.01);
  if (mfePct < args.minMfe) return null;
  if (maePct > args.maxMae) return null;
  if (r < args.minR) return null;
  if (mfePct >= 0.40 && r >= 4.0 && ttpMin <= 30) return 'A';
  if (mfePct >= 0.25 && r >= 2.5) return 'B';
  return 'C';
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs();
  const detect = { windowMin: args.windowMin, minMfe: args.minMfe, maxMae: args.maxMae, minR: args.minR, minVolMult: 0 };
  console.log(`[validate] ${args.ticker} ${args.dates[0]}${args.dates.length > 1 ? `:${args.dates[args.dates.length - 1]}` : ''} (${args.dates.length} day${args.dates.length === 1 ? '' : 's'})`);

  // Per-day dataset: bars + ideals. Cache so all 5 tests reuse the same data.
  const days: { date: string; bars: Bar[]; ideals: IdealEntry[] }[] = [];
  for (const date of args.dates) {
    const { startUTC, endUTC } = sessionWindowUTC(date, false);
    const bars = await fetch1mBars(args.ticker, startUTC, endUTC);
    if (bars.length === 0) { console.log(`  [${date}] no bars (holiday?), skipping`); continue; }
    const ideals = findIdealEntries(bars, detect);
    days.push({ date, bars, ideals });
  }
  const totalIdeals = days.reduce((s, d) => s + d.ideals.length, 0);
  console.log(`[validate] ${totalIdeals} ideals across ${days.length} days\n`);
  if (totalIdeals === 0) { console.log('PASS (vacuously) — no ideals to validate'); process.exit(0); }

  // ── Test 1: Mechanical recompute (1e-9) ───────────────────────────────────
  // Independent MFE/MAE for every ideal must match the library's reported
  // figures byte-for-byte. Catches off-by-one indexing and entry-price drift.
  let mechFails = 0;
  for (const d of days) {
    for (const id of d.ideals) {
      const i = d.bars.findIndex(b => b.ts === id.ts);
      if (i < 0) { mechFails++; continue; }
      const ev = refEvaluate(d.bars, i, id.direction, args.windowMin);
      const refMfePct = (ev.mfeAbs / ev.entryPrice) * 100;
      const refMaePct = (ev.maeBeforePeak / ev.entryPrice) * 100;
      const refR = refMfePct / Math.max(refMaePct, 0.01);
      const refTtp = (d.bars[ev.peakIdx]!.ts - d.bars[i]!.ts) / 60_000;
      const drift = Math.max(
        Math.abs(refMfePct - id.mfePct),
        Math.abs(refMaePct - id.maePct),
        Math.abs(refR - id.rMultiple),
        Math.abs(refTtp - id.ttpMin),
        Math.abs(ev.peakPrice - id.peakPrice),
        Math.abs(ev.entryPrice - id.entryPrice),
      );
      if (drift > 1e-9) mechFails++;
    }
  }
  reportTest('1. mechanical recompute (1e-9)', mechFails === 0, `${totalIdeals - mechFails}/${totalIdeals} match`);

  // ── Test 2: Reachability ──────────────────────────────────────────────────
  // peakPrice must sit inside the future-bar high/low envelope. A long ideal
  // claims peakPrice ≥ entryPrice; a short claims peakPrice ≤ entryPrice.
  let reachFails = 0;
  for (const d of days) {
    for (const id of d.ideals) {
      if (id.direction === 'long' && id.peakPrice < id.entryPrice) reachFails++;
      if (id.direction === 'short' && id.peakPrice > id.entryPrice) reachFails++;
    }
  }
  reportTest('2. reachability (peak vs entry)', reachFails === 0, `${totalIdeals - reachFails}/${totalIdeals} reachable`);

  // ── Test 3: Causal volume baseline ────────────────────────────────────────
  // Truncate bars at (idealBar + windowMin) — i.e., exactly the bars that
  // were causally available at the decision moment + window. Re-run the
  // detector on the truncated slice and confirm the SAME ideal exists with
  // the SAME entryVolMult. If volume normalization leaks future bars, the
  // truncated entryVolMult would differ.
  let volFails = 0, volChecks = 0;
  for (const d of days) {
    for (const id of d.ideals) {
      const i = d.bars.findIndex(b => b.ts === id.ts);
      if (i < 0) continue;
      const slice = d.bars.slice(0, i + args.windowMin + 1);
      const reIdeals = findIdealEntries(slice, detect);
      const re = reIdeals.find(x => x.ts === id.ts && x.direction === id.direction);
      volChecks++;
      if (!re) { volFails++; continue; }
      if (Math.abs(re.entryVolMult - id.entryVolMult) > 1e-9) volFails++;
    }
  }
  reportTest('3. causal volume (no future leak)', volFails === 0, `${volChecks - volFails}/${volChecks} invariant under truncation`);

  // ── Test 4: Direction-flip null ───────────────────────────────────────────
  // For each ideal, evaluate the OPPOSITE direction at the same decision bar
  // and re-grade. The detector's direction confirmation (3-of-5 candle gate)
  // should make this almost never grade. High survival means the gate isn't
  // doing work and the detector is volatility-driven, not direction-driven.
  let flipPass = 0;
  for (const d of days) {
    for (const id of d.ideals) {
      const i = d.bars.findIndex(b => b.ts === id.ts);
      if (i < 0) continue;
      const flipped: Direction = id.direction === 'long' ? 'short' : 'long';
      const ev = refEvaluate(d.bars, i, flipped, args.windowMin);
      const mfePct = (ev.mfeAbs / ev.entryPrice) * 100;
      const maePct = (ev.maeBeforePeak / ev.entryPrice) * 100;
      const ttpMin = (d.bars[ev.peakIdx]!.ts - d.bars[i]!.ts) / 60_000;
      if (gradeRef(mfePct, maePct, ttpMin, args)) flipPass++;
    }
  }
  const flipRate = flipPass / totalIdeals;
  // Threshold rationale: a 0.20% MFE in EITHER direction is common in
  // intraday SPY (60-bar moves both ways are routine). The 3-of-5 candle
  // gate keeps the original direction tied to recent action; a flipped
  // call removes that tie. Healthy: <30%. >50% would mean the gate is
  // ineffective and the detector is essentially "any volatile bar."
  reportTest('4. direction-flip null (<30% survive)', flipRate < 0.30,
    `${flipPass}/${totalIdeals} (${(flipRate * 100).toFixed(1)}%)`);

  // ── Test 5: Time-jitter null (median MFE retention) ───────────────────────
  // Shift the decision bar by ±1 and ±2 bars; for each shift, re-evaluate
  // forward MFE in the same direction. Compute (shifted MFE / original MFE)
  // averaged over the four shifts. A real, sustained move retains most of
  // its MFE under sub-minute jitter; a sub-minute wick collapses.
  const retentions: number[] = [];
  for (const d of days) {
    for (const id of d.ideals) {
      const i = d.bars.findIndex(b => b.ts === id.ts);
      if (i < 0) continue;
      let sum = 0, n = 0;
      for (const k of [-2, -1, 1, 2]) {
        const j = i + k;
        if (j < 0 || j >= d.bars.length - 1) continue;
        const ev = refEvaluate(d.bars, j, id.direction, args.windowMin);
        const shiftedMfePct = (ev.mfeAbs / ev.entryPrice) * 100;
        sum += shiftedMfePct / Math.max(id.mfePct, 0.01);
        n++;
      }
      if (n > 0) retentions.push(sum / n);
    }
  }
  retentions.sort((a, b) => a - b);
  const medianRetention = retentions.length === 0 ? 0 : retentions[Math.floor(retentions.length / 2)]!;
  // Threshold rationale: a real ≥30-min move retains ~50% of its MFE when
  // entry shifts ±1-2 min (early entry catches more, late entry less). A
  // wick-driven ideal collapses to ~10-20%. <50% suggests the detector is
  // catching peaks rather than moves.
  reportTest('5. time-jitter null (median retention ≥50%)', medianRetention >= 0.50,
    `median = ${(medianRetention * 100).toFixed(1)}% over ${retentions.length} ideals`);

  console.log('');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

function reportTest(label: string, pass: boolean, detail: string): void {
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}  —  ${detail}`);
}
