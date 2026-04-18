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
 */

import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2026-01-02';
const END = process.argv[3] || '2026-04-17';
const TICKER = (process.argv[4] || 'SPY').toUpperCase();

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
}

function sh(cmd: string, opts: Record<string, unknown> = {}): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
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

function runBacktest(label: string): TickerSummary {
  console.log(`\n[${label}] Running backtest ${START} → ${END} ${TICKER}...`);
  const startTs = Date.now();
  const out = sh(
    `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json`,
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
  if (!hasCandidateChanges()) {
    console.error('❌ No candidate changes in watched paths. Edit one of:');
    for (const p of STASH_PATHS) console.error(`     ${p}`);
    return 1;
  }

  console.log(`🔍 Validate-change: ${TICKER} ${START} → ${END}`);
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

  // Stash candidate → run baseline → pop → run candidate
  let stashed = false;
  try {
    sh(`git stash push -u -m validate-change-tmp -- ${STASH_PATHS.join(' ')}`);
    stashed = true;
    console.log(`[STASH] ✓ candidate stashed (${STASH_PATHS.length} watched paths)`);

    const baseline = runBacktest('BASELINE');
    sh('git stash pop');
    stashed = false;
    console.log('[STASH] ✓ candidate restored');

    const candidate = runBacktest('CANDIDATE');

    printComparison(baseline, candidate);
    printMonthlyBreakdown(baseline, candidate);
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
