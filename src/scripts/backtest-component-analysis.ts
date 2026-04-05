#!/usr/bin/env npx tsx
/**
 * backtest-component-analysis.ts — Analyze which confidence breakdown components
 * predict entry quality across many trading days.
 *
 * Runs backtest-day.ts --json across a date range, collects all entries with their
 * full 28-component confidence breakdown + outcome grade, then computes:
 *
 *   1. Per-component correlation with entry quality (A/B vs D/F)
 *   2. Per-component mean values for GOOD vs BAD entries
 *   3. Per-mode stratified analysis (trend, breakout, range separately)
 *   4. Component redundancy detection (highly correlated pairs)
 *   5. Actionable threshold suggestions based on the data
 *
 * Usage:
 *   npx tsx src/scripts/backtest-component-analysis.ts [START] [END] [TICKER]
 *   npx tsx src/scripts/backtest-component-analysis.ts 2026-03-01 2026-04-03 SPY
 */

import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2026-03-01';
const END = process.argv[3] || '2026-04-03';
const TICKER = process.argv[4]?.toUpperCase() || 'SPY';

// ── Generate trading days (weekdays) in range ────────────────────────────────
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

interface Breakdown {
  base: number;
  diSpreadBonus: number;
  adxBonus: number;
  diCrossBonus: number;
  alignmentBonus: number;
  tdAdjustment: number;
  obvBonus: number;
  vwapBonus: number;
  oiVolumeBonus: number;
  pricePositionAdjustment: number;
  adxMaturityPenalty: number;
  trendPhaseBonus: number;
  momentumAccelBonus: number;
  structureBonus: number;
  orbBonus: number;
  recentPriceActionBonus: number;
  trContractionPenalty: number;
  lowVolPenalty: number;
  moveExhaustionPenalty: number;
  consolidationPenalty: number;
  nearLevelPenalty: number;
  thetaDecayPenalty: number;
  narrowRangePenalty: number;
  candlePatternBonus: number;
  priceVelocityBonus: number;
  volumeSurgeBonus: number;
  trendPersistenceBonus: number;
  total: number;
}

// The components we analyze (excluding base and total)
const COMPONENTS: (keyof Breakdown)[] = [
  'diSpreadBonus', 'adxBonus', 'diCrossBonus', 'alignmentBonus',
  'tdAdjustment', 'obvBonus', 'vwapBonus', 'oiVolumeBonus',
  'pricePositionAdjustment', 'adxMaturityPenalty', 'trendPhaseBonus',
  'momentumAccelBonus', 'structureBonus', 'orbBonus',
  'recentPriceActionBonus', 'trContractionPenalty', 'lowVolPenalty',
  'moveExhaustionPenalty', 'consolidationPenalty', 'nearLevelPenalty',
  'thetaDecayPenalty', 'narrowRangePenalty', 'candlePatternBonus',
  'priceVelocityBonus', 'volumeSurgeBonus', 'trendPersistenceBonus',
];

interface JsonEntry {
  time: string;
  timeET: string;
  direction: string;
  alignment: string;
  mode: string;
  confidence: number;
  price: number;
  strength: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  gate: string;
  mfePct: number;
  maePct: number;
  mfeOverMae: number;
  mfePeakMinutes: number;
  move5m: number | null;
  move10m: number | null;
  move15m: number | null;
  move30m: number | null;
  dirCorrect: boolean;
  atr: number;
  sim: { pnlPct: number; exitReason: string; holdMin: number; peakPnl: number };
  breakdown: Breakdown;
}

interface JsonDay {
  date: string;
  ticker: string;
  confirmed: JsonEntry[];
  blocked: JsonEntry[];
  filtered: any[];
}

interface CollectedEntry extends JsonEntry {
  date: string;
}

// ── Stats helpers ────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/** Pearson correlation between two arrays */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  const sx = stddev(x), sy = stddev(y);
  if (sx === 0 || sy === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (x[i]! - mx) * (y[i]! - my);
  return sum / ((n - 1) * sx * sy);
}

/** Point-biserial correlation: component value vs binary outcome (1=GOOD, 0=BAD) */
function pointBiserial(values: number[], isGood: boolean[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const goodVals = values.filter((_, i) => isGood[i]);
  const badVals = values.filter((_, i) => !isGood[i]);
  if (goodVals.length === 0 || badVals.length === 0) return 0;
  const mGood = mean(goodVals);
  const mBad = mean(badVals);
  const p = goodVals.length / n;
  const q = 1 - p;
  const s = stddev(values);
  if (s === 0) return 0;
  return ((mGood - mBad) / s) * Math.sqrt(p * q);
}

// ── Formatting ──────────────────────────────────────────────────────────────

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

function gradeToScore(grade: string): number {
  return { A: 4, B: 3, C: 2, D: 1, F: 0 }[grade] ?? 0;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const allDays = getTradingDays(START, END).filter(d => !HOLIDAYS.has(d));

  console.log(`\n${'='.repeat(90)}`);
  console.log(`  COMPONENT CORRELATION ANALYSIS: ${TICKER} ${START} -> ${END}`);
  console.log(`  ${allDays.length} trading days | Uses --json output from backtest-day.ts`);
  console.log(`${'='.repeat(90)}\n`);

  // ── Step 1: Run backtests and collect JSON data ────────────────────────────
  const allEntries: CollectedEntry[] = [];
  let processed = 0;
  let errors = 0;
  let skipped = 0;

  for (const date of allDays) {
    processed++;
    const pct = ((processed / allDays.length) * 100).toFixed(0);
    process.stdout.write(`  [${pct}%] ${date} ...`);

    try {
      const output = execSync(
        `npx tsx src/scripts/backtest-day.ts ${date} ${TICKER} --json 2>&1`,
        { timeout: 180_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

      // Extract JSON between markers
      const jsonMatch = output.match(/__JSON_START__(.+?)__JSON_END__/);
      if (!jsonMatch) {
        process.stdout.write(` no JSON output\n`);
        skipped++;
        continue;
      }

      const dayData: JsonDay = JSON.parse(jsonMatch[1]!);
      const dayEntries = dayData.confirmed.map(e => ({ ...e, date }));
      allEntries.push(...dayEntries);

      if (dayEntries.length === 0) {
        process.stdout.write(` no entries\n`);
      } else {
        const grades = dayEntries.map(e => e.grade).join('');
        process.stdout.write(` ${dayEntries.length} entries [${grades}]\n`);
      }
    } catch (err: any) {
      errors++;
      process.stdout.write(` ERROR\n`);
    }
  }

  console.log(`\n  Collected ${allEntries.length} entries from ${processed - skipped - errors} days (${skipped} skipped, ${errors} errors)\n`);

  if (allEntries.length < 5) {
    console.log('  Not enough entries for meaningful analysis. Need at least 5.\n');
    process.exit(0);
  }

  // ── Step 2: Overall component correlation with grade ──────────────────────

  const gradeScores = allEntries.map(e => gradeToScore(e.grade));
  const isGood = allEntries.map(e => e.outcome === 'GOOD');
  const isBad = allEntries.map(e => e.outcome === 'BAD');

  console.log(`${'='.repeat(90)}`);
  console.log(`  SECTION 1: COMPONENT PREDICTIVE POWER (all entries)`);
  console.log(`${'='.repeat(90)}\n`);

  console.log(`  Total: ${allEntries.length} entries | GOOD: ${isGood.filter(Boolean).length} | BAD: ${isBad.filter(Boolean).length} | MARGINAL: ${allEntries.length - isGood.filter(Boolean).length - isBad.filter(Boolean).length}\n`);

  interface ComponentStat {
    name: string;
    corrWithGrade: number;       // Pearson r with grade score (0-4)
    pointBiserial: number;       // point-biserial with GOOD vs not-GOOD
    meanGood: number;
    meanBad: number;
    meanAll: number;
    stdAll: number;
    separation: number;          // (meanGood - meanBad) / stdAll — effect size
    pctNonZero: number;          // % of entries where component != 0
  }

  const stats: ComponentStat[] = [];

  for (const comp of COMPONENTS) {
    const values = allEntries.map(e => e.breakdown[comp] ?? 0);
    const goodVals = allEntries.filter(e => e.outcome === 'GOOD').map(e => e.breakdown[comp] ?? 0);
    const badVals = allEntries.filter(e => e.outcome === 'BAD').map(e => e.breakdown[comp] ?? 0);
    const s = stddev(values);
    const nonZero = values.filter(v => Math.abs(v) > 0.001).length;

    stats.push({
      name: comp,
      corrWithGrade: pearson(values, gradeScores),
      pointBiserial: pointBiserial(values, isGood),
      meanGood: mean(goodVals),
      meanBad: mean(badVals),
      meanAll: mean(values),
      stdAll: s,
      separation: s > 0 ? (mean(goodVals) - mean(badVals)) / s : 0,
      pctNonZero: (nonZero / values.length) * 100,
    });
  }

  // Sort by absolute point-biserial correlation (most predictive first)
  stats.sort((a, b) => Math.abs(b.pointBiserial) - Math.abs(a.pointBiserial));

  console.log(`  ${pad('Component', 28)} ${rpad('r(grade)', 9)} ${rpad('r(good)', 8)} ${rpad('GoodAvg', 8)} ${rpad('BadAvg', 8)} ${rpad('Sep', 6)} ${rpad('Active%', 8)} ${rpad('Signal', 8)}`);
  console.log(`  ${'-'.repeat(85)}`);

  for (const s of stats) {
    const signal = Math.abs(s.pointBiserial) >= 0.20 ? '***'
      : Math.abs(s.pointBiserial) >= 0.10 ? '** '
      : Math.abs(s.pointBiserial) >= 0.05 ? '*  '
      : '   ';
    const dir = s.pointBiserial > 0 ? '+' : s.pointBiserial < -0.001 ? '-' : ' ';
    console.log(
      `  ${pad(s.name, 28)} ${rpad(s.corrWithGrade.toFixed(3), 9)} ${rpad((dir + Math.abs(s.pointBiserial).toFixed(3)), 8)} ` +
      `${rpad(s.meanGood.toFixed(4), 8)} ${rpad(s.meanBad.toFixed(4), 8)} ${rpad(s.separation.toFixed(2), 6)} ` +
      `${rpad(s.pctNonZero.toFixed(0) + '%', 8)} ${rpad(signal, 8)}`
    );
  }

  console.log(`\n  Legend: r(grade) = Pearson with grade score (A=4..F=0)`);
  console.log(`         r(good)  = point-biserial correlation (+ = higher value → more GOOD entries)`);
  console.log(`         Sep      = effect size (mean_good - mean_bad) / std`);
  console.log(`         Signal   = *** strong (|r|>=0.20), ** moderate (>=0.10), * weak (>=0.05)\n`);

  // ── Step 3: Per-mode stratified analysis ──────────────────────────────────

  const modes = [...new Set(allEntries.map(e => e.mode))].sort();

  console.log(`${'='.repeat(90)}`);
  console.log(`  SECTION 2: PER-MODE COMPONENT ANALYSIS`);
  console.log(`${'='.repeat(90)}\n`);

  for (const mode of modes) {
    const modeEntries = allEntries.filter(e => e.mode === mode);
    if (modeEntries.length < 3) continue;

    const mGood = modeEntries.filter(e => e.outcome === 'GOOD').length;
    const mBad = modeEntries.filter(e => e.outcome === 'BAD').length;
    const mIsGood = modeEntries.map(e => e.outcome === 'GOOD');
    const mGradeScores = modeEntries.map(e => gradeToScore(e.grade));

    console.log(`  ── ${mode.toUpperCase()} (${modeEntries.length} entries: ${mGood} good, ${mBad} bad) ──\n`);

    if (mGood === 0 || mBad === 0) {
      console.log(`    Skipped — need both GOOD and BAD entries for comparison\n`);
      continue;
    }

    const modeStats: { name: string; pb: number; corrGrade: number; sep: number; goodAvg: number; badAvg: number }[] = [];

    for (const comp of COMPONENTS) {
      const values = modeEntries.map(e => e.breakdown[comp] ?? 0);
      const goodVals = modeEntries.filter(e => e.outcome === 'GOOD').map(e => e.breakdown[comp] ?? 0);
      const badVals = modeEntries.filter(e => e.outcome === 'BAD').map(e => e.breakdown[comp] ?? 0);
      const s = stddev(values);
      // Skip components that are always zero in this mode
      if (values.every(v => Math.abs(v) < 0.001)) continue;

      modeStats.push({
        name: comp,
        pb: pointBiserial(values, mIsGood),
        corrGrade: pearson(values, mGradeScores),
        sep: s > 0 ? (mean(goodVals) - mean(badVals)) / s : 0,
        goodAvg: mean(goodVals),
        badAvg: mean(badVals),
      });
    }

    // Show top 10 most predictive for this mode
    modeStats.sort((a, b) => Math.abs(b.pb) - Math.abs(a.pb));
    const top = modeStats.slice(0, 10);

    console.log(`    ${pad('Component', 28)} ${rpad('r(good)', 8)} ${rpad('GoodAvg', 8)} ${rpad('BadAvg', 8)} ${rpad('Sep', 6)}`);
    console.log(`    ${'-'.repeat(62)}`);

    for (const s of top) {
      const dir = s.pb > 0 ? '+' : s.pb < -0.001 ? '-' : ' ';
      console.log(
        `    ${pad(s.name, 28)} ${rpad(dir + Math.abs(s.pb).toFixed(3), 8)} ` +
        `${rpad(s.goodAvg.toFixed(4), 8)} ${rpad(s.badAvg.toFixed(4), 8)} ${rpad(s.sep.toFixed(2), 6)}`
      );
    }
    console.log();
  }

  // ── Step 4: Component redundancy (pairs with |r| > 0.5) ──────────────────

  console.log(`${'='.repeat(90)}`);
  console.log(`  SECTION 3: COMPONENT REDUNDANCY (correlated pairs, |r| > 0.40)`);
  console.log(`${'='.repeat(90)}\n`);

  const pairs: { a: string; b: string; r: number }[] = [];
  for (let i = 0; i < COMPONENTS.length; i++) {
    for (let j = i + 1; j < COMPONENTS.length; j++) {
      const va = allEntries.map(e => e.breakdown[COMPONENTS[i]!] ?? 0);
      const vb = allEntries.map(e => e.breakdown[COMPONENTS[j]!] ?? 0);
      const r = pearson(va, vb);
      if (Math.abs(r) > 0.40) {
        pairs.push({ a: COMPONENTS[i]!, b: COMPONENTS[j]!, r });
      }
    }
  }

  pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  if (pairs.length === 0) {
    console.log(`  No highly correlated component pairs found.\n`);
  } else {
    console.log(`  ${pad('Component A', 28)} ${pad('Component B', 28)} ${rpad('r', 8)}`);
    console.log(`  ${'-'.repeat(66)}`);
    for (const p of pairs) {
      console.log(`  ${pad(p.a, 28)} ${pad(p.b, 28)} ${rpad(p.r.toFixed(3), 8)}`);
    }
    console.log();
  }

  // ── Step 5: Threshold suggestions ─────────────────────────────────────────

  console.log(`${'='.repeat(90)}`);
  console.log(`  SECTION 4: THRESHOLD SUGGESTIONS`);
  console.log(`${'='.repeat(90)}\n`);

  console.log(`  Components where GOOD and BAD entries differ significantly:\n`);

  // Sort by absolute separation (effect size)
  const actionable = stats
    .filter(s => Math.abs(s.separation) >= 0.30 && s.pctNonZero >= 15)
    .sort((a, b) => Math.abs(b.separation) - Math.abs(a.separation));

  if (actionable.length === 0) {
    console.log(`  No components with strong enough separation (|sep| >= 0.30 and active >= 15%).\n`);
  } else {
    for (const s of actionable) {
      const direction = s.separation > 0 ? 'HIGHER values predict GOOD entries' : 'LOWER values predict GOOD entries (negative = good)';
      console.log(`  ${s.name}:`);
      console.log(`    ${direction}`);
      console.log(`    GOOD entries avg: ${s.meanGood.toFixed(4)} | BAD entries avg: ${s.meanBad.toFixed(4)} | Effect: ${s.separation.toFixed(2)}x std`);

      // Suggest a threshold based on the data
      if (s.separation > 0) {
        // Higher = better: suggest a floor (entries below this midpoint have worse outcomes)
        const threshold = (s.meanGood + s.meanBad) / 2;
        const belowCount = allEntries.filter(e => (e.breakdown[s.name as keyof Breakdown] ?? 0) < threshold);
        const belowBad = belowCount.filter(e => e.outcome === 'BAD').length;
        const belowGood = belowCount.filter(e => e.outcome === 'GOOD').length;
        console.log(`    Suggestion: when ${s.name} < ${threshold.toFixed(4)}, entry quality drops`);
        console.log(`    Entries below threshold: ${belowCount.length} (${belowGood} good, ${belowBad} bad)`);
      } else {
        // Lower = better (penalties): suggest a ceiling
        const threshold = (s.meanGood + s.meanBad) / 2;
        const aboveCount = allEntries.filter(e => (e.breakdown[s.name as keyof Breakdown] ?? 0) > threshold);
        const aboveBad = aboveCount.filter(e => e.outcome === 'BAD').length;
        const aboveGood = aboveCount.filter(e => e.outcome === 'GOOD').length;
        console.log(`    Note: this is a penalty — more negative = worse outcome`);
        console.log(`    Suggestion: when ${s.name} > ${threshold.toFixed(4)} (less negative), entry quality is better`);
        console.log(`    Entries above threshold: ${aboveCount.length} (${aboveGood} good, ${aboveBad} bad)`);
      }
      console.log();
    }
  }

  // ── Step 6: Confidence band analysis ──────────────────────────────────────

  console.log(`${'='.repeat(90)}`);
  console.log(`  SECTION 5: COMPONENT VALUES BY CONFIDENCE BAND`);
  console.log(`${'='.repeat(90)}\n`);

  const bands = [
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80%+  ', min: 0.80, max: 1.01 },
  ];

  // Show top 5 components with most variance across confidence bands
  const topComponents = stats.slice(0, 8).map(s => s.name);

  console.log(`  ${pad('Band', 8)} ${rpad('N', 4)} ${rpad('Good%', 6)} ${topComponents.map(c => rpad(c.replace(/Bonus|Penalty|Adjustment/g, '').slice(0, 10), 10)).join(' ')}`);
  console.log(`  ${'-'.repeat(8 + 4 + 6 + topComponents.length * 11)}`);

  for (const band of bands) {
    const be = allEntries.filter(e => e.breakdown.total >= band.min && e.breakdown.total < band.max);
    if (be.length === 0) continue;
    const bGood = be.filter(e => e.outcome === 'GOOD').length;
    const compMeans = topComponents.map(c => mean(be.map(e => e.breakdown[c as keyof Breakdown] ?? 0)));

    console.log(
      `  ${pad(band.label, 8)} ${rpad(String(be.length), 4)} ${rpad((bGood / be.length * 100).toFixed(0) + '%', 6)} ` +
      compMeans.map(m => rpad(m.toFixed(4), 10)).join(' ')
    );
  }

  // ── Step 7: Day-by-day entry list with key components ─────────────────────

  console.log(`\n${'='.repeat(90)}`);
  console.log(`  SECTION 6: ALL ENTRIES WITH TOP COMPONENT VALUES`);
  console.log(`${'='.repeat(90)}\n`);

  // Pick top 5 most predictive
  const top5 = stats.slice(0, 5).map(s => s.name);
  const shortName = (c: string) => c.replace(/Bonus|Penalty|Adjustment/g, '').slice(0, 9);

  console.log(`  ${pad('Date', 11)} ${rpad('Time', 6)} ${rpad('Mode', 8)} ${rpad('Dir', 5)} ${rpad('Conf', 5)} ${rpad('Grd', 4)} ${top5.map(c => rpad(shortName(c), 8)).join(' ')}`);
  console.log(`  ${'-'.repeat(11 + 6 + 8 + 5 + 5 + 4 + top5.length * 9)}`);

  for (const e of allEntries) {
    const gradeIcon = { A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' }[e.grade] ?? '?';
    const dir = e.direction === 'bullish' ? 'BULL' : 'BEAR';
    const vals = top5.map(c => rpad((e.breakdown[c as keyof Breakdown] ?? 0).toFixed(3), 8));

    console.log(
      `  ${pad(e.date, 11)} ${rpad(e.timeET, 6)} ${rpad(e.mode.slice(0, 7), 8)} ${rpad(dir, 5)} ` +
      `${rpad((e.breakdown.total * 100).toFixed(0) + '%', 5)} ${rpad(gradeIcon, 4)} ${vals.join(' ')}`
    );
  }

  console.log(`\n${'='.repeat(90)}\n`);
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
