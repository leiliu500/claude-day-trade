#!/usr/bin/env npx tsx
/**
 * validate-change.ts — Automated baseline vs candidate comparison for filter/gate changes.
 *
 * Runs backtest-signal-quality.ts twice:
 *   1. BASELINE — working tree stashed → HEAD
 *   2. CANDIDATE — stash popped → your uncommitted changes
 *
 * Outputs a side-by-side comparison table with grade-weighted expectancy delta,
 * direction accuracy delta, monthly breakdown, and a MERGE / REVERT / INCONCLUSIVE
 * verdict based on rules encoded from the batched-validation feedback memory.
 *
 * Usage:
 *   npx tsx src/scripts/validate-change.ts [START] [END] [TICKER]
 *   npx tsx src/scripts/validate-change.ts 2026-01-02 2026-04-17 SPY
 *
 * Pre-conditions:
 *   - Git working tree must have uncommitted changes (the candidate to test)
 *   - `tsc --noEmit` must pass on the candidate
 *
 * Phase auto-cache:
 *   Both phases are cached under .validate-cache/ keyed by the SHA1 content hash
 *   of the watched paths (STASH_PATHS) plus window + ticker.
 *     - BASELINE  keyed by HEAD's tree hash of STASH_PATHS (invalidates on commit)
 *     - CANDIDATE keyed by the working-tree content hash of STASH_PATHS
 *   Reruns with unchanged code skip the corresponding phase entirely. When the
 *   candidate hash equals the baseline hash (no effective change), the candidate
 *   phase is served from the baseline cache — no second backtest runs.
 *   Pass --no-cache to force both phases to run. An explicit --baseline-json=
 *   still takes precedence over the auto-cache for the baseline slot.
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join as pathJoin } from 'path';
import { createHash } from 'crypto';

const concurrencyFlag = process.argv.find(a => a.startsWith('--concurrency='));
const CONCURRENCY = concurrencyFlag ? Math.max(1, parseInt(concurrencyFlag.split('=')[1]!, 10)) : 8;
const baselineJsonFlag = process.argv.find(a => a.startsWith('--baseline-json='));
const BASELINE_JSON_PATH = baselineJsonFlag ? baselineJsonFlag.split('=')[1]! : undefined;
const writeBaselineFlag = process.argv.find(a => a.startsWith('--write-baseline-json='));
const WRITE_BASELINE_JSON_PATH = writeBaselineFlag ? writeBaselineFlag.split('=')[1]! : undefined;
const NO_CACHE = process.argv.includes('--no-cache');
const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const START = positionalArgs[0] || '2026-01-02';
const END = positionalArgs[1] || '2026-04-17';
const TICKER = (positionalArgs[2] || 'SPY').toUpperCase();

const AUTO_CACHE_DIR = '.validate-cache';

// Verdict thresholds — tunable, keep conservative
const EXPECTANCY_DELTA_MERGE = 0.02;        // need +0.02 expectancy gain to merge
const MONTHLY_REGRESSION_LIMIT = -0.15;     // no month expectancy can drop by more than this
const DIRECTION_REGRESSION_LIMIT = -0.02;   // direction accuracy can't drop by more than 2pp

interface TickerSummary {
  ticker: string;
  tradingDays: number;
  totalEntries: number;
  directionAccuracy: number;
  avgMfe: number;
  avgMae: number;
  grades: { A: number; B: number; C: number; D: number; F: number };
  expectancy: number;
  byMonth: Array<{
    month: string;
    entries: number;
    grades: { A: number; B: number; C: number; D: number; F: number };
    directionAccuracy: number;
    expectancy: number;
  }>;
  entries: Array<{ date: string; grade: 'A' | 'B' | 'C' | 'D' | 'F' | '?' }>;
}

// ── Bootstrap significance on Δexpectancy ────────────────────────────────────
// Resample both populations with replacement 2000× and compute the CI on
// candidate_expectancy - baseline_expectancy. If the 95% CI includes zero,
// the observed delta is within sampling noise and should not be trusted.
// If CI lower bound > 0, the filter delivers a statistically significant gain.
const GRADE_SCORE: Record<string, number> = { A: 2, B: 1, C: 0, D: -1, F: -2 };

function expOfGrades(grades: readonly string[]): number {
  if (grades.length === 0) return 0;
  let s = 0;
  for (const g of grades) s += GRADE_SCORE[g] ?? 0;
  return s / grades.length;
}

function bootstrapDeltaCI(
  baseGrades: readonly string[],
  candGrades: readonly string[],
  iters = 2000,
): { p5: number; p50: number; p95: number; probPositive: number } {
  if (baseGrades.length === 0 || candGrades.length === 0) {
    return { p5: 0, p50: 0, p95: 0, probPositive: 0 };
  }
  const deltas: number[] = new Array(iters);
  const bN = baseGrades.length, cN = candGrades.length;
  for (let i = 0; i < iters; i++) {
    let bSum = 0;
    for (let j = 0; j < bN; j++) bSum += GRADE_SCORE[baseGrades[(Math.random() * bN) | 0]!] ?? 0;
    let cSum = 0;
    for (let j = 0; j < cN; j++) cSum += GRADE_SCORE[candGrades[(Math.random() * cN) | 0]!] ?? 0;
    deltas[i] = (cSum / cN) - (bSum / bN);
  }
  deltas.sort((a, b) => a - b);
  const p5 = deltas[Math.floor(iters * 0.025)]!;
  const p50 = deltas[Math.floor(iters * 0.5)]!;
  const p95 = deltas[Math.floor(iters * 0.975)]!;
  const probPositive = deltas.filter(d => d > 0).length / iters;
  return { p5, p50, p95, probPositive };
}

function sh(cmd: string, opts: Record<string, unknown> = {}): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}

// Only stash paths that actually affect backtest behavior — the harness and
// signal-quality script live in src/scripts/ and must remain present in both
// baseline and candidate runs.
const STASH_PATHS = [
  'src/strategies/', 'src/lib/', 'src/agents/',
  'src/types/', 'src/ticker-configs.ts',
  'src/scripts/backtest-day.ts', 'src/scripts/backtest-configs/',
];

function hasCandidateChanges(): boolean {
  const status = sh(`git status --porcelain -- ${STASH_PATHS.join(' ')}`).trim();
  return status.length > 0;
}

// Content-hash helpers — cache key is the SHA1 of the watched paths' content.
// BASELINE runs against HEAD's STASH_PATHS tree.
// CANDIDATE runs against the working-tree content of STASH_PATHS (tracked + untracked).
// If the two hashes are equal (candidate === HEAD), the candidate phase can be
// served from the baseline cache — no duplicate backtest runs.
function hashStashPathsAtHead(): string {
  // git ls-tree -r lists every file in HEAD under these paths with its blob SHA.
  const out = sh(`git ls-tree -r HEAD -- ${STASH_PATHS.join(' ')}`);
  return createHash('sha1').update(out).digest('hex').slice(0, 12);
}

function hashStashPathsInWorkingTree(): string {
  // Tracked + untracked (-c -o) under STASH_PATHS, respecting .gitignore.
  // Hash file path + content so renames and content changes both invalidate.
  const files = sh(`git ls-files -c -o --exclude-standard -- ${STASH_PATHS.join(' ')}`)
    .trim().split('\n').filter(Boolean).sort();
  const h = createHash('sha1');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    try { h.update(readFileSync(f)); } catch { /* deleted file — just record the path */ }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

function cachePathFor(hash: string): string {
  return pathJoin(AUTO_CACHE_DIR, `backtest-${TICKER}-${START}-${END}-${hash}.json`);
}

function loadCached(path: string): TickerSummary | null {
  try {
    const t = JSON.parse(readFileSync(path, 'utf-8')) as TickerSummary;
    if (t.ticker !== TICKER) return null;
    return t;
  } catch {
    return null;
  }
}

function saveCached(path: string, t: TickerSummary): void {
  mkdirSync(AUTO_CACHE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(t));
}

// Prune stale cache files for the current {ticker, window}: anything not in
// `keepHashes` (current baseline + candidate) is removed. Other windows are
// untouched. Keeps .validate-cache/ bounded at ≤2 files per active window.
function pruneStaleCaches(keepHashes: ReadonlyArray<string>): number {
  if (!existsSync(AUTO_CACHE_DIR)) return 0;
  const prefix = `backtest-${TICKER}-${START}-${END}-`;
  let removed = 0;
  for (const f of readdirSync(AUTO_CACHE_DIR)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    const hash = f.slice(prefix.length, -'.json'.length);
    if (keepHashes.includes(hash)) continue;
    try { unlinkSync(pathJoin(AUTO_CACHE_DIR, f)); removed++; } catch { /* ignore */ }
  }
  return removed;
}

function runBacktest(label: string): TickerSummary {
  console.log(`\n[${label}] Running backtest ${START} → ${END} ${TICKER} (${CONCURRENCY} workers)...`);
  const startTs = Date.now();
  const out = sh(
    `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json --concurrency=${CONCURRENCY}`,
    { timeout: 60 * 60 * 1000 }, // 60 min max
  );
  const secs = ((Date.now() - startTs) / 1000).toFixed(0);
  const match = out.match(/<!--VALIDATE-JSON-BEGIN-->\n(.+?)\n<!--VALIDATE-JSON-END-->/s);
  if (!match) throw new Error(`[${label}] JSON block not found in backtest output`);
  const parsed = JSON.parse(match[1]);
  const t = parsed.perTicker.find((p: TickerSummary) => p.ticker === TICKER);
  if (!t) throw new Error(`[${label}] ticker ${TICKER} not in output`);
  console.log(`[${label}] ✓ ${t.totalEntries} entries, expectancy ${t.expectancy.toFixed(3)}, ${secs}s`);
  return t;
}

function fmtGrades(g: { A: number; B: number; C: number; D: number; F: number }): string {
  return `${g.A}A/${g.B}B/${g.C}C/${g.D}D/${g.F}F`;
}

function fmtDelta(delta: number, digits = 3, suffix = ''): string {
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(digits)}${suffix}`;
}

// ── Walk-forward stability check ─────────────────────────────────────────────
// Split the window into month chunks (using the existing date field on each
// entry). For each chunk, bootstrap-CI the baseline vs candidate delta. A
// robust filter should show same-direction delta across chunks. Would have
// flagged MACD filter (Dec −0.204 outlier) and VWAP filter (Oct regression)
// even without an explicit OOS re-run.
function groupByMonth(entries: TickerSummary['entries']): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of entries) {
    const month = (e.date ?? '?').slice(0, 7);
    let arr = m.get(month);
    if (!arr) { arr = []; m.set(month, arr); }
    arr.push(e.grade);
  }
  return m;
}

function printWalkForward(base: TickerSummary, cand: TickerSummary): void {
  const bMonths = groupByMonth(base.entries);
  const cMonths = groupByMonth(cand.entries);
  const allMonths = [...new Set([...bMonths.keys(), ...cMonths.keys()])].sort();

  console.log(`\n  ── Walk-forward per-month stability ──`);
  console.log(`     ${'Month'.padEnd(10)} ${'ΔExp'.padStart(8)}  ${'95% CI'.padStart(20)}  ${'P(Δ>0)'.padStart(7)}  ${'N(b→c)'.padStart(9)}`);
  console.log(`     ${'-'.repeat(62)}`);

  let agreeing = 0, disagreeing = 0, neutralChunks = 0;
  const observedSign = Math.sign(cand.expectancy - base.expectancy);

  for (const m of allMonths) {
    const bg = bMonths.get(m) ?? [];
    const cg = cMonths.get(m) ?? [];
    if (bg.length < 3 || cg.length < 3) {
      console.log(`     ${m.padEnd(10)} ${'—'.padStart(8)}  ${'N too small'.padStart(20)}  ${'—'.padStart(7)}  ${`${bg.length}→${cg.length}`.padStart(9)}`);
      continue;
    }
    const obs = expOfGrades(cg) - expOfGrades(bg);
    const ci = bootstrapDeltaCI(bg, cg, 1000);
    const ciStr = `[${fmtDelta(ci.p5, 2)}, ${fmtDelta(ci.p95, 2)}]`;
    let marker = ' ';
    if (Math.sign(obs) === observedSign) agreeing++;
    else if (Math.sign(obs) !== 0 && observedSign !== 0) { disagreeing++; marker = '✗'; }
    else neutralChunks++;
    console.log(`    ${marker}${m.padEnd(10)} ${fmtDelta(obs).padStart(8)}  ${ciStr.padStart(20)}  ${(ci.probPositive * 100).toFixed(0).padStart(6)}%  ${`${bg.length}→${cg.length}`.padStart(9)}`);
  }

  const totalScored = agreeing + disagreeing;
  console.log(`     ${'-'.repeat(62)}`);
  if (totalScored === 0) {
    console.log(`     ⚠ No chunks had enough data to assess`);
  } else if (disagreeing === 0) {
    console.log(`     ✓ All ${agreeing} scored chunks agree with overall direction — robust across time`);
  } else {
    console.log(`     ⚠ ${disagreeing}/${totalScored} chunks disagree with overall direction — filter may be fitting specific months`);
  }
}

function printBootstrapCI(base: TickerSummary, cand: TickerSummary): void {
  const baseGrades = base.entries.map(e => e.grade);
  const candGrades = cand.entries.map(e => e.grade);
  const ci = bootstrapDeltaCI(baseGrades, candGrades);
  const observedDelta = cand.expectancy - base.expectancy;
  console.log(`\n  ── Bootstrap Δexpectancy 95% CI (${baseGrades.length}→${candGrades.length} entries, 2000 iters) ──`);
  console.log(`     Observed:   ${fmtDelta(observedDelta)}`);
  console.log(`     95% CI:     [${fmtDelta(ci.p5)}, ${fmtDelta(ci.p95)}]  median ${fmtDelta(ci.p50)}`);
  console.log(`     P(Δ > 0):   ${(ci.probPositive * 100).toFixed(1)}%`);
  if (ci.p5 > 0) {
    console.log(`     ✓ CI entirely > 0 — improvement is statistically significant`);
  } else if (ci.p95 < 0) {
    console.log(`     ✗ CI entirely < 0 — regression is statistically significant`);
  } else {
    console.log(`     ⚠ CI spans zero — observed delta is within sampling noise`);
  }
}

function printComparison(base: TickerSummary, cand: TickerSummary): void {
  const rows = [
    ['Entries', String(base.totalEntries), String(cand.totalEntries), fmtDelta(cand.totalEntries - base.totalEntries, 0)],
    ['Grades', fmtGrades(base.grades), fmtGrades(cand.grades), '—'],
    ['Direction accuracy', `${(base.directionAccuracy * 100).toFixed(1)}%`, `${(cand.directionAccuracy * 100).toFixed(1)}%`, fmtDelta((cand.directionAccuracy - base.directionAccuracy) * 100, 1, 'pp')],
    ['Bad rate (F/N)', base.totalEntries ? `${((base.grades.F / base.totalEntries) * 100).toFixed(1)}%` : '—', cand.totalEntries ? `${((cand.grades.F / cand.totalEntries) * 100).toFixed(1)}%` : '—', fmtDelta(((cand.grades.F / Math.max(1, cand.totalEntries)) - (base.grades.F / Math.max(1, base.totalEntries))) * 100, 1, 'pp')],
    ['Avg MFE', `${base.avgMfe.toFixed(3)}%`, `${cand.avgMfe.toFixed(3)}%`, fmtDelta(cand.avgMfe - base.avgMfe, 3, '%')],
    ['Avg MAE', `${base.avgMae.toFixed(3)}%`, `${cand.avgMae.toFixed(3)}%`, fmtDelta(cand.avgMae - base.avgMae, 3, '%')],
    ['Expectancy', fmtDelta(base.expectancy), fmtDelta(cand.expectancy), fmtDelta(cand.expectancy - base.expectancy)],
  ];
  const colWidths = [22, 20, 20, 14];
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  COMPARISON: ${TICKER} ${START} → ${END}`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`  ${pad('Metric', colWidths[0]!)} ${pad('Baseline', colWidths[1]!)} ${pad('Candidate', colWidths[2]!)} ${pad('Delta', colWidths[3]!)}`);
  console.log(`  ${'-'.repeat(78)}`);
  for (const r of rows) {
    console.log(`  ${pad(r[0]!, colWidths[0]!)} ${pad(r[1]!, colWidths[1]!)} ${pad(r[2]!, colWidths[2]!)} ${pad(r[3]!, colWidths[3]!)}`);
  }
}

function printMonthlyBreakdown(base: TickerSummary, cand: TickerSummary): void {
  console.log(`\n  ── Monthly Breakdown ──\n`);
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(`  ${pad('Month', 10)} ${pad('Base Exp', 10)} ${pad('Cand Exp', 10)} ${pad('Δ Exp', 10)} ${pad('Base Grd', 18)} ${pad('Cand Grd', 18)}`);
  console.log(`  ${'-'.repeat(76)}`);
  const months = [...new Set([...base.byMonth.map(m => m.month), ...cand.byMonth.map(m => m.month)])].sort();
  for (const m of months) {
    const b = base.byMonth.find(x => x.month === m);
    const c = cand.byMonth.find(x => x.month === m);
    const bExp = b ? fmtDelta(b.expectancy) : '—';
    const cExp = c ? fmtDelta(c.expectancy) : '—';
    const dExp = (b && c) ? fmtDelta(c.expectancy - b.expectancy) : '—';
    const bGrd = b ? fmtGrades(b.grades) : '—';
    const cGrd = c ? fmtGrades(c.grades) : '—';
    console.log(`  ${pad(m, 10)} ${pad(bExp, 10)} ${pad(cExp, 10)} ${pad(dExp, 10)} ${pad(bGrd, 18)} ${pad(cGrd, 18)}`);
  }
}

interface Verdict {
  decision: 'MERGE' | 'REVERT' | 'INCONCLUSIVE';
  reasons: string[];
}

const MIN_TRADING_DAYS_FOR_MERGE = 60; // feedback memory: ≥quarter for MERGE verdict

function verdict(base: TickerSummary, cand: TickerSummary): Verdict {
  const reasons: string[] = [];
  const expDelta = cand.expectancy - base.expectancy;
  const dirDelta = cand.directionAccuracy - base.directionAccuracy;
  const tooShort = base.tradingDays < MIN_TRADING_DAYS_FOR_MERGE;

  const months = [...new Set([...base.byMonth.map(m => m.month), ...cand.byMonth.map(m => m.month)])].sort();
  const monthlyRegressions: Array<{ month: string; delta: number }> = [];
  for (const m of months) {
    const b = base.byMonth.find(x => x.month === m);
    const c = cand.byMonth.find(x => x.month === m);
    if (!b || !c || b.entries === 0 || c.entries === 0) continue;
    const delta = c.expectancy - b.expectancy;
    if (delta < MONTHLY_REGRESSION_LIMIT) monthlyRegressions.push({ month: m, delta });
  }

  // Hard REVERT conditions
  if (expDelta < 0) {
    reasons.push(`Overall expectancy regressed (${fmtDelta(expDelta)})`);
    return { decision: 'REVERT', reasons };
  }
  if (dirDelta < DIRECTION_REGRESSION_LIMIT) {
    reasons.push(`Direction accuracy dropped ${fmtDelta(dirDelta * 100, 1, 'pp')} (limit ${(DIRECTION_REGRESSION_LIMIT * 100).toFixed(1)}pp)`);
    return { decision: 'REVERT', reasons };
  }
  if (monthlyRegressions.length > 0) {
    reasons.push(`${monthlyRegressions.length} month(s) regressed severely: ${monthlyRegressions.map(m => `${m.month} ${fmtDelta(m.delta)}`).join(', ')}`);
    return { decision: 'REVERT', reasons };
  }

  // MERGE conditions — require sufficient range to avoid cherry-picked-window traps
  if (expDelta >= EXPECTANCY_DELTA_MERGE && dirDelta >= 0) {
    if (tooShort) {
      reasons.push(`Expectancy improved ${fmtDelta(expDelta)} AND direction ${fmtDelta(dirDelta * 100, 1, 'pp')} — promising`);
      reasons.push(`But ${base.tradingDays} trading days < ${MIN_TRADING_DAYS_FOR_MERGE} min for MERGE verdict (see project_flat_day_bullish_trap.md: Apr 1-17 looked +14× but Jan-Apr was ~0)`);
      reasons.push('Re-run with a wider date range (≥60 trading days, ideally quarter+) before merging');
      return { decision: 'INCONCLUSIVE', reasons };
    }
    reasons.push(`Expectancy improved ${fmtDelta(expDelta)} (≥ merge threshold ${EXPECTANCY_DELTA_MERGE})`);
    reasons.push(`Direction accuracy ${fmtDelta(dirDelta * 100, 1, 'pp')} (not worse)`);
    reasons.push(`No month regressed by more than ${MONTHLY_REGRESSION_LIMIT.toFixed(2)}`);
    return { decision: 'MERGE', reasons };
  }

  // INCONCLUSIVE
  reasons.push(`Expectancy delta ${fmtDelta(expDelta)} below merge threshold ${EXPECTANCY_DELTA_MERGE}`);
  reasons.push(`Direction accuracy ${fmtDelta(dirDelta * 100, 1, 'pp')}`);
  reasons.push('Change is neither clearly positive nor clearly negative — human review required');
  return { decision: 'INCONCLUSIVE', reasons };
}

function printVerdict(v: Verdict): void {
  const icon = v.decision === 'MERGE' ? '✅' : v.decision === 'REVERT' ? '❌' : '⚠️';
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${icon} VERDICT: ${v.decision}`);
  console.log(`${'='.repeat(80)}`);
  for (const r of v.reasons) console.log(`  • ${r}`);
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  // --write-baseline-json mode: just capture baseline at HEAD (no candidate diff required)
  if (WRITE_BASELINE_JSON_PATH) {
    console.log(`📸 Capturing baseline ${TICKER} ${START} → ${END} → ${WRITE_BASELINE_JSON_PATH}`);
    const baseline = runBacktest('BASELINE');
    writeFileSync(WRITE_BASELINE_JSON_PATH, JSON.stringify(baseline));
    console.log(`✓ baseline written (${baseline.totalEntries} entries, exp ${baseline.expectancy.toFixed(3)})`);
    return 0;
  }

  if (!hasCandidateChanges()) {
    console.error('❌ No candidate changes in watched paths. Edit one of:');
    for (const p of STASH_PATHS) console.error(`     ${p}`);
    return 1;
  }

  console.log(`🔍 Validate-change: ${TICKER} ${START} → ${END} (${CONCURRENCY} workers/phase)`);
  console.log(`\nCandidate diff (watched paths only):`);
  console.log(sh(`git diff --stat -- ${STASH_PATHS.join(' ')}`).split('\n').map(l => `   ${l}`).join('\n'));

  // Type-check candidate first
  console.log(`\n[PRECHECK] tsc --noEmit ...`);
  try {
    sh('./node_modules/.bin/tsc --noEmit', { timeout: 180_000 });
    console.log(`[PRECHECK] ✓ typecheck passed`);
  } catch (err: any) {
    console.error(`[PRECHECK] ❌ typecheck failed:`);
    console.error(err.stdout?.toString() || err.message);
    return 1;
  }

  // Compute content hashes so both phases can be cached / shared
  const baselineHash = !BASELINE_JSON_PATH && !NO_CACHE ? hashStashPathsAtHead() : undefined;
  const candidateHash = !NO_CACHE ? hashStashPathsInWorkingTree() : undefined;
  const baselineCachePath = baselineHash ? cachePathFor(baselineHash) : undefined;
  const candidateCachePath = candidateHash ? cachePathFor(candidateHash) : undefined;

  if (baselineHash && candidateHash) {
    console.log(`\n[CACHE] baseline content hash: ${baselineHash}`);
    console.log(`[CACHE] candidate content hash: ${candidateHash}`);
    if (baselineHash === candidateHash) {
      console.log(`[CACHE] ⚠  candidate bytes identical to HEAD — both phases share one backtest`);
    }
  }

  // Baseline: load from explicit path OR auto-cache OR stash+run+save
  let baseline: TickerSummary;
  let candidate: TickerSummary;
  let stashed = false;
  try {
    if (BASELINE_JSON_PATH) {
      if (!existsSync(BASELINE_JSON_PATH)) {
        console.error(`❌ --baseline-json file not found: ${BASELINE_JSON_PATH}`);
        return 1;
      }
      const loaded = loadCached(BASELINE_JSON_PATH);
      if (!loaded) {
        console.error(`❌ baseline-json file invalid or ticker mismatch for ${TICKER}`);
        return 1;
      }
      baseline = loaded;
      console.log(`[BASELINE] ✓ loaded from --baseline-json: ${baseline.totalEntries} entries, exp ${baseline.expectancy.toFixed(3)}`);
    } else if (baselineCachePath && existsSync(baselineCachePath)) {
      const loaded = loadCached(baselineCachePath);
      if (!loaded) {
        console.error(`❌ auto-cache file invalid — delete ${baselineCachePath} and retry`);
        return 1;
      }
      baseline = loaded;
      console.log(`[BASELINE] ✓ auto-cache hit (HEAD content unchanged) — skipping baseline phase`);
      console.log(`[BASELINE]   ${baselineCachePath}`);
      console.log(`[BASELINE]   ${baseline.totalEntries} entries, exp ${baseline.expectancy.toFixed(3)}`);
    } else {
      if (baselineCachePath) console.log(`[BASELINE] auto-cache miss — running baseline (will cache to ${baselineCachePath})`);
      sh(`git stash push -u -m validate-change-tmp -- ${STASH_PATHS.join(' ')}`);
      stashed = true;
      console.log(`[STASH] ✓ candidate stashed (${STASH_PATHS.length} watched paths)`);
      baseline = runBacktest('BASELINE');
      sh('git stash pop');
      stashed = false;
      console.log('[STASH] ✓ candidate restored');
      if (baselineCachePath) {
        saveCached(baselineCachePath, baseline);
        console.log(`[BASELINE] ✓ cached for future reruns at this HEAD content`);
      }
    }

    // Candidate: same content hash as baseline? reuse. Else check cache. Else run.
    if (candidateCachePath && existsSync(candidateCachePath)) {
      const loaded = loadCached(candidateCachePath);
      if (!loaded) {
        console.error(`❌ auto-cache file invalid — delete ${candidateCachePath} and retry`);
        return 1;
      }
      candidate = loaded;
      const why = (baselineHash && candidateHash && baselineHash === candidateHash)
        ? 'candidate bytes identical to HEAD — reusing baseline result'
        : 'working-tree content unchanged from a prior run';
      console.log(`[CANDIDATE] ✓ auto-cache hit (${why}) — skipping candidate phase`);
      console.log(`[CANDIDATE]   ${candidateCachePath}`);
      console.log(`[CANDIDATE]   ${candidate.totalEntries} entries, exp ${candidate.expectancy.toFixed(3)}`);
    } else {
      if (candidateCachePath) console.log(`[CANDIDATE] auto-cache miss — running candidate (will cache to ${candidateCachePath})`);
      candidate = runBacktest('CANDIDATE');
      if (candidateCachePath) {
        saveCached(candidateCachePath, candidate);
        console.log(`[CANDIDATE] ✓ cached for future reruns at this working-tree content`);
      }
    }

    // Prune stale caches for this window so the dir doesn't grow per commit.
    if (!NO_CACHE) {
      const keep = [baselineHash, candidateHash].filter((h): h is string => !!h);
      const removed = pruneStaleCaches(keep);
      if (removed > 0) console.log(`[CACHE] pruned ${removed} stale cache file(s) for ${TICKER} ${START}→${END}`);
    }

    printComparison(baseline, candidate);
    printMonthlyBreakdown(baseline, candidate);
    printBootstrapCI(baseline, candidate);
    printWalkForward(baseline, candidate);
    const v = verdict(baseline, candidate);
    printVerdict(v);

    return v.decision === 'REVERT' ? 2 : 0;
  } catch (err: any) {
    console.error(`\n❌ Validation failed: ${err.message}`);
    if (stashed) {
      console.error('⚠️  Attempting to restore stash...');
      try { sh('git stash pop'); console.error('✓ stash restored'); }
      catch (e: any) { console.error(`❌ stash pop failed: ${e.message} — inspect manually with \`git stash list\``); }
    }
    return 1;
  }
}

main().then(process.exit);
