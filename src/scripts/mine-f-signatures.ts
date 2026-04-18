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

const TOP_N = 10;            // report top-10 candidates per category
const MIN_F_BLOCKED = 3;     // candidate must block at least 3 F-grade entries to be interesting
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
  /** Expectancy of blocked set — negative score means we'd be blocking good entries. */
  blockedExpectancy: number;
  /** Net gain when rule is added = -blockedExpectancy × (blocked/total_entries).
   *  Positive = rule helps (blocks more bad than good). */
  netScore: number;
}

function statsForBlocked(blocked: MinedEntry[], totalEntries: number): BlockedStats {
  const count = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const e of blocked) count[e.grade]++;
  const blockedExpectancy = blocked.length > 0
    ? (count.A * 2 + count.B - count.D - count.F * 2) / blocked.length
    : 0;
  // Net gain to overall expectancy when this rule is applied:
  // original_expectancy * N = sum_of_grade_scores
  // after: (sum - blocked_sum) / (N - blocked)
  // delta ≈ (blocked.length × -blockedExpectancy) / (N - blocked.length)
  // Simpler: score = -(sum of blocked grade scores). Higher = better.
  const blockedSumScore = count.A * 2 + count.B - count.D - count.F * 2;
  return {
    total: blocked.length,
    ...count,
    blockedExpectancy,
    netScore: -blockedSumScore, // remove negatives → positive netScore
  };
}

function fmtStats(s: BlockedStats): string {
  return `blocks ${s.total} (${s.A}A/${s.B}B/${s.C}C/${s.D}D/${s.F}F)  score=${s.netScore >= 0 ? '+' : ''}${s.netScore}`;
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
      if (blocked.filter(e => e.grade === 'F').length < MIN_F_BLOCKED) continue;
      const stats = statsForBlocked(blocked, entries.length);
      if (stats.netScore <= 0) continue; // only keep net-positive candidates
      out.push({ indicator: String(indicator), op, threshold: t, stats });
    }
  }
  return out.sort((a, b) => b.stats.netScore - a.stats.netScore);
}

// ── Two-indicator AND-rule scan ─────────────────────────────────────────────
interface PairCandidate {
  a: ThresholdCandidate;
  b: ThresholdCandidate;
  stats: BlockedStats;
}

function scanPairs(
  entries: MinedEntry[],
  singles: ThresholdCandidate[],
  maxPairs = 200,
): PairCandidate[] {
  const out: PairCandidate[] = [];
  const top = singles.slice(0, 30); // only combine top-30 singles to keep O(n²) tractable
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
      if (blocked.filter(e => e.grade === 'F').length < MIN_F_BLOCKED) continue;
      const stats = statsForBlocked(blocked, entries.length);
      if (stats.netScore <= a.stats.netScore) continue; // pair must beat individual rule A
      if (stats.netScore <= b.stats.netScore) continue; // and rule B
      out.push({ a, b, stats });
    }
  }
  return out.sort((a, b) => b.stats.netScore - a.stats.netScore).slice(0, maxPairs);
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
].sort((a, b) => b.stats.netScore - a.stats.netScore);

console.log(`\n  ── Top ${TOP_N} Single-Indicator Candidates ──\n`);
for (const c of singles.slice(0, TOP_N)) {
  console.log(`  ${c.indicator} ${c.op} ${c.threshold}  →  ${fmtStats(c.stats)}`);
}

// ── Pair scans ──
console.log(`\n  ── Top ${TOP_N} Two-Indicator AND-Rule Candidates ──\n`);
const pairs = scanPairs(entries, singles);
for (const p of pairs.slice(0, TOP_N)) {
  const rule = `${p.a.indicator} ${p.a.op} ${p.a.threshold} AND ${p.b.indicator} ${p.b.op} ${p.b.threshold}`;
  console.log(`  ${rule}  →  ${fmtStats(p.stats)}`);
}

// ── Next steps ──
console.log(`\n  ── Next Steps ──\n`);
console.log(`  For each promising candidate above:`);
console.log(`    1. Edit the corresponding filter in src/strategies/<ticker>.ts`);
console.log(`    2. Run: npx tsx src/scripts/validate-change.ts ${START} ${END} ${TICKER}`);
console.log(`    3. If MERGE verdict → commit. If REVERT → try next candidate.\n`);
console.log(`  Note: mined rules use the baseline population's indicator distributions.`);
console.log(`  Actual effect in validate-change may differ due to cooldown/gate reshuffling.\n`);
