#!/usr/bin/env npx tsx
/**
 * factor-orthogonality.ts — Diagnose correlated/non-discriminating confidence factors.
 *
 * Confidence is built from ~29 factors. If many are correlated (e.g. adxBonus,
 * diSpreadBonus, trendPhaseBonus all derive from ADX/DMI), they either double-count
 * the same signal or cancel each other out, compressing A/B and F into the same
 * mid-confidence band and killing discrimination.
 *
 * This script consumes the same VALIDATE-JSON cache that mine-f-signatures.ts uses
 * (rawConfirmed carries full breakdown per entry) and reports:
 *
 *   1. Pairwise Pearson correlation across all factors (flags |r| > 0.6)
 *   2. Per-factor A/B-vs-F separation (Cohen's d), sorted by |d|
 *   3. Correlation clusters — which factor dominates, which siblings are redundant
 *   4. Removal candidates — low |d| AND highly correlated with a stronger sibling
 *
 * Usage:
 *   npx tsx src/scripts/factor-orthogonality.ts [START] [END] [TICKER] [--cache file.json]
 *   npx tsx src/scripts/factor-orthogonality.ts 2026-01-02 2026-04-17 SPY --cache spy.json
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
const CACHE_PATH = getFlagValue('--cache');

const CORR_THRESHOLD = 0.6;       // |r| above this flagged as correlated
const REDUNDANT_D_CUTOFF = 0.2;   // |Cohen's d| below this is low-discrimination

interface Breakdown { [factor: string]: number }
interface RawConfirmed {
  date: string;
  time: string;
  direction: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  confidence: number;
  breakdown: Breakdown;
}

// ── Load cache ──────────────────────────────────────────────────────────────
function loadRawConfirmed(): RawConfirmed[] {
  let body: string;
  if (CACHE_PATH && existsSync(CACHE_PATH)) {
    console.log(`[cache] Reading ${CACHE_PATH}`);
    body = readFileSync(CACHE_PATH, 'utf-8');
  } else {
    console.log(`[backtest] Running ${START} → ${END} ${TICKER} (this takes a few minutes)`);
    const out = execSync(
      `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60 * 60 * 1000 },
    );
    const m = out.match(/<!--VALIDATE-JSON-BEGIN-->\n(.+?)\n<!--VALIDATE-JSON-END-->/s);
    if (!m) throw new Error('JSON block not found in backtest output');
    body = m[1]!;
    if (CACHE_PATH) {
      writeFileSync(CACHE_PATH, body);
      console.log(`[cache] Wrote ${CACHE_PATH}`);
    }
  }
  const json = JSON.parse(body);
  const t = json.perTicker.find((p: { ticker: string }) => p.ticker === TICKER);
  if (!t) throw new Error(`ticker ${TICKER} not in output`);
  const raw: RawConfirmed[] = (t.rawConfirmed ?? []).filter((e: RawConfirmed) => e.breakdown);
  console.log(`[load] ${raw.length} confirmed entries with breakdown`);
  return raw;
}

// ── Stats helpers ───────────────────────────────────────────────────────────
function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function std(xs: number[], m = mean(xs)): number {
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1);
  return Math.sqrt(v);
}
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx, b = ys[i]! - my;
    num += a * b; dx2 += a * a; dy2 += b * b;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}
function cohensD(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  const sa = std(a, ma), sb = std(b, mb);
  const pooled = Math.sqrt((sa * sa + sb * sb) / 2);
  return pooled === 0 ? 0 : (ma - mb) / pooled;
}

// ── Extract factor columns ──────────────────────────────────────────────────
function getFactors(entries: RawConfirmed[]): { names: string[]; matrix: Map<string, number[]> } {
  const keys = new Set<string>();
  for (const e of entries) for (const k of Object.keys(e.breakdown)) keys.add(k);
  keys.delete('total');
  keys.delete('base');
  const names = [...keys].sort();
  const matrix = new Map<string, number[]>();
  for (const k of names) {
    matrix.set(k, entries.map(e => Number(e.breakdown[k] ?? 0)));
  }
  return { names, matrix };
}

// ── Formatting ──────────────────────────────────────────────────────────────
const pad = (s: string | number, w: number) => String(s).padStart(w);
const rpad = (s: string | number, w: number) => String(s).padEnd(w);
const fmtNum = (n: number, d = 3) => (n >= 0 ? '+' : '') + n.toFixed(d);

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const raw = loadRawConfirmed();
  if (raw.length === 0) {
    console.log('No entries with breakdown — aborting.');
    return;
  }

  const ab = raw.filter(e => e.grade === 'A' || e.grade === 'B');
  const f = raw.filter(e => e.grade === 'F');
  console.log(`[grades] A+B: ${ab.length}  C: ${raw.filter(e => e.grade === 'C').length}  D: ${raw.filter(e => e.grade === 'D').length}  F: ${f.length}`);
  if (ab.length < 5 || f.length < 5) {
    console.log('WARN: fewer than 5 A/B or F entries — discrimination stats will be unreliable.');
  }

  const { names, matrix } = getFactors(raw);
  const abM = getFactors(ab).matrix;
  const fM = getFactors(f).matrix;

  // ── 1. Per-factor discrimination (A/B vs F) ──
  interface FactorStat {
    name: string;
    meanAll: number;
    stdAll: number;
    meanAB: number;
    meanF: number;
    cohensD: number;
    range: number;  // max - min, proxy for whether factor actually varies
  }
  const stats: FactorStat[] = names.map(k => {
    const all = matrix.get(k)!;
    const abV = abM.get(k) ?? [];
    const fV = fM.get(k) ?? [];
    return {
      name: k,
      meanAll: mean(all),
      stdAll: std(all),
      meanAB: abV.length ? mean(abV) : 0,
      meanF: fV.length ? mean(fV) : 0,
      cohensD: abV.length && fV.length ? cohensD(abV, fV) : 0,
      range: Math.max(...all) - Math.min(...all),
    };
  });
  stats.sort((a, b) => Math.abs(b.cohensD) - Math.abs(a.cohensD));

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  PER-FACTOR DISCRIMINATION (A+B vs F, sorted by |Cohen's d|)`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  ${rpad('Factor', 28)} ${pad('mean(AB)', 10)} ${pad('mean(F)', 10)} ${pad('Δmean', 10)} ${pad("d", 8)} ${pad('range', 8)}`);
  console.log(`  ${'-'.repeat(76)}`);
  for (const s of stats) {
    const marker = Math.abs(s.cohensD) < REDUNDANT_D_CUTOFF ? ' (low)' : Math.abs(s.cohensD) > 0.5 ? ' ★' : '';
    console.log(`  ${rpad(s.name, 28)} ${pad(fmtNum(s.meanAB, 4), 10)} ${pad(fmtNum(s.meanF, 4), 10)} ${pad(fmtNum(s.meanAB - s.meanF, 4), 10)} ${pad(fmtNum(s.cohensD, 2), 8)} ${pad(s.range.toFixed(3), 8)}${marker}`);
  }

  // ── 2. Pairwise correlation matrix ──
  const corr = new Map<string, Map<string, number>>();
  for (const a of names) {
    const row = new Map<string, number>();
    for (const b of names) {
      row.set(b, a === b ? 1 : pearson(matrix.get(a)!, matrix.get(b)!));
    }
    corr.set(a, row);
  }

  // Top correlated pairs
  const pairs: Array<{ a: string; b: string; r: number }> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const r = corr.get(names[i]!)!.get(names[j]!)!;
      if (Math.abs(r) >= CORR_THRESHOLD) pairs.push({ a: names[i]!, b: names[j]!, r });
    }
  }
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  HIGH-CORRELATION PAIRS (|r| ≥ ${CORR_THRESHOLD})`);
  console.log(`${'='.repeat(80)}`);
  if (pairs.length === 0) {
    console.log('  None — factors appear approximately orthogonal.');
  } else {
    console.log(`  ${rpad('Factor A', 28)} ${rpad('Factor B', 28)} ${pad('r', 8)}`);
    console.log(`  ${'-'.repeat(68)}`);
    for (const p of pairs) {
      console.log(`  ${rpad(p.a, 28)} ${rpad(p.b, 28)} ${pad(fmtNum(p.r, 2), 8)}`);
    }
  }

  // ── 3. Correlation clusters (union-find via |r| >= threshold) ──
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (x: string, y: string) => {
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const n of names) parent.set(n, n);
  for (const p of pairs) union(p.a, p.b);

  const clusters = new Map<string, string[]>();
  for (const n of names) {
    const r = find(n);
    const arr = clusters.get(r) ?? [];
    arr.push(n);
    clusters.set(r, arr);
  }
  const multiMember = [...clusters.values()].filter(c => c.length > 1);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  CORRELATION CLUSTERS (transitively linked at |r| ≥ ${CORR_THRESHOLD})`);
  console.log(`${'='.repeat(80)}`);
  if (multiMember.length === 0) {
    console.log('  No multi-factor clusters.');
  } else {
    const statByName = new Map(stats.map(s => [s.name, s]));
    for (const cluster of multiMember) {
      const sorted = [...cluster].sort((a, b) =>
        Math.abs(statByName.get(b)!.cohensD) - Math.abs(statByName.get(a)!.cohensD),
      );
      const dominant = sorted[0]!;
      const dDom = statByName.get(dominant)!.cohensD;
      console.log(`\n  Cluster (${cluster.length}): dominant = ${dominant} (d=${fmtNum(dDom, 2)})`);
      for (const m of sorted.slice(1)) {
        const s = statByName.get(m)!;
        const rDom = corr.get(dominant)!.get(m)!;
        const tag = Math.abs(s.cohensD) < REDUNDANT_D_CUTOFF ? ' REDUNDANT' : '';
        console.log(`    ${rpad(m, 28)} d=${fmtNum(s.cohensD, 2)}  r-vs-dominant=${fmtNum(rDom, 2)}${tag}`);
      }
    }
  }

  // ── 4. Removal / merge candidates ──
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  REMOVAL / MERGE CANDIDATES`);
  console.log(`  (|d| < ${REDUNDANT_D_CUTOFF} AND |r| ≥ ${CORR_THRESHOLD} with a higher-|d| sibling)`);
  console.log(`${'='.repeat(80)}`);
  const removalCandidates: Array<{ name: string; d: number; dominantName: string; dDom: number; r: number; range: number }> = [];
  const statByName = new Map(stats.map(s => [s.name, s]));
  for (const cluster of multiMember) {
    const sorted = [...cluster].sort((a, b) =>
      Math.abs(statByName.get(b)!.cohensD) - Math.abs(statByName.get(a)!.cohensD),
    );
    const dom = sorted[0]!;
    const dDom = statByName.get(dom)!.cohensD;
    for (const m of sorted.slice(1)) {
      const s = statByName.get(m)!;
      if (Math.abs(s.cohensD) < REDUNDANT_D_CUTOFF) {
        removalCandidates.push({
          name: m, d: s.cohensD, dominantName: dom, dDom, r: corr.get(dom)!.get(m)!, range: s.range,
        });
      }
    }
  }
  // Also flag solitary factors that barely discriminate AND barely vary
  const dead = stats.filter(s =>
    Math.abs(s.cohensD) < REDUNDANT_D_CUTOFF &&
    !removalCandidates.find(r => r.name === s.name) &&
    s.range < 0.02,
  );
  if (removalCandidates.length === 0 && dead.length === 0) {
    console.log('  None.');
  } else {
    if (removalCandidates.length > 0) {
      console.log(`  ${rpad('Factor', 28)} ${pad('d', 6)} ${rpad('Dominant sibling', 28)} ${pad('dDom', 6)} ${pad('r', 6)}`);
      console.log(`  ${'-'.repeat(76)}`);
      for (const r of removalCandidates) {
        console.log(`  ${rpad(r.name, 28)} ${pad(fmtNum(r.d, 2), 6)} ${rpad(r.dominantName, 28)} ${pad(fmtNum(r.dDom, 2), 6)} ${pad(fmtNum(r.r, 2), 6)}`);
      }
    }
    if (dead.length > 0) {
      console.log(`\n  Dead factors (|d| < ${REDUNDANT_D_CUTOFF}, range < 0.02 — barely fires in backtest):`);
      for (const d of dead) {
        console.log(`    ${rpad(d.name, 28)} d=${fmtNum(d.cohensD, 2)} range=${d.range.toFixed(3)}`);
      }
    }
  }

  // ── 5. Summary ──
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  SUMMARY`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  Total factors:            ${names.length}`);
  console.log(`  High-|d| factors (≥0.5):  ${stats.filter(s => Math.abs(s.cohensD) >= 0.5).length}`);
  console.log(`  Low-|d| factors (<0.2):   ${stats.filter(s => Math.abs(s.cohensD) < REDUNDANT_D_CUTOFF).length}`);
  console.log(`  Correlation clusters:     ${multiMember.length} (covering ${multiMember.reduce((s, c) => s + c.length, 0)} factors)`);
  console.log(`  Removal candidates:       ${removalCandidates.length}`);
  console.log(`  Dead factors:             ${dead.length}`);
  console.log();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
