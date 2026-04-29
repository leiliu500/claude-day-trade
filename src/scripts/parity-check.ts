/**
 * parity-check.ts — Direct bar/indicator parity between live recorded data
 * and backtest REST source for a given trade date + ticker.
 *
 * Approach: pick a tick, extract live's recorded HTF bars from signal_payload,
 * fetch the same window from REST, diff bar-by-bar. Then re-run computeDMI on
 * both bar sets and compare indicator outputs. Bypasses any cache simulation.
 *
 * Usage: npx tsx src/scripts/parity-check.ts <YYYY-MM-DD> <TICKER>
 */
import 'dotenv/config';
import { config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
import { computeDMI } from '../indicators/dmi.js';
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
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
}
interface RecordedDmi {
  adx: number;
  plusDI: number;
  minusDI: number;
  trend: string;
}
interface SnapshotRow {
  created_at: Date;
  direction: string;
  signal_payload: {
    timeframes: Array<{
      bars: RecordedBar[];
      dmi: RecordedDmi;
    }>;
  };
}

async function fetchRestBars(ticker: string, timeframe: string, start: string, end: string): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const out: OHLCVBar[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', timeframe);
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

async function main() {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  PARITY CHECK: ${TICKER} ${TARGET_DATE}`);
  console.log(`${'═'.repeat(78)}\n`);

  const pool = getPool();
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT created_at, direction, signal_payload
     FROM trading.signal_snapshots
     WHERE ticker=$1 AND trade_date=$2
     ORDER BY created_at ASC`,
    [TICKER, TARGET_DATE]
  );
  if (rows.length === 0) {
    console.log('No snapshots');
    await closePool();
    return;
  }
  console.log(`  Live snapshots: ${rows.length}\n`);

  // Pick 6 evenly-spaced ticks across the day
  const picks: SnapshotRow[] = [];
  const stride = Math.max(1, Math.floor(rows.length / 6));
  for (let i = 0; i < rows.length && picks.length < 6; i += stride) picks.push(rows[i]!);
  if (picks[picks.length - 1] !== rows[rows.length - 1]) picks.push(rows[rows.length - 1]!);

  // Fetch REST 5m and 1m bars over the full window
  const start = `${TARGET_DATE}T00:00:00Z`;
  const startWarmup = new Date(new Date(TARGET_DATE).getTime() - 6 * 86400_000).toISOString();
  const end = new Date().toISOString();
  console.log(`  Fetching REST 5m bars (${startWarmup} → ${end})...`);
  const rest5m = await fetchRestBars(TICKER, '5Min', startWarmup, end);
  const rest5mFiltered = rest5m.filter(b => isRegularSession(b.timestamp));
  console.log(`    Got ${rest5m.length} raw, ${rest5mFiltered.length} regular-session 5m bars\n`);

  let totalBarMismatches = 0;
  let totalIndicatorMismatches = 0;

  for (const snap of picks) {
    const tickET = utcToET(snap.created_at);
    const tickTs = snap.created_at.getTime();
    const tfs = snap.signal_payload.timeframes;
    const liveHtfBars = tfs[2]!.bars;
    const liveHtfDmi = tfs[2]!.dmi;

    console.log(`  ── Tick ${tickET} ET (${snap.created_at.toISOString()}) | live dir=${snap.direction} ──`);
    console.log(`     Live HTF bars: ${liveHtfBars.length}, first=${liveHtfBars[0]!.timestamp}, last=${liveHtfBars[liveHtfBars.length - 1]!.timestamp}`);
    console.log(`     Live HTF DMI: trend=${liveHtfDmi.trend} adx=${liveHtfDmi.adx.toFixed(2)} +DI=${liveHtfDmi.plusDI.toFixed(2)} -DI=${liveHtfDmi.minusDI.toFixed(2)}`);

    // Find REST 5m bars in the same window as live's recorded HTF
    const liveFirstTs = new Date(liveHtfBars[0]!.timestamp).getTime();
    const liveLastTs = new Date(liveHtfBars[liveHtfBars.length - 1]!.timestamp).getTime();
    const restWindow = rest5mFiltered.filter(b => {
      const ts = new Date(b.timestamp).getTime();
      return ts >= liveFirstTs && ts <= liveLastTs;
    });
    console.log(`     REST  5m bars in same window: ${restWindow.length}`);

    // Bar-by-bar diff (ignore the in-flight current bar — it differs by design)
    const tsKey = (s: string) => new Date(s).getTime();
    const liveByTs = new Map<number, RecordedBar>();
    for (const b of liveHtfBars) liveByTs.set(tsKey(b.timestamp), b);
    const restByTs = new Map<number, OHLCVBar>();
    for (const b of restWindow) restByTs.set(tsKey(b.timestamp), b);

    let presenceMisses = 0;
    let ohlcMisses = 0;
    const presentInBoth: number[] = [];
    let maxOhlcDelta = 0;
    let maxOhlcDeltaTs: string | null = null;
    for (const ts of liveByTs.keys()) {
      if (!restByTs.has(ts)) { presenceMisses++; continue; }
      presentInBoth.push(ts);
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
        if (delta > maxOhlcDelta) { maxOhlcDelta = delta; maxOhlcDeltaTs = lb.timestamp; }
      }
    }
    if (maxOhlcDeltaTs) {
      const lb = liveByTs.get(new Date(maxOhlcDeltaTs).getTime())!;
      const rb = restByTs.get(new Date(maxOhlcDeltaTs).getTime())!;
      console.log(`     Worst OHLC delta: ${maxOhlcDelta.toFixed(4)} @ ${maxOhlcDeltaTs}`);
      console.log(`       live: o=${lb.open} h=${lb.high} l=${lb.low} c=${lb.close} v=${lb.volume}`);
      console.log(`       rest: o=${rb.open} h=${rb.high} l=${rb.low} c=${rb.close} v=${rb.volume}`);
    }
    let restOnly = 0;
    for (const ts of restByTs.keys()) if (!liveByTs.has(ts)) restOnly++;
    console.log(`     Bar diff: ${presentInBoth.length} matching, ${presenceMisses} live-only-ts, ${restOnly} rest-only-ts, ${ohlcMisses} OHLC mismatches`);
    if (presenceMisses + restOnly + ohlcMisses > 0) totalBarMismatches++;

    // Re-run DMI on each bar set, compare last-bar values
    const liveBarsAsOHLCV: OHLCVBar[] = liveHtfBars.map(b => ({
      timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }));
    const recomputedFromLive = computeDMI(liveBarsAsOHLCV, 14, true);
    const recomputedFromRest = computeDMI(restWindow, 14, true);
    const fmtDmi = (d: { adx: number; plusDI: number; minusDI: number; trend: string }) =>
      `trend=${d.trend} adx=${d.adx.toFixed(2)} +DI=${d.plusDI.toFixed(2)} -DI=${d.minusDI.toFixed(2)}`;
    console.log(`     Recompute(live-bars): ${fmtDmi(recomputedFromLive)}`);
    console.log(`     Recompute(rest-bars): ${fmtDmi(recomputedFromRest)}`);

    const indicatorMatch =
      recomputedFromRest.trend === liveHtfDmi.trend &&
      Math.abs(recomputedFromRest.adx - liveHtfDmi.adx) < 0.5;
    if (!indicatorMatch) {
      totalIndicatorMismatches++;
      console.log(`     ⚠️  REST recompute disagrees with live DMI`);
    }
    console.log('');
  }

  console.log(`  ${'─'.repeat(74)}`);
  console.log(`  SUMMARY`);
  console.log(`    Ticks checked:            ${picks.length}`);
  console.log(`    Ticks with bar mismatch:  ${totalBarMismatches}`);
  console.log(`    Ticks w/ indicator drift: ${totalIndicatorMismatches}`);
  console.log(`${'═'.repeat(78)}\n`);

  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
