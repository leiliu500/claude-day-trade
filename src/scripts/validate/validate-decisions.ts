#!/usr/bin/env npx tsx
/**
 * validate-decisions.ts — Step 3 of correctness proof: decision determinism.
 *
 * Locks down the decision layer with a snapshot test. Given a fixture of bars
 * captured at a known minute, re-runs computeTimeframeIndicators + detectDirection
 * and diffs every numeric output against a golden JSON. Catches accidental drift
 * in DMI/ATR/EMA/MACD/etc. computations and direction logic.
 *
 * Two modes:
 *   --record  Pull bars from Alpaca for the given date+minute, run the pipeline,
 *             write fixture (bars) + golden (expected outputs) JSON to disk.
 *             Use once per fixture you want to lock down.
 *   default   Load fixture+golden from disk, recompute, assert byte-identical
 *             to the golden values within a tight float tolerance. Exits 0/1.
 *
 * Once recorded, the default mode is fully offline — proves the decision layer
 * is a deterministic function of input bars without touching Alpaca or live state.
 *
 * Usage:
 *   # Record a fixture (one-time, requires Alpaca creds):
 *   npx tsx src/scripts/validate/validate-decisions.ts --record 2026-04-23 SPY 10:30
 *
 *   # Validate every fixture in src/scripts/validate/fixtures/ (CI-friendly):
 *   npx tsx src/scripts/validate/validate-decisions.ts
 *
 *   # Validate a specific fixture:
 *   npx tsx src/scripts/validate/validate-decisions.ts SPY-2026-04-23-10-30.json
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
import { detectDirection, type PersistenceState } from '../../lib/direction-detector.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');
const FLOAT_TOL = 1e-6;

interface Fixture {
  ticker: string;
  date: string;
  timeET: string;
  ltfBars: OHLCVBar[];   // 1m bars up to & including the snapshot minute
  mtfBars: OHLCVBar[];   // 3m aggregated
  htfBars: OHLCVBar[];   // 5m aggregated
}

interface GoldenSnapshot {
  ltf: PerTfSnapshot;
  mtf: PerTfSnapshot;
  htf: PerTfSnapshot;
  direction: 'bullish' | 'bearish' | 'neutral';
  dmiTrends: [string, string, string];
}

interface PerTfSnapshot {
  close: number;
  ema9: number; ema21: number;
  vwap: number; vwapUpper: number; vwapLower: number;
  macd: number; macdSignal: number; macdHist: number;
  stochK: number; stochD: number;
  bbUpper: number; bbMid: number; bbLower: number; bbPctB: number;
  atr: number; atrPct: number;
  plusDI: number; minusDI: number; adx: number;
}

interface FixtureFile { fixture: Fixture; golden: GoldenSnapshot }

function snapshot(bars: OHLCVBar[], dmiPeriod: number): PerTfSnapshot {
  const last = bars[bars.length - 1]!;
  const ema = computeEMA(bars, 9, 21);
  const vwap = computeVWAP(bars);
  const macd = computeMACD(bars, 12, 26, 9);
  const stoch = computeStochastic(bars, 14, 3, 1);
  const bb = computeBollinger(bars, 20, 2.0);
  const atr = computeATR(bars, 14, true);
  const dmi = computeDMI(bars, dmiPeriod, true);
  return {
    close: last.close,
    ema9: ema.emaFast, ema21: ema.emaSlow,
    vwap: vwap.vwap, vwapUpper: vwap.upperBand, vwapLower: vwap.lowerBand,
    macd: macd.macd, macdSignal: macd.signal, macdHist: macd.histogram,
    stochK: stoch.k, stochD: stoch.d,
    bbUpper: bb.upper, bbMid: bb.middle, bbLower: bb.lower, bbPctB: bb.percentB,
    atr: atr.atr, atrPct: atr.atrPct,
    plusDI: dmi.plusDI, minusDI: dmi.minusDI, adx: dmi.adx,
  };
}

function runPipeline(f: Fixture): GoldenSnapshot {
  const persistence: PersistenceState = { dir: null, ts: 0 };
  const lastTs = new Date(f.ltfBars[f.ltfBars.length - 1]!.timestamp).getTime();
  const dr = detectDirection(f.ltfBars, f.mtfBars, f.htfBars, true, persistence, lastTs);
  return {
    ltf: snapshot(f.ltfBars, 8),
    mtf: snapshot(f.mtfBars, 10),
    htf: snapshot(f.htfBars, 14),
    direction: dr.direction,
    dmiTrends: [dr.dmiOnly[0].trend, dr.dmiOnly[1].trend, dr.dmiOnly[2].trend],
  };
}

function diff(actual: GoldenSnapshot, expected: GoldenSnapshot): string[] {
  const errs: string[] = [];
  if (actual.direction !== expected.direction) {
    errs.push(`direction: expected ${expected.direction}, got ${actual.direction}`);
  }
  for (let i = 0; i < 3; i++) {
    if (actual.dmiTrends[i] !== expected.dmiTrends[i]) {
      errs.push(`dmiTrends[${i}]: expected ${expected.dmiTrends[i]}, got ${actual.dmiTrends[i]}`);
    }
  }
  for (const tf of ['ltf', 'mtf', 'htf'] as const) {
    const a = actual[tf];
    const e = expected[tf];
    for (const k of Object.keys(e) as Array<keyof PerTfSnapshot>) {
      const av = a[k]; const ev = e[k];
      if (Math.abs(av - ev) > FLOAT_TOL) {
        errs.push(`${tf}.${k}: expected ${ev}, got ${av} (Δ ${(av - ev).toExponential(2)})`);
      }
    }
  }
  return errs;
}

// ── Record mode ─────────────────────────────────────────────────────────────

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string, start: string, end: string,
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const all: OHLCVBar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF['1m']);
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

function aggregate(bars1m: OHLCVBar[], n: number, upToMs: number): OHLCVBar[] {
  const bucketMs = n * 60_000;
  const currentBucket = Math.floor(upToMs / bucketMs) * bucketMs;
  const groups = new Map<number, OHLCVBar[]>();
  for (const b of bars1m) {
    const ts = new Date(b.timestamp).getTime();
    if (ts > upToMs) continue;
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
    }));
}

async function recordMode(date: string, ticker: string, timeET: string): Promise<void> {
  // timeET = "HH:MM" ET — convert to UTC ISO. ET is UTC-5 (EST) or UTC-4 (EDT).
  // Use Intl to get the correct offset for this date.
  const [hh, mm] = timeET.split(':').map(n => parseInt(n, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    throw new Error(`Invalid timeET "${timeET}", expected HH:MM`);
  }
  // Brute-force the offset: try UTC offsets 4 and 5; pick the one whose ET render matches.
  let snapshotMs = 0;
  for (const offset of [4, 5]) {
    const utcIso = `${date}T${String(hh + offset).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
    const candidate = new Date(utcIso);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(candidate);
    const renderHour = parts.find(p => p.type === 'hour')!.value;
    const renderMin = parts.find(p => p.type === 'minute')!.value;
    if (parseInt(renderHour, 10) === hh && parseInt(renderMin, 10) === mm) {
      snapshotMs = candidate.getTime();
      break;
    }
  }
  if (snapshotMs === 0) throw new Error(`Could not resolve ET offset for ${date} ${timeET}`);

  // 6 calendar days of warmup
  const warm = new Date(snapshotMs); warm.setDate(warm.getDate() - 6);
  const start = warm.toISOString().slice(0, 10) + 'T00:00:00Z';
  const end = `${date}T23:59:59Z`;

  console.log(`[record] Fetching ${ticker} 1m bars ${start} → ${end}`);
  const raw = await fetchBarsRange(ticker, start, end);

  // Filter to RTH only (matches live bar-cache behavior)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const rth = raw.filter(b => {
    const parts = fmt.formatToParts(new Date(b.timestamp));
    const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = h * 60 + m;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });

  const upToMs = snapshotMs + 60_000 - 1;
  const ltfBars = rth.filter(b => new Date(b.timestamp).getTime() <= upToMs).slice(-500);
  const mtfBars = aggregate(rth, 3, upToMs).slice(-500);
  const htfBars = aggregate(rth, 5, upToMs).slice(-500);

  if (ltfBars.length < 50 || mtfBars.length < 30 || htfBars.length < 30) {
    throw new Error(`Insufficient bars: ltf=${ltfBars.length} mtf=${mtfBars.length} htf=${htfBars.length}`);
  }

  const fixture: Fixture = { ticker, date, timeET, ltfBars, mtfBars, htfBars };
  const golden = runPipeline(fixture);

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const slug = `${ticker}-${date}-${timeET.replace(':', '-')}.json`;
  const path = join(FIXTURE_DIR, slug);
  writeFileSync(path, JSON.stringify({ fixture, golden }, null, 2), 'utf-8');
  console.log(`[record] Wrote ${path}`);
  console.log(`[record]   ltf: ${ltfBars.length} bars, mtf: ${mtfBars.length}, htf: ${htfBars.length}`);
  console.log(`[record]   direction: ${golden.direction}, dmi: ${golden.dmiTrends.join(' / ')}`);
}

// ── Validate mode ───────────────────────────────────────────────────────────

function validateOne(path: string): { ok: boolean; errs: string[] } {
  const ff = JSON.parse(readFileSync(path, 'utf-8')) as FixtureFile;
  const actual = runPipeline(ff.fixture);
  return { ok: diff(actual, ff.golden).length === 0, errs: diff(actual, ff.golden) };
}

function validateAll(only?: string): void {
  if (!existsSync(FIXTURE_DIR)) {
    console.error(`No fixtures dir at ${FIXTURE_DIR}. Record one first with --record.`);
    process.exit(1);
  }
  const files = only
    ? [only.includes('/') ? only : join(FIXTURE_DIR, only)]
    : readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json')).map(f => join(FIXTURE_DIR, f));
  if (files.length === 0) {
    console.error(`No fixtures in ${FIXTURE_DIR}. Record one first with --record.`);
    process.exit(1);
  }
  let pass = 0, fail = 0;
  for (const f of files) {
    const slug = f.split('/').pop()!;
    const { ok, errs } = validateOne(f);
    if (ok) {
      console.log(`  ✓ ${slug}`);
      pass++;
    } else {
      console.log(`  ✗ ${slug}`);
      for (const e of errs) console.log(`      ${e}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed (tolerance ${FLOAT_TOL})`);
  if (fail > 0) process.exit(1);
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--record') {
    const date = args[1]; const ticker = args[2] || 'SPY'; const timeET = args[3] || '10:30';
    if (!date) {
      console.error('Usage: --record <YYYY-MM-DD> [TICKER] [HH:MM_ET]');
      process.exit(1);
    }
    await recordMode(date, ticker, timeET);
  } else {
    validateAll(args[0]);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
