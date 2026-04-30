// build-missed-corpus.ts
//
// Iterate (date × ticker) over a range, run the ideal-entry detector and
// backtest-day --json on each, and emit one JSONL row per ideal entry with the
// matched backtest entry's full ConfidenceBreakdown attached.
//
// Output is the labeled corpus for confidence-model mining: which factor
// contributions consistently fall short on grade-≥B ALGO_GAP misses.
//
// Usage: npx tsx src/scripts/build-missed-corpus.ts <START> <END> [tickers] [--out path] [--cache-dir path]
// Example: npx tsx src/scripts/build-missed-corpus.ts 2026-02-03 2026-04-29 SPY,QQQ,IWM,DIA,TSLA --out /tmp/missed-corpus.jsonl

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'fs';
import { join } from 'path';
import {
  type BtEntry, type IdealEntry, type Verdict,
  fetch1mBars, findIdealEntries, parseBacktestJson,
  matchBacktest, classifyVerdict, sessionWindowUTC, barCloseTs, fmtET,
} from '../lib/missed-entries.js';

// ── Args ────────────────────────────────────────────────────────────────────

interface Args {
  start: string;
  end: string;
  tickers: string[];
  outPath: string;
  cacheDir: string;
  windowMin: number;
  minMfe: number;
  maxMae: number;
  minR: number;
  minGrade: 'A' | 'B' | 'C';
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length < 2) { printHelp(); process.exit(0); }
  // Support both --key=val and --key val. Walk argv linearly so `--key val`
  // doesn't classify the value as a positional.
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.replace(/^--/, '').split('=');
      if (v !== undefined) { flags.set(k!, v); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags.set(k!, next); i++; }
      else { flags.set(k!, 'true'); }
    } else {
      positionals.push(a);
    }
  }
  const start = positionals[0]!;
  const end = positionals[1]!;
  const tickersStr = positionals[2] ?? 'SPY,QQQ,IWM,DIA,TSLA';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    console.error('error: START/END must be YYYY-MM-DD'); process.exit(1);
  }
  return {
    start, end,
    tickers: tickersStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    outPath: flags.get('out') ?? '/tmp/missed-corpus.jsonl',
    cacheDir: flags.get('cache-dir') ?? '/tmp/missed-corpus-cache',
    windowMin: numFlag(flags, 'window', 30),
    minMfe: numFlag(flags, 'min-mfe', 0.20),
    maxMae: numFlag(flags, 'max-mae', 0.15),
    minR: numFlag(flags, 'min-r', 2.0),
    minGrade: (flags.get('min-grade') ?? 'C').toUpperCase() as 'A' | 'B' | 'C',
  };
}

function numFlag(flags: Map<string, string>, name: string, dflt: number): number {
  const v = flags.get(name);
  if (v === undefined || v === 'true') return dflt;
  const n = Number(v);
  if (!isFinite(n)) { console.error(`error: --${name} must be a number, got "${v}"`); process.exit(1); }
  return n;
}

function printHelp(): void {
  console.log(`Usage: npx tsx src/scripts/build-missed-corpus.ts <START> <END> [tickers] [flags]

Build a JSONL corpus of ideal entries with backtest-side ConfidenceBreakdown.

Required:
  START           YYYY-MM-DD inclusive
  END             YYYY-MM-DD inclusive
  tickers         comma-separated, default: SPY,QQQ,IWM,DIA,TSLA

Flags:
  --out=PATH        output JSONL path (default /tmp/missed-corpus.jsonl)
  --cache-dir=PATH  per-day backtest JSON cache dir (default /tmp/missed-corpus-cache)
  --window=30       MFE/MAE forward window minutes
  --min-mfe=0.20    minimum MFE %
  --max-mae=0.15    maximum MAE %
  --min-r=2.0       minimum MFE/MAE ratio
  --min-grade=C     emit only ideals at this grade or better (A/B/C)
  --help            show this help
`);
}

// ── Date enumeration (weekdays only) ────────────────────────────────────────

function* eachWeekday(startISO: string, endISO: string): Generator<string> {
  const d = new Date(`${startISO}T12:00:00Z`);
  const e = new Date(`${endISO}T12:00:00Z`);
  while (d <= e) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      yield `${y}-${m}-${dd}`;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// ── Backtest runner with on-disk cache ──────────────────────────────────────

function runBacktestCached(ticker: string, date: string, cacheDir: string): BtEntry[] | null {
  const cachePath = join(cacheDir, `${ticker}-${date}.json`);
  if (existsSync(cachePath)) {
    const raw = readFileSync(cachePath, 'utf8');
    return parseBacktestJson(raw, date);
  }
  const r = spawnSync('npx', ['tsx', 'src/scripts/backtest-day.ts', date, ticker, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    timeout: 300_000,
  });
  if (r.error) { console.error(`[backtest] ${ticker} ${date}: ${r.error.message}`); return null; }
  const out = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  // Persist the full stdout — parseBacktestJson re-finds the marker.
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, out);
  return parseBacktestJson(out, date);
}

// ── Row builder ─────────────────────────────────────────────────────────────

const GRADE_RANK: Record<'A' | 'B' | 'C', number> = { A: 3, B: 2, C: 1 };

interface CorpusRow {
  ticker: string;
  date: string;
  miss_time_et: string;
  miss_ts_utc: string;
  direction: 'long' | 'short';
  ideal_grade: 'A' | 'B' | 'C';
  ideal_mfe_pct: number;
  ideal_mae_pct: number;
  ideal_r: number;
  ideal_ttp_min: number;
  ideal_entry_price: number;
  ideal_peak_price: number;
  bt_status: 'confirmed' | 'blocked' | 'filtered' | null;
  bt_time_et: string | null;
  bt_direction: 'bullish' | 'bearish' | null;
  bt_confidence: number | null;
  bt_mode: string | null;
  bt_grade: string | null;
  bt_filter_rule: string | null;
  bt_breakdown: Record<string, number> | null;
  verdict: Verdict;
}

function buildRow(ticker: string, date: string, ideal: IdealEntry, bt: BtEntry[] | null): CorpusRow {
  const m = bt ? matchBacktest(ideal, bt) : { entry: null };
  // No live verdict here — corpus is backtest-only. Treat live as null so verdict
  // collapses to BLIND/ALGO_GAP based on bt only.
  const verdict: Verdict = classifyVerdict(m, { peakSignal: null, enterDispatch: null });
  return {
    ticker, date,
    miss_time_et: fmtET(barCloseTs(ideal.ts)),
    miss_ts_utc: new Date(barCloseTs(ideal.ts)).toISOString(),
    direction: ideal.direction,
    ideal_grade: ideal.grade,
    ideal_mfe_pct: Number(ideal.mfePct.toFixed(3)),
    ideal_mae_pct: Number(ideal.maePct.toFixed(3)),
    ideal_r: Number(ideal.rMultiple.toFixed(2)),
    ideal_ttp_min: Number(ideal.ttpMin.toFixed(1)),
    ideal_entry_price: ideal.entryPrice,
    ideal_peak_price: ideal.peakPrice,
    bt_status: m.entry?.status ?? null,
    bt_time_et: m.entry ? fmtET(m.entry.ts) : null,
    bt_direction: m.entry?.direction ?? null,
    bt_confidence: m.entry?.confidence ?? null,
    bt_mode: m.entry?.mode ?? null,
    bt_grade: m.entry?.grade ?? null,
    bt_filter_rule: m.entry?.filterRule ?? null,
    bt_breakdown: m.entry?.breakdown ?? null,
    verdict,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs();
  if (!existsSync(args.cacheDir)) mkdirSync(args.cacheDir, { recursive: true });

  const dates = [...eachWeekday(args.start, args.end)];
  const total = dates.length * args.tickers.length;
  console.log(`[corpus] ${args.tickers.join(',')} × ${dates.length} weekdays = ${total} runs`);
  console.log(`[corpus] writing → ${args.outPath}`);
  console.log(`[corpus] cache  → ${args.cacheDir}`);

  const stream = createWriteStream(args.outPath, { flags: 'w' });
  const detectArgs = {
    windowMin: args.windowMin, minMfe: args.minMfe, maxMae: args.maxMae,
    minR: args.minR, minVolMult: 0,
  };

  let runIdx = 0, totalIdeals = 0, totalEmitted = 0;
  const t0 = Date.now();

  for (const date of dates) {
    for (const ticker of args.tickers) {
      runIdx++;
      const tag = `[${runIdx}/${total}] ${ticker} ${date}`;
      try {
        const { startUTC, endUTC } = sessionWindowUTC(date, false);
        const bars = await fetch1mBars(ticker, startUTC, endUTC);
        if (bars.length < args.windowMin + 5) {
          console.log(`${tag}: skip (only ${bars.length} bars)`);
          continue;
        }
        const ideals = findIdealEntries(bars, detectArgs);
        const filtered = ideals.filter(e => GRADE_RANK[e.grade] >= GRADE_RANK[args.minGrade]);
        totalIdeals += filtered.length;
        if (filtered.length === 0) {
          console.log(`${tag}: 0 ideals`);
          continue;
        }
        const bt = runBacktestCached(ticker, date, args.cacheDir);
        for (const ideal of filtered) {
          const row = buildRow(ticker, date, ideal, bt);
          stream.write(JSON.stringify(row) + '\n');
          totalEmitted++;
        }
        console.log(`${tag}: ${filtered.length} ideals → emitted (bt=${bt ? bt.length : 'null'} entries)`);
      } catch (e: any) {
        console.error(`${tag}: ERROR ${e.message ?? e}`);
      }
    }
  }

  await new Promise<void>(resolve => stream.end(() => resolve()));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[corpus] done in ${dt}s — ${totalEmitted}/${totalIdeals} rows → ${args.outPath}`);
})().catch(e => { console.error(e); process.exit(1); });
