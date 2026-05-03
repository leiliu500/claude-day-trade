#!/usr/bin/env npx tsx
/**
 * validate-order-sim.ts — Layer 4 of the correctness proof: order-sim determinism.
 *
 * Locks down the order-agent simulation (entry → exit) with a snapshot test.
 * Pure deterministic function of (entryPrice, direction, atr, futureBars, cfg);
 * once a fixture is recorded, replay runs entirely offline.
 *
 * Tests both shared (`simulateOrderAgent`) and SPY-specific
 * (`simulateOrderAgentSpy`) variants — pick which one to record per fixture.
 *
 * Two modes:
 *   --record  Pull bars + ATR from Alpaca for the given (date, time, direction);
 *             run the chosen sim; write fixture {bars, params} + golden {SimResult}.
 *             One-time per fixture, requires Alpaca creds.
 *   default   Load every fixture in fixtures/order-sim/, recompute, assert
 *             byte-equal to golden at 1e-6. Exits 0/1.
 *
 * Usage:
 *   # Record a fixture (variant: 'base' | 'spy')
 *   npx tsx src/scripts/validate/validate-order-sim.ts \
 *     --record 2026-05-01 SPY 10:30 bullish spy
 *
 *   # Validate every fixture (offline, run anytime):
 *   npx tsx src/scripts/validate/validate-order-sim.ts
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../config.js';
import type { OHLCVBar, AlpacaBarsResponse, Timeframe } from '../../types/market.js';
import { normalizeAlpacaBars } from '../../types/market.js';
import { computeATR } from '../../indicators/atr.js';
import {
  simulateOrderAgent,
  type OHLCVBar as SimOHLCVBar,
  type SignalDirection,
  type SimResult,
  type SimConfig,
} from '../../lib/order-agent-sim.js';
import { simulateOrderAgentSpy } from '../../lib/order-agent-sim-spy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'order-sim');
const FLOAT_TOL = 1e-6;

type Variant = 'base' | 'spy';

interface OrderSimFixture {
  ticker: string;
  date: string;
  timeET: string;
  direction: SignalDirection;
  variant: Variant;
  entryPrice: number;
  atr: number;
  recentBars: SimOHLCVBar[];   // ~10 bars before entry for volatility estimate
  futureBars: SimOHLCVBar[];   // ~120 bars from entry forward
  cfg: Pick<SimConfig, 'stopMult' | 'tpMult' | 'delta'>;
}

interface FixtureFile { fixture: OrderSimFixture; golden: SimResult }

function chooseSim(variant: Variant) {
  return variant === 'spy' ? simulateOrderAgentSpy : simulateOrderAgent;
}

function runSim(f: OrderSimFixture): SimResult {
  return chooseSim(f.variant)(
    f.entryPrice, f.direction, f.atr, f.futureBars,
    { recentBars: f.recentBars, ...f.cfg },
  );
}

function diff(actual: SimResult, expected: SimResult): string[] {
  const errs: string[] = [];
  if (actual.exitReason !== expected.exitReason) {
    errs.push(`exitReason: expected ${expected.exitReason}, got ${actual.exitReason}`);
  }
  if (actual.holdMinutes !== expected.holdMinutes) {
    errs.push(`holdMinutes: expected ${expected.holdMinutes}, got ${actual.holdMinutes}`);
  }
  for (const k of ['exitPrice', 'pnlPct', 'peakPnlPct', 'maxDrawdownPct'] as const) {
    if (Math.abs(actual[k] - expected[k]) > FLOAT_TOL) {
      errs.push(`${k}: expected ${expected[k]}, got ${actual[k]} (Δ ${(actual[k] - expected[k]).toExponential(2)})`);
    }
  }
  return errs;
}

// ── Record mode ─────────────────────────────────────────────────────────────

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBars1m(ticker: string, start: string, end: string): Promise<OHLCVBar[]> {
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

function resolveEtToUtcMs(date: string, timeET: string): number {
  const [hh, mm] = timeET.split(':').map(n => parseInt(n, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    throw new Error(`Invalid timeET "${timeET}", expected HH:MM`);
  }
  for (const offset of [4, 5]) {
    const utcIso = `${date}T${String(hh + offset).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
    const candidate = new Date(utcIso);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(candidate);
    const renderHour = parts.find(p => p.type === 'hour')!.value;
    const renderMin = parts.find(p => p.type === 'minute')!.value;
    if (parseInt(renderHour, 10) === hh && parseInt(renderMin, 10) === mm) {
      return candidate.getTime();
    }
  }
  throw new Error(`Could not resolve ET offset for ${date} ${timeET}`);
}

function toSimBar(b: OHLCVBar): SimOHLCVBar {
  return {
    timestamp: b.timestamp,
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  };
}

async function recordMode(
  date: string, ticker: string, timeET: string, direction: SignalDirection, variant: Variant,
): Promise<void> {
  if (direction === 'neutral') throw new Error('direction must be bullish or bearish');
  const entryMs = resolveEtToUtcMs(date, timeET);

  // 4-day warmup so ATR(14) on 1m has enough history
  const warm = new Date(entryMs); warm.setDate(warm.getDate() - 6);
  const start = warm.toISOString().slice(0, 10) + 'T00:00:00Z';
  const end = `${date}T23:59:59Z`;

  console.log(`[record] Fetching ${ticker} 1m bars ${start} → ${end}`);
  const raw = await fetchBars1m(ticker, start, end);

  // Filter to RTH only (matches live)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const isRth = (b: OHLCVBar) => {
    const parts = fmt.formatToParts(new Date(b.timestamp));
    const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = h * 60 + m;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  };
  const rth = raw.filter(isRth);

  // Find the entry bar (first bar with timestamp >= entryMs)
  const entryIdx = rth.findIndex(b => new Date(b.timestamp).getTime() >= entryMs);
  if (entryIdx < 0) throw new Error(`No bar at or after ${date} ${timeET} ET`);
  const entryBar = rth[entryIdx]!;
  const entryPrice = entryBar.close;

  // ATR computed on the bars-up-to-entry series (matches what backtest sees)
  const seriesUpToEntry = rth.slice(0, entryIdx + 1).slice(-500);
  const atrResult = computeATR(seriesUpToEntry, 14, true);
  const atr = atrResult.atr;
  if (atr === 0) throw new Error('ATR=0 — insufficient warmup');

  // recentBars: 10 bars before entry (for option premium volatility estimate)
  const recentBars = seriesUpToEntry.slice(-11, -1).map(toSimBar);

  // futureBars: from entry+1 forward, capped at end-of-day to keep fixture small.
  const targetDayBars = rth.filter(b => b.timestamp.startsWith(date));
  const entryInDay = targetDayBars.findIndex(b => new Date(b.timestamp).getTime() >= entryMs);
  const futureBars = targetDayBars.slice(entryInDay + 1).map(toSimBar);
  if (futureBars.length < 20) {
    throw new Error(`Only ${futureBars.length} future bars — entry too late in session`);
  }

  const fixture: OrderSimFixture = {
    ticker, date, timeET, direction, variant,
    entryPrice, atr,
    recentBars, futureBars,
    cfg: {},
  };
  const golden = runSim(fixture);

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const slug = `${variant}-${ticker}-${date}-${timeET.replace(':', '-')}-${direction}.json`;
  const path = join(FIXTURE_DIR, slug);
  writeFileSync(path, JSON.stringify({ fixture, golden }, null, 2), 'utf-8');
  console.log(`[record] Wrote ${path}`);
  console.log(`[record]   entry=${entryPrice.toFixed(2)} atr=${atr.toFixed(4)} bars=${futureBars.length} variant=${variant}`);
  console.log(`[record]   exit=${golden.exitReason} @ ${golden.exitPrice.toFixed(2)} after ${golden.holdMinutes}m, pnl=${golden.pnlPct.toFixed(2)}% (peak ${golden.peakPnlPct.toFixed(2)}%)`);
}

// ── Validate mode ───────────────────────────────────────────────────────────

function validateOne(path: string): { ok: boolean; errs: string[]; golden: SimResult } {
  const ff = JSON.parse(readFileSync(path, 'utf-8')) as FixtureFile;
  const actual = runSim(ff.fixture);
  const errs = diff(actual, ff.golden);
  return { ok: errs.length === 0, errs, golden: ff.golden };
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
    const { ok, errs, golden } = validateOne(f);
    if (ok) {
      console.log(`  ✓ ${slug.padEnd(50)} ${golden.exitReason} ${golden.holdMinutes}m ${golden.pnlPct.toFixed(2)}%`);
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
    const [, date, ticker, timeET, direction, variant] = args;
    if (!date || !ticker || !timeET || !direction) {
      console.error('Usage: --record <YYYY-MM-DD> <TICKER> <HH:MM_ET> <bullish|bearish> [base|spy]');
      process.exit(1);
    }
    if (direction !== 'bullish' && direction !== 'bearish') {
      console.error(`direction must be bullish or bearish, got "${direction}"`);
      process.exit(1);
    }
    const v: Variant = (variant === 'spy' ? 'spy' : variant === 'base' ? 'base' : 'spy');
    await recordMode(date, ticker, timeET, direction as SignalDirection, v);
  } else {
    validateAll(args[0]);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
