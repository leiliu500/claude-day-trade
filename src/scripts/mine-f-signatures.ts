#!/usr/bin/env npx tsx
/**
 * mine-f-signatures.ts — Find discriminating filter candidates from F-grade entries.
 *
 * Runs backtest-signal-quality.ts across a date range, extracts all entries with their
 * indicator signatures (rExh, chop, dispVel, regime, trendStr, atr), then:
 *
 *   1. Per-indicator distribution analysis (F vs A+B) — where do F-grades cluster?
 *   2. Single-threshold scan — which threshold T for each indicator maximally blocks F
 *      while preserving A+B?
 *   3. Two-indicator AND-rule scan — which pairs + thresholds give the best kill ratio?
 *
 * Output: ranked list of candidate filter rules with estimated expectancy gain, so the
 * user can pick a few promising ones and validate each via validate-change.ts.
 *
 * Usage:
 *   npx tsx src/scripts/mine-f-signatures.ts [START] [END] [TICKER] [--direction bullish|bearish]
 *   npx tsx src/scripts/mine-f-signatures.ts 2026-01-02 2026-04-17 SPY
 *
 * Cache: output JSON can be reused with --cache <file.json> to skip the backtest pass.
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const positionalArgs = args.filter(a => !a.startsWith('--'));
const getFlagValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const START = positionalArgs[0] || '2026-01-02';
const END = positionalArgs[1] || '2026-04-17';
const TICKER = (positionalArgs[2] || 'SPY').toUpperCase();
const DIRECTION_FILTER = getFlagValue('--direction')?.toUpperCase(); // 'BULLISH' | 'BEARISH' | undefined
const CACHE_PATH = getFlagValue('--cache');

const TOP_N = 10;                 // report top-10 candidates per category
const MIN_F_BLOCKED = 3;          // candidate must block at least 3 F-grade entries
const MIN_F_BLOCK_RATE = 0.10;    // must catch ≥10% of F-grade population
const MAX_AB_BLOCK_RATE = 0.15;   // must preserve ≥85% of A+B-grade population
const GRADE_SCORE = { A: 2, B: 1, C: 0, D: -1, F: -2 } as const;

interface MinedEntry {
  date: string;
  time: string;
  direction: string;
  mode: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  confidence: number;
  mfePct: number;
  maePct: number;
  atr: number | null;
  regime: number | null;
  rangeExh: number | null;
  dispVel: number | null;
  chop: number | null;
  trendStr: number | null;
  gateResult?: string;
}

interface BacktestJson {
  perTicker: Array<{
    ticker: string;
    entries: MinedEntry[];
  }>;
}

// ── Load data ────────────────────────────────────────────────────────────────
function loadEntries(): MinedEntry[] {
  let json: BacktestJson;

  if (CACHE_PATH && existsSync(CACHE_PATH)) {
    console.log(`[cache] Reading ${CACHE_PATH}`);
    json = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  } else {
    console.log(`[backtest] Running ${START} → ${END} ${TICKER} (this takes a few minutes)`);
    const out = execSync(
      `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60 * 60 * 1000 },
    );
    const m = out.match(/<!--VALIDATE-JSON-BEGIN-->\n(.+?)\n<!--VALIDATE-JSON-END-->/s);
    if (!m) throw new Error('JSON block not found in backtest output');
    json = JSON.parse(m[1]!);
    if (CACHE_PATH) {
      writeFileSync(CACHE_PATH, m[1]!);
      console.log(`[cache] Wrote ${CACHE_PATH}`);
    }
  }

  const t = json.perTicker.find(p => p.ticker === TICKER);
  if (!t) throw new Error(`ticker ${TICKER} not in output`);
  const all = t.entries;
  if (DIRECTION_FILTER) {
    const filtered = all.filter(e => e.direction === DIRECTION_FILTER);
    console.log(`[filter] direction=${DIRECTION_FILTER}: ${filtered.length}/${all.length} entries`);
    return filtered;
  }
  return all;
}

// ── Scoring ─────────────────────────────────────────────────────────────────
interface BlockedStats {
  total: number;
  A: number; B: number; C: number; D: number; F: number;
  /** Fraction of the F-grade population this rule catches (0..1). */
  fBlockRate: number;
  /** Fraction of A+B-grade population this rule blocks (0..1). Lower = better preservation. */
  abBlockRate: number;
  /** Discrimination score: fBlockRate - 2 * abBlockRate. */
  discrimScore: number;
  /** Predicted new expectancy if this rule is applied, ignoring gate reshuffling. */
  newExpectancy: number;
  expectancyDelta: number;
  /** Fraction of blocked entries that bypassed the confirmation gate via HIGH-CONV OVERRIDE.
   *  High HCO share → blocking removes signals that don't participate in priorCount, so the
   *  downstream gate state doesn't change — BUT the position slot does, which tends to admit
   *  a later signal (usually F-biased, per 2026-04-18 calibration run). */
  highConvRate: number;
  /** Fraction of blocked entries that sit on multi-entry days — proxy for slot/gate cascade
   *  surface area. Lone-day blocks don't reshuffle anything on the same day. */
  multiDayRate: number;
  /** Combined cascade-risk score 0..1. Higher = predicted delta more likely to disagree with
   *  actual backtest (most commonly via admitting F-biased replacement entries). */
  cascadeRisk: number;
  /** Discrimination score discounted by (1 - cascadeRisk). Use this for ranking. */
  adjustedScore: number;
}

const totalPopulation = { A: 0, B: 0, C: 0, D: 0, F: 0 };
let baselineExpectancy = 0;
const entriesPerDay = new Map<string, number>();

function statsForBlocked(blocked: MinedEntry[]): BlockedStats {
  const count = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const e of blocked) count[e.grade]++;
  const fBlockRate = totalPopulation.F > 0 ? count.F / totalPopulation.F : 0;
  const abTotal = totalPopulation.A + totalPopulation.B;
  const abBlockRate = abTotal > 0 ? (count.A + count.B) / abTotal : 0;
  const discrimScore = fBlockRate - 2 * abBlockRate;

  const blockedScore = count.A * 2 + count.B - count.D - count.F * 2;
  const totalScore =
    totalPopulation.A * 2 + totalPopulation.B -
    totalPopulation.D - totalPopulation.F * 2;
  const totalN =
    totalPopulation.A + totalPopulation.B + totalPopulation.C +
    totalPopulation.D + totalPopulation.F;
  const remainingN = totalN - blocked.length;
  const newExpectancy = remainingN > 0 ? (totalScore - blockedScore) / remainingN : 0;

  // Cascade-risk heuristic — calibrated from 2026-04-18 confidence>85 run:
  // predicted Δexp +0.124 → actual -0.023. That candidate blocked 57% HCO and
  // 95% multi-day entries. Combined as equal-weight average.
  let hco = 0, multi = 0;
  for (const e of blocked) {
    if (e.gateResult && e.gateResult.includes('HIGH-CONV')) hco++;
    if ((entriesPerDay.get(e.date) ?? 1) > 1) multi++;
  }
  const highConvRate = blocked.length > 0 ? hco / blocked.length : 0;
  const multiDayRate = blocked.length > 0 ? multi / blocked.length : 0;
  const cascadeRisk = 0.5 * highConvRate + 0.5 * multiDayRate;
  const adjustedScore = discrimScore * (1 - cascadeRisk);

  return {
    total: blocked.length,
    ...count,
    fBlockRate,
    abBlockRate,
    discrimScore,
    newExpectancy,
    expectancyDelta: newExpectancy - baselineExpectancy,
    highConvRate,
    multiDayRate,
    cascadeRisk,
    adjustedScore,
  };
}

function passesFilter(s: BlockedStats): boolean {
  return s.F >= MIN_F_BLOCKED
    && s.fBlockRate >= MIN_F_BLOCK_RATE
    && s.abBlockRate <= MAX_AB_BLOCK_RATE
    && s.discrimScore > 0;
}

function fmtStats(s: BlockedStats): string {
  const sign = (n: number) => n >= 0 ? '+' : '';
  const risk = s.cascadeRisk >= 0.6 ? '⚠️ ' : s.cascadeRisk >= 0.4 ? '· ' : '';
  return `blocks ${s.total} (${s.A}A/${s.B}B/${s.C}C/${s.D}D/${s.F}F)  F-catch=${(s.fBlockRate * 100).toFixed(0)}%  AB-loss=${(s.abBlockRate * 100).toFixed(0)}%  Δexp=${sign(s.expectancyDelta)}${s.expectancyDelta.toFixed(3)}  ${risk}cascade=${(s.cascadeRisk * 100).toFixed(0)}% (HCO ${(s.highConvRate * 100).toFixed(0)}%, multiDay ${(s.multiDayRate * 100).toFixed(0)}%)  adj=${sign(s.adjustedScore)}${s.adjustedScore.toFixed(3)}`;
}

// ── Single-indicator threshold scan ─────────────────────────────────────────
interface ThresholdCandidate {
  indicator: string;
  op: '>' | '>=' | '<' | '<=';
  threshold: number;
  stats: BlockedStats;
}

function scanThresholds(
  entries: MinedEntry[],
  indicator: keyof MinedEntry,
  values: number[],
): ThresholdCandidate[] {
  const out: ThresholdCandidate[] = [];
  for (const t of values) {
    for (const op of ['>', '>=', '<', '<='] as const) {
      const pred = (v: number) => {
        if (op === '>') return v > t;
        if (op === '>=') return v >= t;
        if (op === '<') return v < t;
        return v <= t;
      };
      const blocked = entries.filter(e => {
        const v = e[indicator];
        return typeof v === 'number' && pred(v);
      });
      const stats = statsForBlocked(blocked);
      if (!passesFilter(stats)) continue;
      out.push({ indicator: String(indicator), op, threshold: t, stats });
    }
  }
  return out.sort((a, b) => b.stats.adjustedScore - a.stats.adjustedScore);
}

// ── Two-indicator AND-rule scan ─────────────────────────────────────────────
interface PairCandidate {
  a: ThresholdCandidate;
  b: ThresholdCandidate;
  stats: BlockedStats;
}

function scanPairs(
  entries: MinedEntry[],
  singlesRawTopN: ThresholdCandidate[],
  maxPairs = 200,
): PairCandidate[] {
  const out: PairCandidate[] = [];
  const top = singlesRawTopN.slice(0, 30);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i]!, b = top[j]!;
      if (a.indicator === b.indicator) continue;
      const pred = (e: MinedEntry, c: ThresholdCandidate) => {
        const v = e[c.indicator as keyof MinedEntry];
        if (typeof v !== 'number') return false;
        if (c.op === '>') return v > c.threshold;
        if (c.op === '>=') return v >= c.threshold;
        if (c.op === '<') return v < c.threshold;
        return v <= c.threshold;
      };
      const blocked = entries.filter(e => pred(e, a) && pred(e, b));
      const stats = statsForBlocked(blocked);
      if (!passesFilter(stats)) continue;
      if (stats.adjustedScore <= a.stats.adjustedScore) continue;
      if (stats.adjustedScore <= b.stats.adjustedScore) continue;
      out.push({ a, b, stats });
    }
  }
  return out.sort((a, b) => b.stats.adjustedScore - a.stats.adjustedScore).slice(0, maxPairs);
}

// ── Percentile summary ──────────────────────────────────────────────────────
function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(p * (sorted.length - 1));
  return sorted[i]!;
}

function printDistribution(entries: MinedEntry[], indicator: keyof MinedEntry, label: string): void {
  const bad = entries.filter(e => e.grade === 'F').map(e => e[indicator] as number).filter(v => typeof v === 'number');
  const good = entries.filter(e => e.grade === 'A' || e.grade === 'B').map(e => e[indicator] as number).filter(v => typeof v === 'number');
  if (bad.length === 0 || good.length === 0) return;
  const pct = (arr: number[]) => `p10=${percentile(arr, 0.1).toFixed(2)} p50=${percentile(arr, 0.5).toFixed(2)} p90=${percentile(arr, 0.9).toFixed(2)}`;
  console.log(`  ${label.padEnd(12)} F: ${pct(bad)}`);
  console.log(`  ${''.padEnd(12)} A+B: ${pct(good)}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
const entries = loadEntries();
const F = entries.filter(e => e.grade === 'F').length;
const A = entries.filter(e => e.grade === 'A').length;
const B = entries.filter(e => e.grade === 'B').length;
const C = entries.filter(e => e.grade === 'C').length;
const D = entries.filter(e => e.grade === 'D').length;
const N = entries.length;
const expectancy = N > 0 ? (A * 2 + B - D - F * 2) / N : 0;

// Initialize module-level state for statsForBlocked
totalPopulation.A = A;
totalPopulation.B = B;
totalPopulation.C = C;
totalPopulation.D = D;
totalPopulation.F = F;
baselineExpectancy = expectancy;
for (const e of entries) {
  entriesPerDay.set(e.date, (entriesPerDay.get(e.date) ?? 0) + 1);
}

console.log(`\n${'='.repeat(80)}`);
console.log(`  F-GRADE SIGNATURE MINING: ${TICKER} ${START} → ${END}${DIRECTION_FILTER ? ` (${DIRECTION_FILTER} only)` : ''}`);
console.log(`${'='.repeat(80)}\n`);
console.log(`  Population: ${N} entries (${A}A/${B}B/${C}C/${D}D/${F}F)  baseline expectancy ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(3)}\n`);

// ── Distributions ──
console.log(`  ── Indicator Distributions (F vs A+B) ──\n`);
printDistribution(entries, 'rangeExh', 'rangeExh');
printDistribution(entries, 'chop', 'chop');
printDistribution(entries, 'dispVel', 'dispVel');
printDistribution(entries, 'regime', 'regime');
printDistribution(entries, 'trendStr', 'trendStr');
printDistribution(entries, 'atr', 'atr');
printDistribution(entries, 'confidence', 'confidence');

// ── Threshold scans ──
const rExhThresholds = [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0];
const chopThresholds = [0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8];
const dvelThresholds = [-0.1, -0.05, -0.03, -0.01, 0.00, 0.01, 0.02, 0.03, 0.05, 0.08, 0.10];
const regimeThresholds = [30, 40, 50, 55, 60, 65, 70, 75, 80, 85];
const tstrThresholds = [0, 1, 2, 3, 4, 5];
const atrThresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0];
const confThresholds = [60, 65, 70, 75, 80, 85, 90, 95];

const singles: ThresholdCandidate[] = [
  ...scanThresholds(entries, 'rangeExh', rExhThresholds),
  ...scanThresholds(entries, 'chop', chopThresholds),
  ...scanThresholds(entries, 'dispVel', dvelThresholds),
  ...scanThresholds(entries, 'regime', regimeThresholds),
  ...scanThresholds(entries, 'trendStr', tstrThresholds),
  ...scanThresholds(entries, 'atr', atrThresholds),
  ...scanThresholds(entries, 'confidence', confThresholds),
].sort((a, b) => b.stats.adjustedScore - a.stats.adjustedScore);

console.log(`\n  ── Top ${TOP_N} Single-Indicator Candidates (F-catch ≥${(MIN_F_BLOCK_RATE*100).toFixed(0)}%, A+B-loss ≤${(MAX_AB_BLOCK_RATE*100).toFixed(0)}%) ──\n`);
if (singles.length === 0) {
  console.log(`  ❌ NO candidates meet the preservation threshold.`);
  console.log(`     This means no single-indicator rule can catch ≥${(MIN_F_BLOCK_RATE*100).toFixed(0)}% of F-grade entries`);
  console.log(`     without also blocking >${(MAX_AB_BLOCK_RATE*100).toFixed(0)}% of A+B-grade entries.`);
  console.log(`     The current indicator feature set cannot discriminate F from A+B on this population.`);
} else {
  for (const c of singles.slice(0, TOP_N)) {
    console.log(`  ${c.indicator} ${c.op} ${c.threshold}  →  ${fmtStats(c.stats)}`);
  }
}

// ── Pair scans ──
console.log(`\n  ── Top ${TOP_N} Two-Indicator AND-Rule Candidates ──\n`);
const pairs = scanPairs(entries, singles);
if (pairs.length === 0) {
  console.log(`  ❌ NO two-indicator pairs meet the preservation threshold.`);
} else {
  for (const p of pairs.slice(0, TOP_N)) {
    const rule = `${p.a.indicator} ${p.a.op} ${p.a.threshold} AND ${p.b.indicator} ${p.b.op} ${p.b.threshold}`;
    console.log(`  ${rule}  →  ${fmtStats(p.stats)}`);
  }
}

// ── Overall verdict ──
console.log(`\n  ── Mining Verdict ──\n`);
if (singles.length === 0 && pairs.length === 0) {
  console.log(`  ⚠️  Current indicator set (rangeExh, chop, dispVel, regime, trendStr, atr, confidence)`);
  console.log(`     cannot cleanly discriminate F-grade from A+B-grade entries in this population.`);
  console.log(`     F and A+B distributions overlap at every percentile — no threshold separates them.\n`);
  console.log(`     Next step: add NEW features to EntryContext that capture day-regime (trending/`);
  console.log(`     flat/reversing), cumulative displacement, or other signals not in the current tuple.`);
  console.log(`     See project_flat_day_bullish_trap.md for the framing.\n`);
} else {
  console.log(`  Next steps for each promising candidate:`);
  console.log(`    1. Edit the corresponding filter in src/strategies/<ticker>.ts`);
  console.log(`    2. Run: npx tsx src/scripts/validate-change.ts ${START} ${END} ${TICKER}`);
  console.log(`    3. If MERGE verdict → commit. If REVERT → try next candidate.\n`);
  console.log(`  Ranking uses 'adj' (adjustedScore = discrimScore × (1 - cascadeRisk)).`);
  console.log(`  cascadeRisk = 0.5×HCO-share + 0.5×multiDay-share. High cascade = predicted`);
  console.log(`  Δexp tends to be wiped out by F-biased replacement entries when blocked`);
  console.log(`  signals free a position slot. Prefer low-cascade candidates first.\n`);
}
