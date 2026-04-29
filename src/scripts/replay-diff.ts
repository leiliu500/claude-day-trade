/**
 * replay-diff.ts — Compare live signals (DB) against re-computed direction
 * at the SAME tick timestamps. Quantifies live↔backtest divergence.
 *
 * Usage:
 *   npx tsx src/scripts/replay-diff.ts <YYYY-MM-DD> <TICKER>
 *
 * Pulls every signal_snapshot for the day from the DB, then for each one:
 *   1. Builds a stream cache of 1m bars with timestamp < live_tick_ts
 *   2. Aggregates to 3m/5m using upToTs = live_tick_ts
 *   3. Runs detectDirection() with a persistence state that has been
 *      replayed through every prior live tick (same order as live saw them)
 *   4. Diffs the recomputed direction/overrides/DMI trends vs what the DB
 *      recorded from the live pipeline
 *
 * A MATCH means the backtest can faithfully reproduce live direction.
 * A MISS means state/data/logic has drifted — investigate further.
 */

import 'dotenv/config';
import { config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { detectDirection, type PersistenceState } from '../lib/direction-detector.js';

const TARGET_DATE = process.argv[2];
const TICKER = process.argv[3];

if (!TARGET_DATE || !TICKER) {
  console.error('Usage: npx tsx src/scripts/replay-diff.ts <YYYY-MM-DD> <TICKER>');
  process.exit(1);
}

// ── Alpaca REST fetch ────────────────────────────────────────────────────────

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string,
  timeframe: Timeframe,
  start: string,
  end: string,
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const allBars: OHLCVBar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF[timeframe]);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    allBars.push(...normalizeAlpacaBars(data));
    if (data.next_page_token) pageToken = data.next_page_token;
    else break;
  }
  return allBars;
}

// ── Bar aggregation (matches alpaca-stream.ts _aggregate + backtest-day.ts) ─

function aggregate1mBars(oneMins: OHLCVBar[], timeframe: Timeframe, upToTs: number): OHLCVBar[] {
  const n = { '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 }[timeframe] ?? 1;
  if (n <= 1) return oneMins.filter(b => new Date(b.timestamp).getTime() <= upToTs);
  const bucketMs = n * 60_000;
  const currentBucket = Math.floor(upToTs / bucketMs) * bucketMs;
  const groups = new Map<number, OHLCVBar[]>();
  for (const bar of oneMins) {
    const ts = new Date(bar.timestamp).getTime();
    if (ts > upToTs) continue;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (bucket >= currentBucket) continue;
    let g = groups.get(bucket);
    if (!g) { g = []; groups.set(bucket, g); }
    g.push(bar);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, bars]) => ({
      timestamp: new Date(bucket).toISOString(),
      open: bars[0]!.open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1]!.close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    }));
}

// ── Regular session filter ─────────────────────────────────────────────────

function isRegularSession(iso: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function utcToET(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(iso));
}

// ── Types for DB rows ─────────────────────────────────────────────────────

interface LiveTickRow {
  created_at: Date;
  direction: 'bullish' | 'bearish' | 'neutral';
  alignment: string;
  signal_payload: {
    timeframes?: Array<{
      dmi?: { trend?: string; plusDI?: number; minusDI?: number; adx?: number };
    }>;
    leadingSignalOverride?: boolean | null;
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n════════════════════════════════════════════════════════════════════`);
  console.log(`  REPLAY-DIFF: ${TICKER} ${TARGET_DATE}`);
  console.log(`════════════════════════════════════════════════════════════════════\n`);

  const pool = getPool();
  const { rows: liveRows } = await pool.query<LiveTickRow>(
    `SELECT created_at, direction, alignment, signal_payload
     FROM trading.signal_snapshots
     WHERE ticker = $1 AND trade_date = $2
     ORDER BY created_at ASC`,
    [TICKER, TARGET_DATE]
  );

  if (liveRows.length === 0) {
    console.log(`No live signals found for ${TICKER} on ${TARGET_DATE}.`);
    await closePool();
    return;
  }
  console.log(`  Live ticks in DB: ${liveRows.length}`);

  // Fetch 1m bars spanning warmup (4 days prior) through target date close
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 5);
  const endOfDay = new Date(`${TARGET_DATE}T23:59:59Z`);
  const oneMins = await fetchBarsRange(
    TICKER,
    '1m',
    warmupStart.toISOString(),
    endOfDay.toISOString(),
  );
  console.log(`  Fetched 1m bars: ${oneMins.length}`);

  // Separate warmup (prior days) vs today
  const dayStart = new Date(`${TARGET_DATE}T00:00:00Z`).getTime();
  const priorBars = oneMins
    .filter(b => new Date(b.timestamp).getTime() < dayStart)
    .filter(b => isRegularSession(b.timestamp));
  const todayBars = oneMins
    .filter(b => new Date(b.timestamp).getTime() >= dayStart);

  // Seed stream cache matching alpaca-stream.ts seedHistoricalBars (post-fix):
  // paginate all 1m bars from 4 days back, filter to regular session, trim to 800.
  const BAR_CACHE_SIZE = 800;
  const streamCache: OHLCVBar[] = priorBars.slice(-BAR_CACHE_SIZE);
  console.log(`  Seed cache: ${priorBars.length} prior-session 1m bars → cache ${streamCache.length}`);

  // Walk live ticks in order, advancing streamCache with bars that would have
  // arrived before each tick. This replicates the persistence-state trajectory.
  const persistence: PersistenceState = { dir: null, ts: 0 };
  let todayBarIdx = 0;

  let matches = 0;
  let dirMismatch = 0;
  let overrideMismatch = 0;
  let dmiMismatch = 0;
  const divergences: Array<{
    time: string;
    liveDir: string;
    btDir: string;
    liveLeading: boolean;
    btLeading: boolean;
    liveReversal: boolean;
    btReversal: boolean;
    liveLtfDmi: string;
    btLtfDmi: string;
    liveMtfDmi: string;
    btMtfDmi: string;
    liveHtfDmi: string;
    btHtfDmi: string;
  }> = [];

  console.log(`\n  Walking ${liveRows.length} live ticks...\n`);

  for (const row of liveRows) {
    const liveTs = row.created_at.getTime();

    // Advance cache: add 1m bars whose timestamp is before this tick fired.
    // Live: stream emits bar event when bar arrives, pipeline runs with
    // Date.now()≈tick_ts. Cache has bars with ts < tick_ts.
    while (todayBarIdx < todayBars.length) {
      const barTs = new Date(todayBars[todayBarIdx]!.timestamp).getTime();
      if (barTs < liveTs) {
        streamCache.push(todayBars[todayBarIdx]!);
        if (streamCache.length > BAR_CACHE_SIZE) streamCache.shift();
        todayBarIdx++;
      } else break;
    }

    if (streamCache.length < 20) continue;

    const ltfBars = streamCache.slice(-500);
    const mtfBars = aggregate1mBars(streamCache, '3m', liveTs).slice(-500);
    const htfBars = aggregate1mBars(streamCache, '5m', liveTs).slice(-500);
    if (ltfBars.length < 14 || mtfBars.length < 14 || htfBars.length < 14) continue;

    const { direction, dmiOnly, reversalOverride, leadingSignalOverride } =
      detectDirection(ltfBars, mtfBars, htfBars, true, persistence, liveTs);

    // Extract live's recorded values
    const tfs = row.signal_payload.timeframes ?? [];
    const liveLtf = tfs[0]?.dmi?.trend ?? '?';
    const liveMtf = tfs[1]?.dmi?.trend ?? '?';
    const liveHtf = tfs[2]?.dmi?.trend ?? '?';
    const liveLeading = !!row.signal_payload.leadingSignalOverride;
    // reversalOverride isn't stored at top level — infer from mismatch; we only
    // track direction & leadingOverride accurately in live data.

    const dirMatch = row.direction === direction;
    const leadingMatch = liveLeading === leadingSignalOverride;
    const dmiMatch = liveLtf === dmiOnly[0].trend
                  && liveMtf === dmiOnly[1].trend
                  && liveHtf === dmiOnly[2].trend;

    if (dirMatch && leadingMatch && dmiMatch) {
      matches++;
    } else {
      if (!dirMatch) dirMismatch++;
      if (!leadingMatch) overrideMismatch++;
      if (!dmiMatch) dmiMismatch++;
      divergences.push({
        time: utcToET(row.created_at.toISOString()),
        liveDir: row.direction,
        btDir: direction,
        liveLeading,
        btLeading: leadingSignalOverride,
        liveReversal: false,
        btReversal: reversalOverride,
        liveLtfDmi: liveLtf,
        btLtfDmi: dmiOnly[0].trend,
        liveMtfDmi: liveMtf,
        btMtfDmi: dmiOnly[1].trend,
        liveHtfDmi: liveHtf,
        btHtfDmi: dmiOnly[2].trend,
      });
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const total = liveRows.length;
  console.log(`  Total ticks compared: ${total}`);
  console.log(`  Matches:              ${matches} (${(matches * 100 / total).toFixed(1)}%)`);
  console.log(`  Direction mismatch:   ${dirMismatch}`);
  console.log(`  Leading-override ≠:   ${overrideMismatch}`);
  console.log(`  DMI-trend ≠:          ${dmiMismatch}`);

  if (divergences.length > 0) {
    console.log(`\n  ── First 30 divergences ──\n`);
    console.log(`  Time      LiveDir  BT Dir   L-Lead  BT-Lead  BT-Rev  LTF(L/B)     MTF(L/B)     HTF(L/B)`);
    console.log(`  ${'─'.repeat(100)}`);
    for (const d of divergences.slice(0, 30)) {
      const dirFlag = d.liveDir !== d.btDir ? '⚠ ' : '  ';
      console.log(
        `  ${d.time}  ${dirFlag}${d.liveDir.padEnd(7)} ${d.btDir.padEnd(7)} ` +
        `${String(d.liveLeading).padEnd(6)} ${String(d.btLeading).padEnd(7)} ${String(d.btReversal).padEnd(6)} ` +
        `${d.liveLtfDmi}/${d.btLtfDmi}   ${d.liveMtfDmi}/${d.btMtfDmi}   ${d.liveHtfDmi}/${d.btHtfDmi}`
      );
    }
  }

  console.log();
  await closePool();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
