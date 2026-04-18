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
  costScore: number;
  abShare: number;
  avgMfe: number;
}

function aggregate(entries: RejectedEntry[], stage: 'filter' | 'gate'): RuleBucket[] {
  const m = new Map<string, RuleBucket>();
  for (const e of entries) {
    const rule = stage === 'filter' ? (e.filterRule ?? '(unknown filter)') : (e.gate ?? '(unknown gate)');
    const category = stage === 'filter' ? (e.filterCategory ?? 'uncategorized') : 'gate';
    let b = m.get(rule);
    if (!b) {
      b = { stage, category, rule, entries: [], A: 0, B: 0, C: 0, D: 0, F: 0, unknown: 0, costScore: 0, abShare: 0, avgMfe: 0 };
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
  }
  return [...m.values()].filter(b => b.entries.length >= MIN_BLOCKED);
}

function fmtBucket(b: RuleBucket): string {
  const total = b.A + b.B + b.C + b.D + b.F + b.unknown;
  const sign = b.costScore >= 0 ? '+' : '';
  const unk = b.unknown ? `/${b.unknown}?` : '';
  return `  [${b.stage}:${b.category}] ${b.rule}\n    rejects ${total} (${b.A}A/${b.B}B/${b.C}C/${b.D}D/${b.F}F${unk})  AB-share=${(b.abShare * 100).toFixed(0)}%  avgMFE=${b.avgMfe.toFixed(3)}%  cost=${sign}${b.costScore}`;
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

const allBuckets = [...aggregate(filtered, 'filter'), ...aggregate(blocked, 'gate')]
  .sort((a, b) => b.costScore - a.costScore);

const positive = allBuckets.filter(b => b.costScore > 0);
const negative = allBuckets.filter(b => b.costScore < 0).sort((a, b) => a.costScore - b.costScore);

console.log(`\n  ── Rules BLOCKING NET-GOOD entries (candidates to relax, top ${TOP_N}) ──\n`);
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
