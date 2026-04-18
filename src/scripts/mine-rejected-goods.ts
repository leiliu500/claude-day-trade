#!/usr/bin/env npx tsx
/**
 * mine-rejected-goods.ts — Find entry filters / gate paths that are rejecting
 * high-grade entries.
 *
 * Reads the same aggregate JSON that mine-f-signatures consumes (produced by
 * `backtest-signal-quality.ts --json`). Each rejection already carries a grade
 * computed from forward MFE/MAE, so we can directly score filter rules by the
 * quality of entries they blocked.
 *
 * Two buckets are aggregated:
 *   - filtered: rejected by `shouldAllowEntry` (groups by filterRule)
 *   - blocked:  rejected by the confirmation gate (groups by gate result)
 *
 * Rules are ranked by "cost score" = 2A + B - D - 2F of rejected entries:
 *   positive cost → rule is blocking net-positive grade signals (candidate to
 *                   relax or remove)
 *   negative cost → rule is correctly removing net-negative signals (leave alone)
 *
 * Usage:
 *   npx tsx src/scripts/mine-rejected-goods.ts [START] [END] [TICKER] [--cache <file.json>]
 *   npx tsx src/scripts/mine-rejected-goods.ts 2026-01-02 2026-04-18 SPY --cache /tmp/mine-after-filter.json
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const getFlag = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const START = positional[0] || '2026-01-02';
const END = positional[1] || '2026-04-18';
const TICKER = (positional[2] || 'SPY').toUpperCase();
const CACHE_PATH = getFlag('--cache');

const TOP_N = 15;
const MIN_BLOCKED = 3;
// Cluster window for dedup-awareness: entries on the same date + same direction
// within this many minutes of each other are treated as competing for ONE position
// slot. Realization rate for each clustered entry = 1 / cluster_size.
// Calibrated from 2026-04-18 validate run: removing `breakout rangeExh < 1.0`
// blocked 33 entries (10 at 13:30 UTC bullish + 3 at 13:35 etc.) → predicted +23
// cost, actual +1 entry admitted. Tight same-minute clustering collapses to ~1.
const CLUSTER_WINDOW_MIN = 15;

interface RejectedEntry {
  date?: string;
  time: string;
  direction: string;
  mode: string;
  confidence: number;
  grade: string;
  outcome: string;
  mfePct: number;
  maePct: number;
  filterRule?: string;
  filterCategory?: string;
  gate?: string;
}

interface BacktestJson {
  perTicker: Array<{
    ticker: string;
    totalEntries: number;
    grades: { A: number; B: number; C: number; D: number; F: number };
    expectancy: number;
    filtered?: RejectedEntry[];
    blocked?: RejectedEntry[];
  }>;
}

function loadJson(): BacktestJson {
  if (CACHE_PATH && existsSync(CACHE_PATH)) {
    console.log(`[cache] Reading ${CACHE_PATH}`);
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  }
  console.log(`[backtest] Running ${START} → ${END} ${TICKER} (a few minutes)`);
  const out = execSync(
    `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60 * 60 * 1000 },
  );
  const m = out.match(/<!--VALIDATE-JSON-BEGIN-->\n(.+?)\n<!--VALIDATE-JSON-END-->/s);
  if (!m) throw new Error('JSON block not found in backtest output');
  if (CACHE_PATH) {
    writeFileSync(CACHE_PATH, m[1]!);
    console.log(`[cache] Wrote ${CACHE_PATH}`);
  }
  return JSON.parse(m[1]!);
}

interface RuleBucket {
  stage: 'filter' | 'gate';
  category: string;
  rule: string;
  entries: RejectedEntry[];
  A: number; B: number; C: number; D: number; F: number; unknown: number;
  costScore: number;              // raw grade-weighted cost of rejections
  abShare: number;
  avgMfe: number;
  avgRealization: number;         // mean realization rate (1/cluster_size) for rule's entries
  adjustedCost: number;           // costScore weighted by realization (predicts actual Δscore)
}

const GRADE_SCORE: Record<string, number> = { A: 2, B: 1, C: 0, D: -1, F: -2 };

/** Parse an ISO timestamp or "HH:MM" string into minutes since UTC midnight.
 *  Returns NaN if the input isn't recognizable. */
function toMinutes(s: string | undefined): number {
  if (!s) return NaN;
  if (s.length >= 16 && s[10] === 'T') {
    const h = parseInt(s.slice(11, 13), 10);
    const m = parseInt(s.slice(14, 16), 10);
    return h * 60 + m;
  }
  if (/^\d{2}:\d{2}$/.test(s)) return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  return NaN;
}

/** For each rejected entry, compute how many other rejections share its
 *  (date, direction) within CLUSTER_WINDOW_MIN minutes — those entries compete
 *  for a single position slot, so realization rate ≈ 1 / cluster_size. */
function computeRealizationRates(all: RejectedEntry[]): Map<RejectedEntry, number> {
  // Group by date+direction for efficient cluster search
  const groups = new Map<string, RejectedEntry[]>();
  for (const e of all) {
    const key = `${e.date ?? '?'}|${e.direction}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(e);
  }
  const rates = new Map<RejectedEntry, number>();
  for (const arr of groups.values()) {
    const withMin = arr.map(e => ({ e, mins: toMinutes(e.time) }))
      .filter(x => !Number.isNaN(x.mins))
      .sort((a, b) => a.mins - b.mins);
    for (let i = 0; i < withMin.length; i++) {
      let size = 1;
      for (let j = 0; j < withMin.length; j++) {
        if (i === j) continue;
        if (Math.abs(withMin[j]!.mins - withMin[i]!.mins) <= CLUSTER_WINDOW_MIN) size++;
      }
      rates.set(withMin[i]!.e, 1 / size);
    }
    // Entries with un-parseable times: no cluster info → assume realization 1
    for (const e of arr) if (!rates.has(e)) rates.set(e, 1);
  }
  return rates;
}

function aggregate(entries: RejectedEntry[], stage: 'filter' | 'gate', realization: Map<RejectedEntry, number>): RuleBucket[] {
  const m = new Map<string, RuleBucket>();
  for (const e of entries) {
    const rule = stage === 'filter' ? (e.filterRule ?? '(unknown filter)') : (e.gate ?? '(unknown gate)');
    const category = stage === 'filter' ? (e.filterCategory ?? 'uncategorized') : 'gate';
    let b = m.get(rule);
    if (!b) {
      b = { stage, category, rule, entries: [], A: 0, B: 0, C: 0, D: 0, F: 0, unknown: 0, costScore: 0, abShare: 0, avgMfe: 0, avgRealization: 0, adjustedCost: 0 };
      m.set(rule, b);
    }
    b.entries.push(e);
    if (e.grade === 'A' || e.grade === 'B' || e.grade === 'C' || e.grade === 'D' || e.grade === 'F') {
      (b as any)[e.grade]++;
    } else {
      b.unknown++;
    }
  }
  for (const b of m.values()) {
    b.costScore = b.A * 2 + b.B - b.D - b.F * 2;
    const n = b.entries.length || 1;
    b.abShare = (b.A + b.B) / n;
    b.avgMfe = b.entries.reduce((s, e) => s + (e.mfePct ?? 0), 0) / n;
    let adj = 0, totRate = 0;
    for (const e of b.entries) {
      const r = realization.get(e) ?? 1;
      totRate += r;
      adj += (GRADE_SCORE[e.grade] ?? 0) * r;
    }
    b.avgRealization = totRate / n;
    b.adjustedCost = adj;
  }
  return [...m.values()].filter(b => b.entries.length >= MIN_BLOCKED);
}

function fmtBucket(b: RuleBucket): string {
  const total = b.A + b.B + b.C + b.D + b.F + b.unknown;
  const sign = (n: number) => n >= 0 ? '+' : '';
  const unk = b.unknown ? `/${b.unknown}?` : '';
  return `  [${b.stage}:${b.category}] ${b.rule}\n    rejects ${total} (${b.A}A/${b.B}B/${b.C}C/${b.D}D/${b.F}F${unk})  AB-share=${(b.abShare * 100).toFixed(0)}%  avgMFE=${b.avgMfe.toFixed(3)}%  rawCost=${sign(b.costScore)}${b.costScore}  realize=${(b.avgRealization * 100).toFixed(0)}%  adj=${sign(b.adjustedCost)}${b.adjustedCost.toFixed(1)}`;
}

// ── Main ──
const json = loadJson();
const t = json.perTicker.find(p => p.ticker === TICKER);
if (!t) throw new Error(`${TICKER} not in output`);
const filtered = t.filtered ?? [];
const blocked = t.blocked ?? [];

console.log(`\n${'='.repeat(80)}`);
console.log(`  REJECTED-GOODS MINER: ${TICKER} ${START} → ${END}`);
console.log(`${'='.repeat(80)}\n`);

console.log(`  Confirmed:              ${t.totalEntries} (${t.grades.A}A/${t.grades.B}B/${t.grades.C}C/${t.grades.D}D/${t.grades.F}F)  expectancy ${t.expectancy >= 0 ? '+' : ''}${t.expectancy.toFixed(3)}`);
console.log(`  Filter rejects:         ${filtered.length}`);
console.log(`  Gate rejects:           ${blocked.length}`);

if (filtered.length === 0 && blocked.length === 0) {
  console.log(`\n  ⚠️  No rejection data in cache. Regenerate via:`);
  console.log(`     npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json\n`);
  process.exit(0);
}

// Compute realization rates once across the union of all rejections (clusters can
// span filter+gate rejections on the same minute).
const realization = computeRealizationRates([...filtered, ...blocked]);

const allBuckets = [...aggregate(filtered, 'filter', realization), ...aggregate(blocked, 'gate', realization)]
  .sort((a, b) => b.adjustedCost - a.adjustedCost);

const positive = allBuckets.filter(b => b.adjustedCost > 0);
const negative = allBuckets.filter(b => b.adjustedCost < 0).sort((a, b) => a.adjustedCost - b.adjustedCost);

console.log(`\n  ── Rules BLOCKING NET-GOOD entries (ranked by adj cost = raw × realization) ──\n`);
if (positive.length === 0) {
  console.log(`  (none — every rejection bucket with ≥${MIN_BLOCKED} entries is net-negative)`);
} else {
  for (const b of positive.slice(0, TOP_N)) console.log(fmtBucket(b));
}

console.log(`\n  ── Rules WORKING AS INTENDED (top 5, most negative cost) ──\n`);
for (const b of negative.slice(0, 5)) console.log(fmtBucket(b));

const totRejectedAB = allBuckets.reduce((s, b) => s + b.A + b.B, 0);
const totRejectedF = allBuckets.reduce((s, b) => s + b.F, 0);
const totNetCost = allBuckets.reduce((s, b) => s + b.costScore, 0);

console.log(`\n  ── Totals across all rules with ≥${MIN_BLOCKED} rejections ──\n`);
console.log(`  Rejected A+B:  ${totRejectedAB}  (good entries blocked)`);
console.log(`  Rejected F:    ${totRejectedF}  (bad entries correctly blocked)`);
console.log(`  Net cost:      ${totNetCost >= 0 ? '+' : ''}${totNetCost}  (positive → filters too tight overall)\n`);

console.log(`  To validate a proposed relaxation: loosen the rule in src/strategies/<ticker>.ts`);
console.log(`  and run  npx tsx src/scripts/validate-change.ts ${START} ${END} ${TICKER}\n`);
