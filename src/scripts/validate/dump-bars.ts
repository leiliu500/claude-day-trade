#!/usr/bin/env npx tsx
/**
 * dump-bars.ts — Step 1 of correctness proof: data layer.
 *
 * Pulls SPY 1-minute bars from Alpaca SIP for a chosen session, filters to
 * Regular Trading Hours (09:30–16:00 ET), aggregates to 5m and 15m, and writes
 * CSVs in the ThinkorSwim "Save As..." format so they can be diffed directly
 * against a ToS chart export.
 *
 * Usage:
 *   npx tsx src/scripts/validate/dump-bars.ts [YYYY-MM-DD] [TICKER] [OUT_DIR]
 *   Defaults: today, SPY, ./validate-out/<DATE>
 *
 * Output:
 *   <OUT_DIR>/bars-1m.csv
 *   <OUT_DIR>/bars-5m.csv
 *   <OUT_DIR>/bars-15m.csv
 *   <OUT_DIR>/session-summary.txt   (open / high / low / close / volume)
 *
 * ToS comparison procedure:
 *   1. In ToS, set chart to TICKER, 1m, RTH only, the same date.
 *   2. Right-click chart → Save Time Series As → CSV.
 *   3. `diff <(sort tos.csv) <(sort bars-1m.csv)` — should be byte-equal on OHLCV.
 *   4. Repeat for 5m / 15m.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../../config.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../../types/market.js';
import { normalizeAlpacaBars } from '../../types/market.js';

const argv = process.argv.slice(2);
const TARGET_DATE = argv[0] || new Date().toISOString().slice(0, 10);
const TICKER = argv[1] || 'SPY';
const OUT_DIR = argv[2] || join('validate-out', TARGET_DATE);

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string, timeframe: Timeframe, start: string, end: string,
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const all: OHLCVBar[] = [];
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
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    all.push(...normalizeAlpacaBars(data));
    if (data.next_page_token) pageToken = data.next_page_token;
    else break;
  }
  return all;
}

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function tsToET(ts: string): { date: string; time: string; minutesFromMidnight: number } {
  const parts = ET_PARTS.formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    minutesFromMidnight: parseInt(hour, 10) * 60 + parseInt(get('minute'), 10),
  };
}

function isRTH(ts: string, targetDate: string): boolean {
  const et = tsToET(ts);
  if (et.date !== targetDate) return false;
  return et.minutesFromMidnight >= 9 * 60 + 30 && et.minutesFromMidnight < 16 * 60;
}

function aggregate(bars1m: OHLCVBar[], n: number): OHLCVBar[] {
  if (n <= 1) return bars1m;
  const bucketMs = n * 60_000;
  const groups = new Map<number, OHLCVBar[]>();
  for (const b of bars1m) {
    const ts = new Date(b.timestamp).getTime();
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    let g = groups.get(bucket);
    if (!g) { g = []; groups.set(bucket, g); }
    g.push(b);
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

function writeCsv(path: string, bars: OHLCVBar[]): void {
  const lines = ['Date,Time,Open,High,Low,Close,Volume'];
  for (const b of bars) {
    const et = tsToET(b.timestamp);
    lines.push([
      et.date, et.time,
      b.open.toFixed(2), b.high.toFixed(2), b.low.toFixed(2), b.close.toFixed(2),
      String(b.volume),
    ].join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

async function main(): Promise<void> {
  console.log(`Fetching ${TICKER} 1m bars for ${TARGET_DATE} from Alpaca SIP…`);
  // Pull a wide window then filter to RTH so the user can also see pre/post if they want.
  const start = `${TARGET_DATE}T00:00:00Z`;
  const end = `${TARGET_DATE}T23:59:59Z`;
  const raw = await fetchBarsRange(TICKER, '1m', start, end);
  const rth1m = raw.filter(b => isRTH(b.timestamp, TARGET_DATE));
  if (rth1m.length === 0) {
    console.error(`No RTH bars for ${TICKER} on ${TARGET_DATE} (market holiday or future date?)`);
    process.exit(1);
  }
  console.log(`  → ${raw.length} raw bars, ${rth1m.length} after RTH filter`);

  const bars5m = aggregate(rth1m, 5);
  const bars15m = aggregate(rth1m, 15);

  mkdirSync(OUT_DIR, { recursive: true });
  writeCsv(join(OUT_DIR, 'bars-1m.csv'), rth1m);
  writeCsv(join(OUT_DIR, 'bars-5m.csv'), bars5m);
  writeCsv(join(OUT_DIR, 'bars-15m.csv'), bars15m);

  // Session summary for quick eyeball check vs ToS chart
  const open = rth1m[0]!.open;
  const close = rth1m[rth1m.length - 1]!.close;
  const high = Math.max(...rth1m.map(b => b.high));
  const low = Math.min(...rth1m.map(b => b.low));
  const vol = rth1m.reduce((s, b) => s + b.volume, 0);
  const summary = [
    `${TICKER} ${TARGET_DATE} RTH session summary (Alpaca SIP)`,
    `  Open:    ${open.toFixed(2)}`,
    `  High:    ${high.toFixed(2)}`,
    `  Low:     ${low.toFixed(2)}`,
    `  Close:   ${close.toFixed(2)}`,
    `  Volume:  ${vol.toLocaleString()}`,
    `  1m bars: ${rth1m.length} (expected 390)`,
    `  5m bars: ${bars5m.length} (expected 78)`,
    `  15m bars: ${bars15m.length} (expected 26)`,
  ].join('\n');
  writeFileSync(join(OUT_DIR, 'session-summary.txt'), summary + '\n', 'utf-8');

  console.log(`\nWrote:`);
  console.log(`  ${join(OUT_DIR, 'bars-1m.csv')}`);
  console.log(`  ${join(OUT_DIR, 'bars-5m.csv')}`);
  console.log(`  ${join(OUT_DIR, 'bars-15m.csv')}`);
  console.log(`  ${join(OUT_DIR, 'session-summary.txt')}`);
  console.log(`\n${summary}`);
}

main().catch(err => { console.error(err); process.exit(1); });
