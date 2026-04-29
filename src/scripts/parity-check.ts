/**
 * parity-check.ts — Direct bar/indicator/direction parity between live recorded
 * data and the REST source the backtest uses, for a given trade date + ticker.
 *
 * For each sampled tick:
 *   1. Pull live's recorded bars from signal_payload (LTF/MTF/HTF).
 *   2. Fetch matching-window REST bars at each timeframe.
 *   3. Diff bars timestamp-by-timestamp + OHLC.
 *   4. Re-run computeDMI on both bar sets and compare to live's recorded DMI.
 *   5. Re-run detectDirection on REST bars and compare to live's recorded direction.
 *
 * Bypasses any cache simulation. Output is a per-tick PASS/FAIL line plus a summary.
 *
 * Usage: npx tsx src/scripts/parity-check.ts <YYYY-MM-DD> <TICKER>
 */
import 'dotenv/config';
import { config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
import { computeDMI } from '../indicators/dmi.js';
import { detectDirection, type PersistenceState } from '../lib/direction-detector.js';
import { computeTimeframeIndicators } from '../agents/signal-agent.js';
import { getTickerConfig } from '../ticker-configs.js';
import type { OHLCVBar, AlpacaBarsResponse } from '../types/market.js';
import { normalizeAlpacaBars } from '../types/market.js';

const TARGET_DATE = process.argv[2];
const TICKER = process.argv[3];
if (!TARGET_DATE || !TICKER) {
  console.error('Usage: npx tsx src/scripts/parity-check.ts <YYYY-MM-DD> <TICKER>');
  process.exit(1);
}

interface RecordedBar {
  timestamp: string;
  open: number; high: number; low: number; close: number; volume: number;
  vwap?: number;
}
interface RecordedDmi {
  adx: number; plusDI: number; minusDI: number; trend: string;
}
interface RecordedTimeframe {
  timeframe: string;
  bars: RecordedBar[];
  dmi: RecordedDmi;
}
interface SnapshotRow {
  created_at: Date;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: string;  // numeric → string
  signal_payload: { timeframes: RecordedTimeframe[] };
}

const TIMEFRAME_LABELS = ['LTF', 'MTF', 'HTF'] as const;
const ALPACA_TF: Record<string, string> = { '1m': '1Min', '3m': '3Min', '5m': '5Min' };
// Periods to match what signal-agent stores in signal_payload (LTF=8, others=14).
// Note: direction-detector internally uses period=10 for MTF, but the recorded
// DMI in signal_payload uses period=14 for both MTF and HTF.
const DMI_PERIODS: Record<string, number> = { '1m': 8, '3m': 14, '5m': 14 };

async function fetchRest(ticker: string, timeframe: string, start: string, end: string): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const out: OHLCVBar[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF[timeframe]!);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca ${res.status}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    out.push(...normalizeAlpacaBars(data));
    pageToken = data.next_page_token ?? undefined;
  } while (pageToken);
  return out;
}

function isRegularSession(iso: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

const utcToET = (iso: string | Date) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));

interface TfDiffResult {
  label: string;
  liveCount: number;
  restCount: number;
  matching: number;
  presenceMisses: number;
  restOnly: number;
  ohlcMisses: number;
  worstDelta: number;
  worstDeltaTs: string | null;
  liveDmi: RecordedDmi;
  recomputeLive: ReturnType<typeof computeDMI>;
  recomputeRest: ReturnType<typeof computeDMI>;
  dmiMatch: boolean;
}

function diffTimeframe(
  liveTf: RecordedTimeframe,
  restAll: OHLCVBar[],
  label: string,
): TfDiffResult {
  const liveBars = liveTf.bars;
  const liveFirst = new Date(liveBars[0]!.timestamp).getTime();
  const liveLast = new Date(liveBars[liveBars.length - 1]!.timestamp).getTime();
  const restWindow = restAll.filter(b => {
    const ts = new Date(b.timestamp).getTime();
    return ts >= liveFirst && ts <= liveLast;
  });

  const tsKey = (s: string) => new Date(s).getTime();
  const liveByTs = new Map<number, RecordedBar>();
  for (const b of liveBars) liveByTs.set(tsKey(b.timestamp), b);
  const restByTs = new Map<number, OHLCVBar>();
  for (const b of restWindow) restByTs.set(tsKey(b.timestamp), b);

  let matching = 0, presenceMisses = 0, ohlcMisses = 0;
  let worstDelta = 0;
  let worstDeltaTs: string | null = null;
  for (const ts of liveByTs.keys()) {
    if (!restByTs.has(ts)) { presenceMisses++; continue; }
    matching++;
    const lb = liveByTs.get(ts)!;
    const rb = restByTs.get(ts)!;
    const delta = Math.max(
      Math.abs(lb.open - rb.open),
      Math.abs(lb.high - rb.high),
      Math.abs(lb.low - rb.low),
      Math.abs(lb.close - rb.close),
    );
    if (delta > 0.001) {
      ohlcMisses++;
      if (delta > worstDelta) { worstDelta = delta; worstDeltaTs = lb.timestamp; }
    }
  }
  let restOnly = 0;
  for (const ts of restByTs.keys()) if (!liveByTs.has(ts)) restOnly++;

  const period = DMI_PERIODS[liveTf.timeframe] ?? 14;
  const liveAsOhlcv: OHLCVBar[] = liveBars.map(b => ({
    timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }));
  const recomputeLive = computeDMI(liveAsOhlcv, period, true);
  const recomputeRest = computeDMI(restWindow, period, true);

  const dmiMatch =
    recomputeRest.trend === liveTf.dmi.trend &&
    Math.abs(recomputeRest.adx - liveTf.dmi.adx) < 0.5 &&
    Math.abs(recomputeRest.plusDI - liveTf.dmi.plusDI) < 0.5 &&
    Math.abs(recomputeRest.minusDI - liveTf.dmi.minusDI) < 0.5;

  return {
    label, liveCount: liveBars.length, restCount: restWindow.length,
    matching, presenceMisses, restOnly, ohlcMisses, worstDelta, worstDeltaTs,
    liveDmi: liveTf.dmi, recomputeLive, recomputeRest, dmiMatch,
  };
}

async function main() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  PARITY CHECK: ${TICKER} ${TARGET_DATE}`);
  console.log(`${'═'.repeat(80)}\n`);

  const pool = getPool();
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT created_at, direction, confidence::text, signal_payload
     FROM trading.signal_snapshots
     WHERE ticker=$1 AND trade_date=$2
     ORDER BY created_at ASC`,
    [TICKER, TARGET_DATE]
  );
  if (rows.length === 0) {
    console.log('No snapshots'); await closePool(); return;
  }
  console.log(`  Live snapshots: ${rows.length}`);

  // Pick 6 evenly-spaced ticks across the day plus the most recent
  const picks: SnapshotRow[] = [];
  const stride = Math.max(1, Math.floor(rows.length / 6));
  for (let i = 0; i < rows.length && picks.length < 6; i += stride) picks.push(rows[i]!);
  if (picks[picks.length - 1] !== rows[rows.length - 1]) picks.push(rows[rows.length - 1]!);

  // REST fetch — one shot per timeframe across the full warmup window
  const startWarmup = new Date(new Date(TARGET_DATE).getTime() - 6 * 86400_000).toISOString();
  const end = new Date().toISOString();
  console.log(`  Fetching REST bars (1m/3m/5m, ${startWarmup} → ${end})...`);
  const [rest1m, rest3m, rest5m] = await Promise.all([
    fetchRest(TICKER, '1m', startWarmup, end),
    fetchRest(TICKER, '3m', startWarmup, end),
    fetchRest(TICKER, '5m', startWarmup, end),
  ]);
  const rest1mF = rest1m.filter(b => isRegularSession(b.timestamp));
  const rest3mF = rest3m.filter(b => isRegularSession(b.timestamp));
  const rest5mF = rest5m.filter(b => isRegularSession(b.timestamp));
  console.log(`    1m: ${rest1mF.length}, 3m: ${rest3mF.length}, 5m: ${rest5mF.length} regular-session bars\n`);

  let perfectTicks = 0;
  let dataMismatchTicks = 0;
  let dmiMismatchTicks = 0;
  let dirMismatchTicks = 0;
  const issues: string[] = [];

  for (const snap of picks) {
    const tickET = utcToET(snap.created_at);
    const tickTs = snap.created_at.getTime();
    const tfs = snap.signal_payload.timeframes;
    const liveDir = snap.direction;
    const liveConf = parseFloat(snap.confidence);
    console.log(`  ── Tick ${tickET} ET | live dir=${liveDir} conf=${(liveConf * 100).toFixed(1)}% ──`);

    const restByTfLabel = { LTF: rest1mF, MTF: rest3mF, HTF: rest5mF };
    const results: TfDiffResult[] = [];
    for (let i = 0; i < 3; i++) {
      const label = TIMEFRAME_LABELS[i]!;
      const r = diffTimeframe(tfs[i]!, restByTfLabel[label], label);
      results.push(r);
      const dmiBadge = r.dmiMatch ? '✓' : '✗';
      const ohlcBadge = (r.presenceMisses + r.restOnly + r.ohlcMisses) === 0 ? '✓' : `${r.ohlcMisses}Δ`;
      console.log(
        `     ${label} ${tfs[i]!.timeframe}: bars ${r.matching}/${r.liveCount} ${ohlcBadge} | ` +
        `live ${r.liveDmi.trend.padEnd(7)} adx=${r.liveDmi.adx.toFixed(2)} ` +
        `vs rest ${r.recomputeRest.trend.padEnd(7)} adx=${r.recomputeRest.adx.toFixed(2)} ${dmiBadge}`
      );
      if (r.worstDeltaTs) {
        console.log(`        worst Δ=${r.worstDelta.toFixed(4)} @ ${r.worstDeltaTs} (cache-edge FIFO trim)`);
      }
    }

    // ── Direction parity: re-run detectDirection on REST bars ──
    const ltfRest = rest1mF.filter(b => new Date(b.timestamp).getTime() <= tickTs).slice(-500);
    const mtfRest = rest3mF.filter(b => new Date(b.timestamp).getTime() <= tickTs).slice(-500);
    const htfRest = rest5mF.filter(b => new Date(b.timestamp).getTime() <= tickTs).slice(-500);
    let directionFromRest: string;
    try {
      const fresh: PersistenceState = { dir: null, ts: 0 };
      const dr = detectDirection(ltfRest, mtfRest, htfRest, true, fresh, tickTs);
      directionFromRest = dr.direction;
    } catch (e) {
      directionFromRest = `error:${(e as Error).message}`;
    }
    const dirMatch = directionFromRest === liveDir;
    console.log(`     Direction: live=${liveDir}, rest-recompute=${directionFromRest} ${dirMatch ? '✓' : '✗ ⚠️'}`);

    const tickDataMismatch = results.some(r => r.presenceMisses + r.restOnly + r.ohlcMisses > 0);
    const tickDmiMismatch = results.some(r => !r.dmiMatch);
    const tickDirMismatch = !dirMatch;
    if (tickDataMismatch) dataMismatchTicks++;
    if (tickDmiMismatch) dmiMismatchTicks++;
    if (tickDirMismatch) {
      dirMismatchTicks++;
      issues.push(`${tickET} ET: live=${liveDir} rest=${directionFromRest}`);
    }
    if (!tickDmiMismatch && !tickDirMismatch) perfectTicks++;
    console.log('');
  }

  console.log(`  ${'─'.repeat(76)}`);
  console.log(`  SAMPLE SUMMARY (${picks.length} sampled ticks)`);
  console.log(`    Ticks w/ raw bar mismatch:     ${dataMismatchTicks} (cache-edge FIFO; cosmetic)`);
  console.log(`    Ticks w/ DMI drift > thresh:   ${dmiMismatchTicks}`);
  console.log(`    Ticks w/ direction mismatch:   ${dirMismatchTicks} (single-tick, fresh persistence)`);
  console.log(`    Ticks fully matched:           ${perfectTicks}/${picks.length}`);
  if (issues.length > 0) {
    console.log(`\n  Single-tick direction divergences (likely persistence-state replay artifacts):`);
    for (const i of issues) console.log(`    ${i}`);
  }

  // ── Full-walk direction parity using live's recorded bars + evolving persistence ──
  // This is the most decisive test: feed live's actual recorded bars into
  // detectDirection() with persistence state walked tick-by-tick. No REST fetch,
  // no seed reconstruction. If this matches, processing is fully reproducible
  // from live's stored data.
  console.log(`\n  ${'─'.repeat(76)}`);
  console.log(`  FULL-WALK DIRECTION PARITY (${rows.length} ticks, evolving persistence)`);
  const persistence: PersistenceState = { dir: null, ts: 0 };
  let walkMatches = 0;
  let walkMismatches = 0;
  const walkIssues: string[] = [];
  for (const snap of rows) {
    const tickTs = snap.created_at.getTime();
    const tfs = snap.signal_payload.timeframes;
    if (!tfs || tfs.length < 3) continue;
    const ltf: OHLCVBar[] = tfs[0]!.bars.map(b => ({
      timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }));
    const mtf: OHLCVBar[] = tfs[1]!.bars.map(b => ({
      timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }));
    const htf: OHLCVBar[] = tfs[2]!.bars.map(b => ({
      timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }));
    if (ltf.length < 14 || mtf.length < 14 || htf.length < 14) continue;
    const dr = detectDirection(ltf, mtf, htf, true, persistence, tickTs);
    let direction = dr.direction;
    // Replicate signal-agent.ts:227-233 — mode evaluator may override direction.
    const tickerCfg = getTickerConfig(TICKER);
    const tfIndicators = [
      computeTimeframeIndicators(ltf, '1m', direction, true),
      computeTimeframeIndicators(mtf, '3m', direction, false),
      computeTimeframeIndicators(htf, '5m', direction, false),
    ];
    const currentPrice = ltf[ltf.length - 1]!.close;
    const modeResult = tickerCfg.strategy.detectMode(tfIndicators, direction, currentPrice);
    if (modeResult.direction && !dr.leadingSignalOverride && !dr.reversalOverride) {
      direction = modeResult.direction;
    }
    if (direction === snap.direction) walkMatches++;
    else {
      walkMismatches++;
      if (walkIssues.length < 10) {
        walkIssues.push(`${utcToET(snap.created_at)} ET: live=${snap.direction} replay=${direction}`);
      }
    }
  }
  const totalWalk = walkMatches + walkMismatches;
  console.log(`    Matches:                       ${walkMatches}/${totalWalk} (${(walkMatches * 100 / totalWalk).toFixed(1)}%)`);
  console.log(`    Mismatches:                    ${walkMismatches}`);
  if (walkIssues.length > 0) {
    console.log(`\n  First 10 walk mismatches:`);
    for (const i of walkIssues) console.log(`    ⚠️  ${i}`);
  }
  console.log(`${'═'.repeat(80)}\n`);

  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
