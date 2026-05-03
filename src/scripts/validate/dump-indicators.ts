#!/usr/bin/env npx tsx
/**
 * dump-indicators.ts — Step 2 of correctness proof: indicator layer.
 *
 * For each minute of the chosen RTH session, walks the same way the live
 * scheduler does (1m bars + aggregated 5m / 15m), recomputes every indicator
 * the system uses, and emits a single wide CSV. The user can pick any timestamp,
 * pull up the same study on a ToS chart at that minute, and compare numbers.
 *
 * The indicators emitted here are the ones whose source files explicitly claim
 * ToS-parity formulas:
 *   MACD / EMA / VWAP / Stochastic / Bollinger / ATR / DMI(+ADX)
 *
 * Usage:
 *   npx tsx src/scripts/validate/dump-indicators.ts [YYYY-MM-DD] [TICKER] [SAMPLE_EVERY_N_MIN] [OUT_DIR]
 *   Defaults: today, SPY, 1, ./validate-out/<DATE>
 *
 *   SAMPLE_EVERY_N_MIN=15 → emit a row every 15 minutes (lighter, easier to spot-check).
 *   SAMPLE_EVERY_N_MIN=1  → emit a row per minute (full audit, ~390 rows).
 *
 * Output:
 *   <OUT_DIR>/indicators-1m.csv    indicators from the 1m timeframe
 *   <OUT_DIR>/indicators-5m.csv    indicators from the 5m timeframe (HTF)
 *   <OUT_DIR>/indicators-15m.csv   indicators from the 15m timeframe
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../../config.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../../types/market.js';
import { normalizeAlpacaBars } from '../../types/market.js';
import { computeDMI } from '../../indicators/dmi.js';
import { computeATR } from '../../indicators/atr.js';
import { computeEMA } from '../../indicators/ema.js';
import { computeMACD } from '../../indicators/macd.js';
import { computeStochastic } from '../../indicators/stochastic.js';
import { computeBollinger } from '../../indicators/bollinger.js';
import { computeVWAP } from '../../indicators/vwap.js';

const argv = process.argv.slice(2);
const TARGET_DATE = argv[0] || new Date().toISOString().slice(0, 10);
const TICKER = argv[1] || 'SPY';
const SAMPLE_EVERY = Math.max(1, parseInt(argv[2] || '1', 10));
const OUT_DIR = argv[3] || join('validate-out', TARGET_DATE);

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
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function tsToET(ts: string): { time: string; minutesFromMidnight: number } {
  const parts = ET_PARTS.formatToParts(new Date(ts));
  let hour = parts.find(p => p.type === 'hour')!.value;
  if (hour === '24') hour = '00';
  const minute = parts.find(p => p.type === 'minute')!.value;
  return {
    time: `${hour}:${minute}`,
    minutesFromMidnight: parseInt(hour, 10) * 60 + parseInt(minute, 10),
  };
}

function aggregate(bars1m: OHLCVBar[], n: number, upToMs?: number): OHLCVBar[] {
  if (n <= 1) {
    return upToMs === undefined
      ? bars1m
      : bars1m.filter(b => new Date(b.timestamp).getTime() <= upToMs);
  }
  const bucketMs = n * 60_000;
  // Exclude in-progress bucket (matches the system's behavior — only completed bars feed indicators).
  const currentBucket = upToMs !== undefined ? Math.floor(upToMs / bucketMs) * bucketMs : Infinity;
  const groups = new Map<number, OHLCVBar[]>();
  for (const b of bars1m) {
    const ts = new Date(b.timestamp).getTime();
    if (upToMs !== undefined && ts > upToMs) continue;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (bucket >= currentBucket) continue;
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
      vwap: (() => {
        const totalVol = bars.reduce((s, b) => s + b.volume, 0);
        if (totalVol === 0) return undefined;
        return bars.reduce((s, b) => s + (b.vwap ?? (b.high + b.low + b.close) / 3) * b.volume, 0) / totalVol;
      })(),
    }));
}

interface Row {
  timeET: string;
  close: number;
  ema9: number;
  ema21: number;
  vwap: number;
  vwapUpper: number;
  vwapLower: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  stochK: number;
  stochD: number;
  bbUpper: number;
  bbMid: number;
  bbLower: number;
  bbPercentB: number;
  atr: number;
  atrPct: number;
  plusDI: number;
  minusDI: number;
  adx: number;
}

function row(timeET: string, bars: OHLCVBar[], dmiPeriod: number): Row {
  const last = bars[bars.length - 1]!;
  const macd = computeMACD(bars, 12, 26, 9);
  const ema = computeEMA(bars, 9, 21);
  const vwap = computeVWAP(bars);
  const stoch = computeStochastic(bars, 14, 3, 1);
  const bb = computeBollinger(bars, 20, 2.0);
  const atr = computeATR(bars, 14, true);
  const dmi = computeDMI(bars, dmiPeriod, true);
  return {
    timeET,
    close: last.close,
    ema9: ema.emaFast, ema21: ema.emaSlow,
    vwap: vwap.vwap, vwapUpper: vwap.upperBand, vwapLower: vwap.lowerBand,
    macd: macd.macd, macdSignal: macd.signal, macdHist: macd.histogram,
    stochK: stoch.k, stochD: stoch.d,
    bbUpper: bb.upper, bbMid: bb.middle, bbLower: bb.lower, bbPercentB: bb.percentB,
    atr: atr.atr, atrPct: atr.atrPct,
    plusDI: dmi.plusDI, minusDI: dmi.minusDI, adx: dmi.adx,
  };
}

const HEADERS = [
  'timeET', 'close',
  'EMA9', 'EMA21',
  'VWAP', 'VWAP_upper', 'VWAP_lower',
  'MACD', 'MACD_signal', 'MACD_hist',
  'Stoch_K', 'Stoch_D',
  'BB_upper', 'BB_mid', 'BB_lower', 'BB_pctB',
  'ATR', 'ATR_pct',
  'plusDI', 'minusDI', 'ADX',
];

function rowToCsv(r: Row): string {
  const f = (n: number, p = 4) => Number.isFinite(n) ? n.toFixed(p) : '';
  return [
    r.timeET, f(r.close, 2),
    f(r.ema9), f(r.ema21),
    f(r.vwap), f(r.vwapUpper), f(r.vwapLower),
    f(r.macd, 6), f(r.macdSignal, 6), f(r.macdHist, 6),
    f(r.stochK, 2), f(r.stochD, 2),
    f(r.bbUpper), f(r.bbMid), f(r.bbLower), f(r.bbPercentB, 4),
    f(r.atr), f(r.atrPct, 4),
    f(r.plusDI, 2), f(r.minusDI, 2), f(r.adx, 2),
  ].join(',');
}

async function main(): Promise<void> {
  console.log(`Fetching ${TICKER} 1m bars for ${TARGET_DATE} (with 4-day warmup)…`);
  // 4-day warmup so 26-period EMA / 20-period BB / 14-period DMI all stable from minute 1 of RTH.
  const warmStart = new Date(TARGET_DATE);
  warmStart.setDate(warmStart.getDate() - 6); // 6 calendar days ≈ 4 trading days
  const startStr = warmStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const endStr = `${TARGET_DATE}T23:59:59Z`;
  const raw = await fetchBarsRange(TICKER, '1m', startStr, endStr);
  if (raw.length === 0) {
    console.error(`No bars returned for ${TICKER}`);
    process.exit(1);
  }
  console.log(`  → ${raw.length} bars (warmup + target day, all sessions)`);

  // Filter to RTH only (matches the live system's bar-cache behavior).
  const rthAll = raw.filter(b => {
    const et = tsToET(b.timestamp);
    return et.minutesFromMidnight >= 9 * 60 + 30 && et.minutesFromMidnight < 16 * 60;
  });

  const targetBars = rthAll.filter(b => b.timestamp.slice(0, 10) === TARGET_DATE);
  if (targetBars.length === 0) {
    console.error(`No RTH bars for ${TARGET_DATE} (holiday or future date?)`);
    process.exit(1);
  }
  console.log(`  → ${targetBars.length} target-date RTH bars; walking minute-by-minute…\n`);

  const rows1m: Row[] = [];
  const rows5m: Row[] = [];
  const rows15m: Row[] = [];

  let walked = 0;
  for (const bar of targetBars) {
    const et = tsToET(bar.timestamp);
    walked++;
    if ((walked - 1) % SAMPLE_EVERY !== 0 && walked !== targetBars.length) continue;

    const upToMs = new Date(bar.timestamp).getTime() + 60_000 - 1; // include this bar
    // 1m series uses all bars up to & including this one
    const series1m = rthAll.filter(b => new Date(b.timestamp).getTime() <= upToMs).slice(-500);
    const series5m = aggregate(rthAll, 5, upToMs).slice(-500);
    const series15m = aggregate(rthAll, 15, upToMs).slice(-500);

    if (series1m.length >= 30) rows1m.push(row(et.time, series1m, 8));   // LTF: dmiPeriod=8
    if (series5m.length >= 30) rows5m.push(row(et.time, series5m, 14));
    if (series15m.length >= 30) rows15m.push(row(et.time, series15m, 14));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const writeRows = (path: string, rows: Row[]) => {
    const csv = [HEADERS.join(','), ...rows.map(rowToCsv)].join('\n') + '\n';
    writeFileSync(path, csv, 'utf-8');
  };
  writeRows(join(OUT_DIR, 'indicators-1m.csv'), rows1m);
  writeRows(join(OUT_DIR, 'indicators-5m.csv'), rows5m);
  writeRows(join(OUT_DIR, 'indicators-15m.csv'), rows15m);

  console.log(`Wrote (sampled every ${SAMPLE_EVERY}m):`);
  console.log(`  ${join(OUT_DIR, 'indicators-1m.csv')}  (${rows1m.length} rows, dmiPeriod=8)`);
  console.log(`  ${join(OUT_DIR, 'indicators-5m.csv')}  (${rows5m.length} rows, dmiPeriod=14)`);
  console.log(`  ${join(OUT_DIR, 'indicators-15m.csv')} (${rows15m.length} rows, dmiPeriod=14)`);
  console.log(`\nSpot-check vs ToS: pick any timeET row, set ToS chart to ${TICKER} on the matching`);
  console.log(`timeframe + date + bar, and compare each column against the corresponding ToS study.`);
  console.log(`\nNote: the system applies skipSessionGaps=true on intraday DMI/ATR (zeroes TR on`);
  console.log(`session boundaries). ToS does the same when chart is set to RTH-only.`);
}

main().catch(err => { console.error(err); process.exit(1); });
