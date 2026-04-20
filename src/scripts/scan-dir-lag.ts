#!/usr/bin/env npx tsx
/**
 * scan-dir-lag.ts — One-off scanner to characterize WRONG_DIRECTION misses
 * and the DMI/signal flip lag across a multi-month window.
 *
 * Usage: npx tsx src/scripts/scan-dir-lag.ts 2026-01-01 2026-04-20 SPY
 */
import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2026-01-01';
const END = process.argv[3] || '2026-04-20';
const TICKER = (process.argv[4] || 'SPY').toUpperCase();

const HOLIDAYS = new Set([
  '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16',
]);

function tradingDays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + 'T12:00:00Z');
  const e = new Date(end + 'T12:00:00Z');
  while (d <= e) {
    const dow = d.getUTCDay();
    const key = d.toISOString().slice(0, 10);
    if (dow >= 1 && dow <= 5 && !HOLIDAYS.has(key)) out.push(key);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

interface MissedMove {
  date: string;
  timeET: string;
  direction: string;
  mfePct: number;
  mfePeakMinutes: number;
  systemDirection: string;
  systemConf: number;
  ticks: { timeET: string; direction: string; confPct: number }[];
  firstRightDirMin: number | null;   // minutes from move start to first right-dir tick
  firstRightDirConf: number | null;  // confidence at that point
  maxRightDirConf: number;           // max conf the right-dir signal ever hit during the window
}

function parseTicks(systemLine: string): { timeET: string; direction: string; confPct: number }[] {
  // "        System: 11:07 bearish 61%✗ | 11:11 bearish 46%✗ | ..."
  const m = systemLine.match(/System:\s*(.+)$/);
  if (!m) return [];
  return m[1]!.split('|').map(s => {
    const t = s.trim().match(/^(\d{1,2}:\d{2})\s+(bullish|bearish|neutral)\s+(\d+)%/);
    if (!t) return null;
    return { timeET: t[1]!, direction: t[2]!, confPct: parseInt(t[3]!, 10) };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
}

function minutesBetween(aET: string, bET: string): number {
  const [ah, am] = aET.split(':').map(Number) as [number, number];
  const [bh, bm] = bET.split(':').map(Number) as [number, number];
  return (bh * 60 + bm) - (ah * 60 + am);
}

function runDay(date: string): { text: string; json: any } | null {
  try {
    const output = execSync(
      `npx tsx src/scripts/backtest-day.ts ${date} ${TICKER} --json 2>&1`,
      { timeout: 240_000, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
    );
    const jm = output.match(/__JSON_START__([\s\S]+?)__JSON_END__/);
    return { text: output, json: jm ? JSON.parse(jm[1]!) : null };
  } catch {
    return null;
  }
}

function extractMissedForDay(date: string, text: string, json: any): MissedMove[] {
  if (!json?.moveScanner?.missedMoves) return [];
  const wrongDir = json.moveScanner.missedMoves.filter((m: any) => m.missReason === 'WRONG_DIRECTION');

  // Match text blocks. Each missed move has:
  //   ⚠️  11:07→11:29 ET ▲ bullish ...
  //       WHY MISSED: ...
  //       System: ...
  const blocks = text.split(/(?=^\s+⚠️\s+\d)/m);

  const out: MissedMove[] = [];
  for (const mv of wrongDir) {
    // Match blocks whose FIRST line is the ⚠️ missed-move line with this time+direction.
    // (Bare includes() would also hit the MOVE SCANNER summary table.)
    const block = blocks.find(b => {
      const first = b.split('\n').find(l => l.includes('⚠️')) || '';
      return first.includes(`${mv.timeET}→`) && first.includes(mv.direction);
    });
    const systemLine = block?.split('\n').find(l => l.includes('System:')) || '';
    const ticks = parseTicks(systemLine);

    let firstRightDirMin: number | null = null;
    let firstRightDirConf: number | null = null;
    let maxRightDirConf = 0;
    for (const t of ticks) {
      if (t.direction === mv.direction) {
        if (firstRightDirMin === null) {
          firstRightDirMin = minutesBetween(mv.timeET, t.timeET);
          firstRightDirConf = t.confPct;
        }
        if (t.confPct > maxRightDirConf) maxRightDirConf = t.confPct;
      }
    }

    out.push({
      date,
      timeET: mv.timeET,
      direction: mv.direction,
      mfePct: mv.mfePct,
      mfePeakMinutes: mv.mfePeakMinutes,
      systemDirection: mv.systemDirection,
      systemConf: Math.round(mv.systemConf * 100),
      ticks,
      firstRightDirMin,
      firstRightDirConf,
      maxRightDirConf,
    });
  }
  return out;
}

const days = tradingDays(START, END);
console.log(`\nScanning ${days.length} trading days: ${START} → ${END} ${TICKER}\n`);

const all: MissedMove[] = [];
let done = 0;
for (const date of days) {
  done++;
  const pct = ((done / days.length) * 100).toFixed(0);
  process.stdout.write(`  [${pct}%] ${date} ...`);
  const res = runDay(date);
  if (!res || !res.json) { process.stdout.write(` SKIP\n`); continue; }
  const misses = extractMissedForDay(date, res.text, res.json);
  all.push(...misses);
  process.stdout.write(` ${misses.length} wrong-dir miss(es)\n`);
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(90)}`);
console.log(`  WRONG-DIRECTION MISS ANALYSIS: ${TICKER}  ${START} → ${END}`);
console.log(`  ${days.length} days, ${all.length} wrong-dir misses (${(all.length / days.length).toFixed(2)} per day)`);
console.log(`${'═'.repeat(90)}\n`);

if (all.length === 0) { console.log('No wrong-dir misses found.'); process.exit(0); }

// Total lost MFE
const totalMfe = all.reduce((s, m) => s + m.mfePct, 0);
console.log(`  Total lost MFE: ${totalMfe.toFixed(2)}%  (avg ${(totalMfe / all.length).toFixed(2)}%/miss)\n`);

// Flip-lag distribution
const withFlip = all.filter(m => m.firstRightDirMin !== null);
const neverFlipped = all.filter(m => m.firstRightDirMin === null);
console.log(`  Signal flipped during move window: ${withFlip.length}/${all.length}`);
console.log(`  Never flipped during window:       ${neverFlipped.length}/${all.length}\n`);

if (withFlip.length > 0) {
  const lags = withFlip.map(m => m.firstRightDirMin!).sort((a, b) => a - b);
  const p = (q: number) => lags[Math.min(lags.length - 1, Math.floor(q * lags.length))]!;
  console.log(`  Flip-lag distribution (min from move-start to first right-dir tick):`);
  console.log(`    p25=${p(0.25)}m  p50=${p(0.50)}m  p75=${p(0.75)}m  p90=${p(0.90)}m  max=${lags[lags.length - 1]}m\n`);

  const maxConfs = withFlip.map(m => m.maxRightDirConf).sort((a, b) => a - b);
  const q = (v: number) => maxConfs[Math.min(maxConfs.length - 1, Math.floor(v * maxConfs.length))]!;
  console.log(`  Max right-dir confidence reached during move window:`);
  console.log(`    p25=${q(0.25)}%  p50=${q(0.50)}%  p75=${q(0.75)}%  p90=${q(0.90)}%  max=${maxConfs[maxConfs.length - 1]}%\n`);

  // How many would be caught at various threshold reductions
  const thresholds = [65, 60, 55, 50, 45];
  console.log(`  Catchable at reduced threshold (current=65%):`);
  for (const th of thresholds) {
    const count = withFlip.filter(m => m.maxRightDirConf >= th).length;
    const mfeCaught = withFlip.filter(m => m.maxRightDirConf >= th).reduce((s, m) => s + m.mfePct, 0);
    console.log(`    ≥${th}%:  ${count}/${withFlip.length} moves  (${mfeCaught.toFixed(2)}% MFE)`);
  }
}

// Per-miss detail (sorted by MFE desc)
console.log(`\n  All wrong-dir misses (sorted by MFE):\n`);
console.log(`  ${'Date'.padEnd(12)} ${'Time'.padEnd(6)} ${'Dir'.padEnd(8)} ${'MFE%'.padStart(6)} ${'Peak'.padStart(5)} ${'SysDir'.padEnd(8)} ${'SysC%'.padStart(5)} ${'FlipM'.padStart(5)} ${'MaxC%'.padStart(5)}`);
console.log('  ' + '-'.repeat(74));
for (const m of [...all].sort((a, b) => b.mfePct - a.mfePct)) {
  console.log(`  ${m.date.padEnd(12)} ${m.timeET.padEnd(6)} ${m.direction.padEnd(8)} ${m.mfePct.toFixed(2).padStart(6)} ${String(m.mfePeakMinutes).padStart(5)} ${m.systemDirection.padEnd(8)} ${String(m.systemConf).padStart(5)} ${(m.firstRightDirMin === null ? '—' : String(m.firstRightDirMin)).padStart(5)} ${String(m.maxRightDirConf).padStart(5)}`);
}
