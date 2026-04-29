// CLI wrapper around src/lib/missed-entries.ts. Three-phase analysis:
//   1. DETECT  — find ideal entries from raw 1-min bars (system-independent)
//   2. VERIFY BACKTEST — runs backtest-day.ts --json, matches each ideal entry
//   3. VERIFY LIVE — queries signal_snapshots + dispatches, matches each ideal entry
//
// Usage: npx tsx src/scripts/find-missed-entries.ts <TICKER> [DATE] [flags]

import { spawnSync } from 'child_process';
import {
  type BtEntry, type BtMatch, type LiveMatch, type LiveSnapshot,
  type LiveDispatch, type VerifiedEntry, type Verdict, type Grade,
  todayET, fmtET, barCloseTs, sessionWindowUTC,
  fetch1mBars, findIdealEntries, parseBacktestJson, fetchLiveLayer,
  matchBacktest, matchLive, classifyVerdict,
} from '../lib/missed-entries.js';

interface CliArgs {
  ticker: string;
  date: string;
  windowMin: number;
  minMfe: number;
  maxMae: number;
  minR: number;
  minVolMult: number;
  includeETH: boolean;
  noBacktest: boolean;
  noLive: boolean;
  output: 'human' | 'csv' | 'json';
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) { printHelp(); process.exit(0); }
  const positionals = argv.filter(a => !a.startsWith('--'));
  const flags = new Map<string, string>(
    argv.filter(a => a.startsWith('--')).map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k!, v ?? 'true'];
    })
  );
  const ticker = (positionals[0] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    console.error(`error: invalid ticker "${positionals[0]}"`); process.exit(1);
  }
  const date = positionals[1] ?? todayET();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`error: invalid date "${date}" (expected YYYY-MM-DD)`); process.exit(1);
  }
  let output: CliArgs['output'] = 'human';
  if (flags.has('csv')) output = 'csv';
  if (flags.has('json')) output = 'json';
  return {
    ticker, date,
    windowMin: numFlag(flags, 'window', 30),
    minMfe: numFlag(flags, 'min-mfe', 0.20),
    maxMae: numFlag(flags, 'max-mae', 0.15),
    minR: numFlag(flags, 'min-r', 2.0),
    minVolMult: numFlag(flags, 'min-vol-mult', 0),
    includeETH: flags.has('include-eth'),
    noBacktest: flags.has('no-backtest'),
    noLive: flags.has('no-live'),
    output,
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
  console.log(`Usage: npx tsx src/scripts/find-missed-entries.ts <TICKER> [DATE] [flags]

Three-phase missed-entry analysis:
  1. DETECT — find ideal entries from raw 1-min bars (system-independent)
  2. VERIFY BACKTEST — match each ideal entry against backtest-day.ts --json output
  3. VERIFY LIVE — match each ideal entry against signal_snapshots + dispatches

Required:
  TICKER          stock symbol (e.g., QQQ, SPY, TSLA)
  DATE            YYYY-MM-DD in America/New_York (default: today)

Flags:
  --window=30     forward window in minutes
  --min-mfe=0.20  minimum MFE % to qualify
  --max-mae=0.15  maximum MAE % before MFE peak
  --min-r=2.0     minimum MFE/MAE ratio
  --min-vol-mult=0  require entry-bar volume >= N × session avg
  --include-eth   include 04:00-20:00 ET
  --no-backtest   skip backtest verification
  --no-live       skip live DB verification
  --csv           CSV output
  --json          JSON output
  --help          show this help
`);
}

// ── Backtest subprocess (CLI-flavored: uses npx tsx) ────────────────────────

function runBacktestCli(ticker: string, date: string): BtEntry[] | null {
  const r = spawnSync('npx', ['tsx', 'src/scripts/backtest-day.ts', date, ticker, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 180_000,
  });
  if (r.error) { console.error(`[backtest] subprocess error: ${r.error.message}`); return null; }
  const out = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  const parsed = parseBacktestJson(out, date);
  if (!parsed) console.error(`[backtest] no JSON marker found (last 500 chars): ${out.slice(-500)}`);
  return parsed;
}

// ── Output ──────────────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<Verdict, string> = {
  BOTH_EXEC: '✅ BOTH-EXEC',
  PARITY_GAP: '⚠️  PARITY GAP',
  ALGO_GAP: '🔴 ALGO GAP',
  BLIND: '👻 BLIND',
  BT_ONLY_DETECT_LIVE_EXEC: '🟡 LIVE-ONLY',
  NO_DATA: '   (verification disabled)',
};

function describeBt(m: BtMatch | null): string {
  if (!m) return 'verification disabled';
  if (!m.entry) return 'NO MATCH (no same-direction signal in backtest within ±5m)';
  const e = m.entry;
  const conf = (e.confidence * 100).toFixed(0);
  const grade = e.grade ? ` Grade ${e.grade}` : '';
  if (e.status === 'confirmed') return `✅ ENTRY @ ${fmtET(e.ts)} (${e.mode || '?'} ${e.direction}, conf ${conf}%${grade})`;
  if (e.status === 'blocked')   return `⛔ BLOCKED @ ${fmtET(e.ts)} (${e.mode || '?'} ${e.direction}, conf ${conf}%${grade})`;
  return `⚠️  FILTERED @ ${fmtET(e.ts)} (${e.mode || '?'} ${e.direction}, conf ${conf}%${grade}) — ${e.filterRule ?? 'unknown rule'}`;
}

function describeLive(m: LiveMatch | null): string {
  if (!m) return 'verification disabled';
  if (m.enterDispatch) return `✅ ENTER @ ${fmtET(m.enterDispatch.ts)}`;
  if (!m.peakSignal) return 'NO SIGNAL (no same-direction signal in DB within ±5m)';
  const s = m.peakSignal;
  const meets = s.meets ? 'meets' : 'meets=false';
  return `❌ NO ENTRY (peak conf ${s.confidence.toFixed(3)} @ ${fmtET(s.ts)} ${meets} alignment=${s.alignment})`;
}

function printHuman(verified: VerifiedEntry[], args: CliArgs, barCount: number): void {
  const sessionLabel = args.includeETH ? 'ETH 04:00-20:00' : 'RTH 09:30-16:00';
  console.log(`[ideal-entries] ${args.ticker} ${args.date} ${sessionLabel} ET`);
  console.log(`  thresholds: window=${args.windowMin}m  minMFE=${args.minMfe}%  maxMAE=${args.maxMae}%  minR=${args.minR}${args.minVolMult > 0 ? `  minVolMult=${args.minVolMult}` : ''}`);
  console.log(`  bars: ${barCount}  verify backtest=${args.noBacktest ? 'no' : 'yes'}  verify live=${args.noLive ? 'no' : 'yes'}\n`);

  if (verified.length === 0) {
    console.log('  (no ideal entries — flat session, or thresholds too tight)');
    return;
  }

  for (const v of verified) {
    const e = v.ideal;
    const dirArrow = e.direction === 'long' ? '↑' : '↓';
    const entryTime = fmtET(barCloseTs(e.ts));
    const peakTime = fmtET(barCloseTs(e.peakTs));
    const priceStr = `$${e.entryPrice.toFixed(2)}→$${e.peakPrice.toFixed(2)}`;
    const stats = `MFE ${e.mfePct.toFixed(2)}% MAE ${e.maePct.toFixed(2)}% R=${e.rMultiple.toFixed(1)} TTP ${e.ttpMin.toFixed(0)}m`;
    console.log(`  entry ${entryTime} → peak ${peakTime}  ${dirArrow} ${e.direction.padEnd(5)}  ${priceStr.padEnd(22)} ${stats.padEnd(38)} ${e.grade}`);
    if (!args.noBacktest) console.log(`      backtest: ${describeBt(v.bt)}`);
    if (!args.noLive)     console.log(`      live:     ${describeLive(v.live)}`);
    if (!args.noBacktest || !args.noLive) console.log(`      verdict:  ${VERDICT_LABEL[v.verdict]}`);
  }

  const gc = { A: 0, B: 0, C: 0 } as Record<Grade, number>;
  let totalMfe = 0, bestMfe = 0;
  for (const v of verified) {
    gc[v.ideal.grade]++; totalMfe += v.ideal.mfePct; bestMfe = Math.max(bestMfe, v.ideal.mfePct);
  }
  console.log(`\n  ideal: ${verified.length} entries (A:${gc.A} B:${gc.B} C:${gc.C})  total MFE ${totalMfe.toFixed(2)}%  best ${bestMfe.toFixed(2)}%`);

  if (!args.noBacktest || !args.noLive) {
    const vc: Record<Verdict, number> = {
      BOTH_EXEC: 0, PARITY_GAP: 0, ALGO_GAP: 0, BLIND: 0, BT_ONLY_DETECT_LIVE_EXEC: 0, NO_DATA: 0,
    };
    for (const v of verified) vc[v.verdict]++;
    console.log(`  verdicts:`);
    for (const k of ['BOTH_EXEC', 'PARITY_GAP', 'ALGO_GAP', 'BLIND', 'BT_ONLY_DETECT_LIVE_EXEC'] as Verdict[]) {
      if (vc[k] > 0) console.log(`    ${VERDICT_LABEL[k]}: ${vc[k]}`);
    }
  }
}

function printCSV(verified: VerifiedEntry[], args: CliArgs): void {
  console.log('ticker,date,entry_time_et,peak_time_et,direction,entry,peak,mfe_pct,mae_pct,r,ttp_min,grade,bt_status,bt_conf,live_peak_conf,live_meets,live_entered,verdict');
  for (const v of verified) {
    const e = v.ideal;
    const btStatus = v.bt?.entry?.status ?? '';
    const btConf = v.bt?.entry ? v.bt.entry.confidence.toFixed(3) : '';
    const livePeakConf = v.live?.peakSignal ? v.live.peakSignal.confidence.toFixed(3) : '';
    const liveMeets = v.live?.peakSignal ? String(v.live.peakSignal.meets) : '';
    const liveEntered = v.live?.enterDispatch ? 'true' : 'false';
    console.log([
      args.ticker, args.date,
      fmtET(barCloseTs(e.ts)), fmtET(barCloseTs(e.peakTs)),
      e.direction, e.entryPrice.toFixed(2), e.peakPrice.toFixed(2),
      e.mfePct.toFixed(3), e.maePct.toFixed(3),
      e.rMultiple.toFixed(2), e.ttpMin.toFixed(1), e.grade,
      btStatus, btConf, livePeakConf, liveMeets, liveEntered, v.verdict,
    ].join(','));
  }
}

function printJSON(verified: VerifiedEntry[], args: CliArgs): void {
  console.log(JSON.stringify({
    ticker: args.ticker, date: args.date,
    thresholds: {
      window_min: args.windowMin, min_mfe_pct: args.minMfe, max_mae_pct: args.maxMae,
      min_r: args.minR, min_vol_mult: args.minVolMult,
    },
    verify: { backtest: !args.noBacktest, live: !args.noLive },
    entries: verified.map(v => verifiedEntryToJson(v)),
  }, null, 2));
}

function verifiedEntryToJson(v: VerifiedEntry) {
  const e = v.ideal;
  return {
    entry_time_et: fmtET(barCloseTs(e.ts)),
    entry_ts_utc: new Date(barCloseTs(e.ts)).toISOString(),
    peak_time_et: fmtET(barCloseTs(e.peakTs)),
    peak_ts_utc: new Date(barCloseTs(e.peakTs)).toISOString(),
    direction: e.direction,
    entry_price: e.entryPrice, peak_price: e.peakPrice,
    mfe_pct: Number(e.mfePct.toFixed(3)),
    mae_pct: Number(e.maePct.toFixed(3)),
    r_multiple: Number(e.rMultiple.toFixed(2)),
    ttp_min: Number(e.ttpMin.toFixed(1)),
    grade: e.grade,
    backtest: v.bt?.entry ? {
      time_et: fmtET(v.bt.entry.ts), status: v.bt.entry.status,
      direction: v.bt.entry.direction, confidence: v.bt.entry.confidence,
      mode: v.bt.entry.mode, grade: v.bt.entry.grade,
      filter_rule: v.bt.entry.filterRule,
    } : null,
    live: v.live ? {
      peak_signal: v.live.peakSignal ? {
        time_et: fmtET(v.live.peakSignal.ts),
        confidence: v.live.peakSignal.confidence,
        meets: v.live.peakSignal.meets,
        alignment: v.live.peakSignal.alignment,
      } : null,
      enter_dispatch: v.live.enterDispatch ? { time_et: fmtET(v.live.enterDispatch.ts) } : null,
    } : null,
    verdict: v.verdict,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs();
  const { startUTC, endUTC } = sessionWindowUTC(args.date, args.includeETH);

  const bars = await fetch1mBars(args.ticker, startUTC, endUTC);
  if (bars.length === 0) {
    console.log(`[ideal-entries] ${args.ticker} ${args.date}: no bars (weekend/holiday/invalid ticker)`);
    return;
  }
  if (bars.length < args.windowMin + 5) {
    console.log(`[ideal-entries] ${args.ticker} ${args.date}: only ${bars.length} bars`);
    return;
  }

  const ideals = findIdealEntries(bars, args);

  let btResult: BtEntry[] | null = null;
  let liveResult: { signals: LiveSnapshot[]; dispatches: LiveDispatch[] } | null = null;
  const tasks: Promise<any>[] = [];
  if (!args.noBacktest && ideals.length > 0) {
    if (args.output === 'human') console.log(`[verify] running backtest-day.ts ${args.date} ${args.ticker} --json (cached if available) ...`);
    tasks.push(Promise.resolve().then(() => { btResult = runBacktestCli(args.ticker, args.date); }));
  }
  if (!args.noLive && ideals.length > 0) {
    tasks.push(fetchLiveLayer(args.ticker, args.date).then(r => { liveResult = r; }).catch(e => {
      console.error(`[live] DB query failed: ${e.message ?? e}`);
    }));
  }
  await Promise.all(tasks);

  const verified: VerifiedEntry[] = ideals.map(ideal => {
    const bt = !args.noBacktest && btResult ? matchBacktest(ideal, btResult) : null;
    const live = !args.noLive && liveResult ? matchLive(ideal, liveResult.signals, liveResult.dispatches) : null;
    const verdict: Verdict = (args.noBacktest && args.noLive) ? 'NO_DATA' : classifyVerdict(bt, live);
    return { ideal, bt, live, verdict };
  });

  if (args.output === 'csv') printCSV(verified, args);
  else if (args.output === 'json') printJSON(verified, args);
  else printHuman(verified, args, bars.length);
})().catch(e => { console.error(e); process.exit(1); });
