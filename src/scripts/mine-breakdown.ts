#!/usr/bin/env npx tsx
/**
 * mine-breakdown.ts — Mine unmined EntryContext fields for F-vs-AB discrimination.
 *
 * Reads the SAME aggregate JSON as mine-f-signatures.ts (produced by
 * `backtest-signal-quality.ts --json`), but scans the RICHER fields in
 * `rawConfirmed[].breakdown.*` + `rawConfirmed[].strength`, which the
 * original miner ignores.
 *
 * Why: 2026-04-18 analysis revealed strengthScore had an unmined toxic band
 * (70-79). Factor-orthogonality diagnostic showed the real problem is
 * perverse-signed factors and unmined breakdown sub-components — not feature
 * scarcity. The standard miner scans only 7 top-level indicators.
 *
 * Usage:
 *   npx tsx src/scripts/mine-breakdown.ts [START] [END] [TICKER] [--cache file.json]
 *   npx tsx src/scripts/mine-breakdown.ts 2025-01-02 2026-04-17 SPY --cache /tmp/bt15mo.json
 *
 * Scoring: identical to mine-f-signatures.ts (discrimScore × (1-cascadeRisk)).
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const START = positional[0] || '2026-01-02';
const END = positional[1] || '2026-04-17';
const TICKER = (positional[2] || 'SPY').toUpperCase();
const DIRECTION_FILTER = flag('--direction')?.toUpperCase();
const CACHE_PATH = flag('--cache');
const MODE_FILTER = flag('--mode')?.toLowerCase();

const TOP_N = 12;
const MIN_F_BLOCKED = 5;
const MIN_F_BLOCK_RATE = 0.08;
const MAX_AB_BLOCK_RATE = 0.15;

interface RawConfirmed {
  time: string;
  timeET: string;
  date?: string;
  direction: string;
  alignment: string;
  mode: string;
  confidence: number;
  price: number;
  strength: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  outcome: string;
  gate: string;
  mfePct: number;
  maePct: number;
  dirCorrect: boolean;
  atr: number;
  breakdown: Record<string, number>;
}

interface Flat {
  date: string;
  direction: string;
  mode: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  confidence: number;
  strength: number;
  atr: number;
  gateResult: string;
  [k: string]: string | number | boolean;
}

function loadRaw(): Flat[] {
  let json: { perTicker: Array<{ ticker: string; rawConfirmed: RawConfirmed[] }> };

  if (CACHE_PATH && existsSync(CACHE_PATH)) {
    console.log(`[cache] Reading ${CACHE_PATH}`);
    json = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  } else {
    console.log(`[backtest] Running ${START} → ${END} ${TICKER} — this takes a while`);
    const out = execSync(
      `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4 * 60 * 60 * 1000 },
    );
    const m = out.match(/<!--VALIDATE-JSON-BEGIN-->\n(.+?)\n<!--VALIDATE-JSON-END-->/s);
    if (!m) throw new Error('JSON envelope not found in backtest output');
    json = JSON.parse(m[1]!);
    if (CACHE_PATH) {
      writeFileSync(CACHE_PATH, m[1]!);
      console.log(`[cache] Wrote ${CACHE_PATH}`);
    }
  }

  const t = json.perTicker.find(p => p.ticker === TICKER);
  if (!t) throw new Error(`ticker ${TICKER} not in output`);
  let raw = t.rawConfirmed;
  if (DIRECTION_FILTER) {
    raw = raw.filter(e => e.direction.toUpperCase() === DIRECTION_FILTER);
    console.log(`[filter] direction=${DIRECTION_FILTER}: ${raw.length} entries`);
  }
  if (MODE_FILTER) {
    raw = raw.filter(e => e.mode === MODE_FILTER);
    console.log(`[filter] mode=${MODE_FILTER}: ${raw.length} entries`);
  }

  return raw.map(e => {
    const flat: Flat = {
      date: e.date ?? e.time.slice(0, 10),
      direction: e.direction.toUpperCase(),
      mode: e.mode,
      grade: e.grade,
      confidence: e.confidence,
      strength: e.strength,
      atr: e.atr,
      gateResult: e.gate,
    };
    for (const [k, v] of Object.entries(e.breakdown)) flat[k] = v;
    return flat;
  });
}

// ── Scoring (copied from mine-f-signatures.ts for consistency) ───────────────
interface BlockedStats {
  total: number;
  A: number; B: number; C: number; D: number; F: number;
  fBlockRate: number;
  abBlockRate: number;
  discrimScore: number;
  newExpectancy: number;
  expectancyDelta: number;
  highConvRate: number;
  multiDayRate: number;
  cascadeRisk: number;
  adjustedScore: number;
}

const pop = { A: 0, B: 0, C: 0, D: 0, F: 0 };
let baselineExp = 0;
const perDay = new Map<string, number>();

function stats(blocked: Flat[]): BlockedStats {
  const c = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const e of blocked) c[e.grade]++;
  const fBlockRate = pop.F > 0 ? c.F / pop.F : 0;
  const abTotal = pop.A + pop.B;
  const abBlockRate = abTotal > 0 ? (c.A + c.B) / abTotal : 0;
  const discrimScore = fBlockRate - 2 * abBlockRate;

  const blockedScore = c.A * 2 + c.B - c.D - c.F * 2;
  const totalScore = pop.A * 2 + pop.B - pop.D - pop.F * 2;
  const totalN = pop.A + pop.B + pop.C + pop.D + pop.F;
  const remainingN = totalN - blocked.length;
  const newExp = remainingN > 0 ? (totalScore - blockedScore) / remainingN : 0;

  let hco = 0, multi = 0;
  for (const e of blocked) {
    if (typeof e.gateResult === 'string' && /HIGH[-_ ]?CONV/i.test(e.gateResult)) hco++;
    if ((perDay.get(e.date as string) ?? 1) > 1) multi++;
  }
  const highConvRate = blocked.length > 0 ? hco / blocked.length : 0;
  const multiDayRate = blocked.length > 0 ? multi / blocked.length : 0;
  const cascadeRisk = 0.5 * highConvRate + 0.5 * multiDayRate;
  const adjustedScore = discrimScore * (1 - cascadeRisk);

  return {
    total: blocked.length, ...c,
    fBlockRate, abBlockRate, discrimScore,
    newExpectancy: newExp, expectancyDelta: newExp - baselineExp,
    highConvRate, multiDayRate, cascadeRisk, adjustedScore,
  };
}

function passes(s: BlockedStats): boolean {
  return s.F >= MIN_F_BLOCKED
    && s.fBlockRate >= MIN_F_BLOCK_RATE
    && s.abBlockRate <= MAX_AB_BLOCK_RATE
    && s.discrimScore > 0;
}

function fmt(s: BlockedStats): string {
  const sign = (n: number) => n >= 0 ? '+' : '';
  const risk = s.cascadeRisk >= 0.6 ? '⚠️ ' : s.cascadeRisk >= 0.4 ? '· ' : '';
  return `blocks ${s.total} (${s.A}A/${s.B}B/${s.C}C/${s.D}D/${s.F}F)  F=${(s.fBlockRate * 100).toFixed(0)}%  AB-loss=${(s.abBlockRate * 100).toFixed(0)}%  Δexp=${sign(s.expectancyDelta)}${s.expectancyDelta.toFixed(3)}  ${risk}cas=${(s.cascadeRisk * 100).toFixed(0)}%  adj=${sign(s.adjustedScore)}${s.adjustedScore.toFixed(3)}`;
}

// ── Threshold scan ──────────────────────────────────────────────────────────
interface Cand {
  field: string;
  op: '>' | '>=' | '<' | '<=';
  threshold: number;
  stats: BlockedStats;
}

function quantiles(values: number[]): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const qs = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
  const out = new Set<number>();
  for (const q of qs) {
    const v = sorted[Math.floor(q * (sorted.length - 1))]!;
    // round to 4 decimals to dedupe near-equal thresholds
    out.add(Math.round(v * 10000) / 10000);
  }
  return [...out].sort((a, b) => a - b);
}

function scan(entries: Flat[], field: string): Cand[] {
  const values = entries.map(e => e[field]).filter(v => typeof v === 'number') as number[];
  const thresholds = quantiles(values);
  const out: Cand[] = [];
  for (const t of thresholds) {
    for (const op of ['>', '>=', '<', '<='] as const) {
      const pred = (v: number) => {
        if (op === '>') return v > t;
        if (op === '>=') return v >= t;
        if (op === '<') return v < t;
        return v <= t;
      };
      const blocked = entries.filter(e => {
        const v = e[field];
        return typeof v === 'number' && pred(v);
      });
      const s = stats(blocked);
      if (!passes(s)) continue;
      out.push({ field, op, threshold: t, stats: s });
    }
  }
  return out.sort((a, b) => b.stats.adjustedScore - a.stats.adjustedScore);
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))]!;
}

function printDist(entries: Flat[], field: string): void {
  const bad = entries.filter(e => e.grade === 'F').map(e => e[field]).filter(v => typeof v === 'number') as number[];
  const good = entries.filter(e => e.grade === 'A' || e.grade === 'B').map(e => e[field]).filter(v => typeof v === 'number') as number[];
  if (bad.length === 0 || good.length === 0) return;
  const meanDiff = Math.abs(mean(bad) - mean(good));
  const pooledSd = Math.sqrt((variance(bad) + variance(good)) / 2);
  const cohen = pooledSd > 0 ? meanDiff / pooledSd : 0;
  if (cohen < 0.15) return; // skip uninformative
  console.log(`  ${field.padEnd(28)} d=${cohen.toFixed(2)}  F: p10=${pct(bad, 0.1).toFixed(3)} p50=${pct(bad, 0.5).toFixed(3)} p90=${pct(bad, 0.9).toFixed(3)}   AB: p10=${pct(good, 0.1).toFixed(3)} p50=${pct(good, 0.5).toFixed(3)} p90=${pct(good, 0.9).toFixed(3)}`);
}

function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function variance(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
}

// ── Main ────────────────────────────────────────────────────────────────────
const entries = loadRaw();
const A = entries.filter(e => e.grade === 'A').length;
const B = entries.filter(e => e.grade === 'B').length;
const C = entries.filter(e => e.grade === 'C').length;
const D = entries.filter(e => e.grade === 'D').length;
const F = entries.filter(e => e.grade === 'F').length;
const N = entries.length;
const exp = N > 0 ? (A * 2 + B - D - F * 2) / N : 0;

pop.A = A; pop.B = B; pop.C = C; pop.D = D; pop.F = F;
baselineExp = exp;
for (const e of entries) perDay.set(e.date, (perDay.get(e.date) ?? 0) + 1);

console.log(`\n${'='.repeat(90)}`);
console.log(`  BREAKDOWN / STRENGTH MINER: ${TICKER} ${START} → ${END}${DIRECTION_FILTER ? ` [${DIRECTION_FILTER}]` : ''}${MODE_FILTER ? ` [${MODE_FILTER}]` : ''}`);
console.log(`${'='.repeat(90)}`);
console.log(`  Population: ${N} entries (${A}A/${B}B/${C}C/${D}D/${F}F)  baseline exp ${exp >= 0 ? '+' : ''}${exp.toFixed(3)}\n`);

// Gather all numeric fields present in the flattened entries
const fieldSet = new Set<string>();
for (const e of entries) {
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === 'number' && k !== 'date') fieldSet.add(k);
  }
}
// Exclude fields that identify the entry rather than describe it
const skip = new Set(['atr']);  // atr is already in mine-f-signatures
const fields = [...fieldSet].filter(f => !skip.has(f)).sort();

console.log(`  ── Distributions with Cohen's d ≥ 0.15 (F vs A+B) ──\n`);
for (const f of fields) printDist(entries, f);

console.log(`\n  ── Top ${TOP_N} Single-Field Candidates (F ≥ ${MIN_F_BLOCKED}, F-catch ≥ ${(MIN_F_BLOCK_RATE * 100).toFixed(0)}%, AB-loss ≤ ${(MAX_AB_BLOCK_RATE * 100).toFixed(0)}%) ──\n`);

const allCands: Cand[] = [];
for (const f of fields) allCands.push(...scan(entries, f));
allCands.sort((a, b) => b.stats.adjustedScore - a.stats.adjustedScore);

if (allCands.length === 0) {
  console.log(`  ❌ No single-field threshold meets preservation requirements.\n`);
} else {
  // Dedupe: keep best 3 candidates per field so output isn't dominated by one field
  const perField = new Map<string, Cand[]>();
  for (const c of allCands) {
    const list = perField.get(c.field) ?? [];
    if (list.length < 3) list.push(c);
    perField.set(c.field, list);
  }
  const deduped = [...perField.values()].flat().sort((a, b) => b.stats.adjustedScore - a.stats.adjustedScore);
  for (const c of deduped.slice(0, TOP_N)) {
    console.log(`  ${c.field.padEnd(28)} ${c.op} ${String(c.threshold).padStart(7)}   ${fmt(c.stats)}`);
  }
}

console.log(`\n  Next: pick low-cascade (<40%) candidates → implement as shouldAllowEntry filter → validate-change.ts over ≥ 60 trading days.\n`);
