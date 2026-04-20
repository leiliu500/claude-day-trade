#!/usr/bin/env npx tsx
/**
 * grade-vs-pnl.ts — Cross-check: does the grade system correlate with sim P&L?
 *
 * Runs backtest-signal-quality.ts with --json, parses rawConfirmed array,
 * groups by grade, and reports per-grade pnlPct statistics.
 *
 * If F-grade entries have ~0 or positive avg pnlPct, the grade system is
 * losing information (tuning based on grade-expectancy would reject profitable
 * candidates). If F is strongly negative, grades are valid.
 *
 * Usage: npx tsx src/scripts/grade-vs-pnl.ts 2025-10-01 2026-04-20 SPY
 */
import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2025-10-01';
const END = process.argv[3] || '2026-04-20';
const TICKER = (process.argv[4] || 'SPY').toUpperCase();

console.log(`\nRunning baseline backtest-signal-quality for ${TICKER} ${START} → ${END} with --json ...\n`);

const output = execSync(
  `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} ${TICKER} --json`,
  { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, timeout: 1800_000 },
);

// Parse JSON block
const jsonMatch = output.match(/<!--VALIDATE-JSON-BEGIN-->\s*([\s\S]+?)\s*<!--VALIDATE-JSON-END-->/);
if (!jsonMatch) {
  console.error('No JSON block found in output. Run with --json flag manually to check.');
  process.exit(1);
}
const parsed = JSON.parse(jsonMatch[1]!) as { perTicker: { ticker: string; rawConfirmed: Array<Record<string, unknown>> }[] };
const t = parsed.perTicker.find(p => p.ticker === TICKER);
if (!t || !t.rawConfirmed || t.rawConfirmed.length === 0) {
  console.error(`No rawConfirmed entries for ${TICKER}.`);
  process.exit(1);
}

interface Entry {
  grade: string;
  pnlPct: number;
  peakPnl: number;
  holdMin: number;
  exitReason: string;
  directionCorrect: boolean;
  mfePct: number;
  maePct: number;
  date: string;
}

const entries: Entry[] = t.rawConfirmed.map(c => {
  const sim = (c.sim ?? {}) as Record<string, unknown>;
  return {
    grade: String(c.grade ?? '?'),
    pnlPct: Number(sim.pnlPct ?? 0),
    peakPnl: Number(sim.peakPnl ?? 0),
    holdMin: Number(sim.holdMin ?? 0),
    exitReason: String(sim.exitReason ?? '?'),
    directionCorrect: Boolean(c.dirCorrect ?? false),
    mfePct: Number(c.mfePct ?? 0),
    maePct: Number(c.maePct ?? 0),
    date: String(c.date ?? ''),
  };
});

console.log(`Loaded ${entries.length} confirmed entries.\n`);

// ── Per-grade statistics ──
const grades = ['A', 'B', 'C', 'D', 'F'];
const pct = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
const stddev = (arr: number[]) => {
  if (arr.length < 2) return 0;
  const m = pct(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
};
const median = (arr: number[]) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

console.log('═'.repeat(100));
console.log(`  GRADE vs SIM P&L CROSSCHECK: ${TICKER}  ${START} → ${END}  (${entries.length} entries)`);
console.log('═'.repeat(100));
console.log('');
console.log('  Grade    N   AvgPnl%   MedPnl%  StdPnl%   AvgPeak%  AvgHold  Win%    DirCor%');
console.log('  ────────────────────────────────────────────────────────────────────────────');

for (const g of grades) {
  const gs = entries.filter(e => e.grade === g);
  if (gs.length === 0) { console.log(`  ${g.padEnd(4)} ${String(0).padStart(5)}  ——`); continue; }
  const pnls = gs.map(e => e.pnlPct);
  const peaks = gs.map(e => e.peakPnl);
  const holds = gs.map(e => e.holdMin);
  const wins = gs.filter(e => e.pnlPct > 0).length;
  const dirCor = gs.filter(e => e.directionCorrect).length;
  console.log(`  ${g.padEnd(4)} ${String(gs.length).padStart(5)}  ${pct(pnls).toFixed(2).padStart(6)}%  ${median(pnls).toFixed(2).padStart(6)}%  ${stddev(pnls).toFixed(2).padStart(6)}%   ${pct(peaks).toFixed(2).padStart(6)}%   ${pct(holds).toFixed(0).padStart(5)}m  ${((wins / gs.length) * 100).toFixed(0).padStart(4)}%   ${((dirCor / gs.length) * 100).toFixed(0).padStart(4)}%`);
}

// ── Overall summary ──
const total = entries.map(e => e.pnlPct);
const totalWins = entries.filter(e => e.pnlPct > 0).length;
console.log(`  ────────────────────────────────────────────────────────────────────────────`);
console.log(`  ALL  ${String(entries.length).padStart(5)}  ${pct(total).toFixed(2).padStart(6)}%  ${median(total).toFixed(2).padStart(6)}%  ${stddev(total).toFixed(2).padStart(6)}%   ${pct(entries.map(e => e.peakPnl)).toFixed(2).padStart(6)}%   ${pct(entries.map(e => e.holdMin)).toFixed(0).padStart(5)}m  ${((totalWins / entries.length) * 100).toFixed(0).padStart(4)}%`);

// ── Interpretation ──
console.log('');
console.log('─'.repeat(100));
console.log('  INTERPRETATION');
console.log('─'.repeat(100));
const fAvg = pct(entries.filter(e => e.grade === 'F').map(e => e.pnlPct));
const fWin = entries.filter(e => e.grade === 'F' && e.pnlPct > 0).length;
const fN = entries.filter(e => e.grade === 'F').length;
const aAvg = pct(entries.filter(e => e.grade === 'A').map(e => e.pnlPct));
const aN = entries.filter(e => e.grade === 'A').length;

console.log(`  F-grade: ${fN} entries, avg pnl ${fAvg.toFixed(2)}%, ${fWin} wins (${((fWin / fN) * 100).toFixed(0)}% win rate)`);
console.log(`  A-grade: ${aN} entries, avg pnl ${aAvg.toFixed(2)}%`);
console.log('');
if (fAvg >= 0) {
  console.log(`  ⚠️  F-grade avg pnl is NOT negative (${fAvg.toFixed(2)}%). Grade system is LOSING INFORMATION.`);
  console.log(`      Candidates rejected for "adding F entries" may have been adding profitable trades.`);
} else if (fAvg < -1.5) {
  console.log(`  ✓  F-grade avg pnl is strongly negative (${fAvg.toFixed(2)}%). Grade system is VALID.`);
  console.log(`      Candidates rejected for adding F entries were correctly rejected.`);
} else {
  console.log(`  ~  F-grade avg pnl is mildly negative (${fAvg.toFixed(2)}%). Grade system is PARTIALLY INFORMATIVE.`);
  console.log(`      Mixed evidence — some rejected candidates may have had hidden positive P&L.`);
}
