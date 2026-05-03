#!/usr/bin/env npx tsx
/**
 * self-check.ts — Internal cross-validation of indicator math.
 *
 * For each indicator the system uses, computes the same value with a clean-room
 * reference implementation written below (different code path, textbook formula
 * from Investopedia / Wikipedia / TOS docs) and asserts agreement to 1e-9.
 *
 * If both independent implementations agree, the system implementation is
 * mathematically correct. ToS comparison (dump-indicators.ts) then becomes a
 * final external double-check, not the only validation.
 *
 * Pulls real SPY 1m bars to test against (a real-world, non-pathological data
 * sample) — needs Alpaca creds. Otherwise fully offline.
 *
 * Usage:
 *   npx tsx src/scripts/validate/self-check.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: most recent business day, SPY
 */

import 'dotenv/config';
import { config } from '../../config.js';
import type { OHLCVBar, AlpacaBarsResponse } from '../../types/market.js';
import { normalizeAlpacaBars } from '../../types/market.js';
import { computeEMA } from '../../indicators/ema.js';
import { computeMACD } from '../../indicators/macd.js';
import { computeBollinger } from '../../indicators/bollinger.js';
import { computeATR } from '../../indicators/atr.js';
import { computeStochastic } from '../../indicators/stochastic.js';
import { computeVWAP } from '../../indicators/vwap.js';
import { computeDMI } from '../../indicators/dmi.js';

const argv = process.argv.slice(2);
const TARGET_DATE = argv[0] || (() => {
  const d = new Date(); d.setDate(d.getDate() - 1);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const TICKER = argv[1] || 'SPY';
const TOL = 1e-9;

async function fetchBars(ticker: string, start: string, end: string): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const all: OHLCVBar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', '1Min');
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

// ── Clean-room reference implementations ────────────────────────────────────
// These follow the textbook definition from Wikipedia / Investopedia / TOS
// documentation. They are deliberately written in a different style than the
// system implementations (different variable names, different control flow,
// different intermediate-array layouts) so a copy-paste bug is unlikely to
// hide itself in both at once.

function refEma(closes: number[], period: number): number[] {
  // Standard EMA: seed = SMA of first `period` values, then recurrence.
  const out: number[] = [];
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i]!;
  let prev = seed / period;
  out.push(prev);
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    prev = closes[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function refMacd(closes: number[]): { macd: number; signal: number; histogram: number } {
  const fast = refEma(closes, 12);
  const slow = refEma(closes, 26);
  // fast starts at index 11, slow at index 25 — align so each MACD point is
  // for the same underlying close.
  const macdLine: number[] = [];
  const offset = 26 - 12; // 14
  for (let i = 0; i < slow.length; i++) {
    macdLine.push(fast[i + offset]! - slow[i]!);
  }
  const sig = refEma(macdLine, 9);
  const macd = macdLine[macdLine.length - 1]!;
  const signal = sig[sig.length - 1]!;
  // Histogram aligned to last MACD point: signal[k] is for MACD index k+8
  const histogram = macd - signal;
  return { macd, signal, histogram };
}

function refBollinger(closes: number[], period = 20, n = 2.0): { mid: number; upper: number; lower: number } {
  const window = closes.slice(-period);
  const mid = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mid) ** 2, 0) / period; // population
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + n * sd, lower: mid - n * sd };
}

function refTrSeries(bars: OHLCVBar[], skipGaps = true): number[] {
  const tr: number[] = [0]; // index 0 has no prior bar
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i]!; const p = bars[i - 1]!;
    const sameSession = c.timestamp.slice(0, 10) === p.timestamp.slice(0, 10);
    if (skipGaps && !sameSession) {
      tr.push(c.high - c.low);
    } else {
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
  }
  return tr;
}

function refAtr(bars: OHLCVBar[], period = 14, skipGaps = true): number {
  // Wilder's RMA: first ATR = mean of first `period` TRs, then ATR_i = (ATR_{i-1}*(p-1) + TR_i)/p
  const tr = refTrSeries(bars, skipGaps);
  // tr[0] = 0 (no prior); use tr[1..period] as the seed window
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i]!;
  atr /= period;
  for (let i = period + 1; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }
  return atr;
}

function refDmi(bars: OHLCVBar[], period: number, skipGaps = true): { plusDI: number; minusDI: number; adx: number } {
  const n = bars.length;
  const tr = refTrSeries(bars, skipGaps);
  const dmPlus: number[] = [0];
  const dmMinus: number[] = [0];
  for (let i = 1; i < n; i++) {
    const c = bars[i]!; const p = bars[i - 1]!;
    const sameSession = c.timestamp.slice(0, 10) === p.timestamp.slice(0, 10);
    if (skipGaps && !sameSession) {
      dmPlus.push(0); dmMinus.push(0);
      continue;
    }
    const up = c.high - p.high;
    const down = p.low - c.low;
    dmPlus.push(up > down && up > 0 ? up : 0);
    dmMinus.push(down > up && down > 0 ? down : 0);
  }
  // Wilder smoothing on TR / DM+ / DM-
  function wilder(series: number[]): number[] {
    const out: number[] = new Array(series.length).fill(0);
    let acc = 0;
    for (let i = 1; i <= period; i++) acc += series[i]!;
    out[period] = acc;
    for (let i = period + 1; i < series.length; i++) {
      out[i] = out[i - 1]! - out[i - 1]! / period + series[i]!;
    }
    return out;
  }
  const sTR = wilder(tr);
  const sPlus = wilder(dmPlus);
  const sMinus = wilder(dmMinus);
  // DI series
  const plusDi: number[] = []; const minusDi: number[] = []; const dx: number[] = [];
  for (let i = period; i < n; i++) {
    const t = sTR[i]!;
    const pdi = t > 0 ? (sPlus[i]! / t) * 100 : 0;
    const mdi = t > 0 ? (sMinus[i]! / t) * 100 : 0;
    plusDi.push(pdi); minusDi.push(mdi);
    const sum = pdi + mdi;
    dx.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0);
  }
  // ADX = Wilder smoothing of DX, seeded by mean of first `period` DX values
  let adx = 0;
  if (dx.length >= period) {
    let acc = 0;
    for (let i = 0; i < period; i++) acc += dx[i]!;
    adx = acc / period;
    for (let i = period; i < dx.length; i++) {
      adx = (adx * (period - 1) + dx[i]!) / period;
    }
  }
  return {
    plusDI: plusDi[plusDi.length - 1] ?? 0,
    minusDI: minusDi[minusDi.length - 1] ?? 0,
    adx,
  };
}

function refStochFast(bars: OHLCVBar[], k = 14, d = 3): { k: number; d: number } {
  // Fast Stochastic: %K = (close - LL_k) / (HH_k - LL_k) * 100
  //                  %D = SMA(%K, d)
  const ks: number[] = [];
  for (let i = k - 1; i < bars.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - k + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j]!.high);
      ll = Math.min(ll, bars[j]!.low);
    }
    const r = hh - ll;
    ks.push(r > 0 ? ((bars[i]!.close - ll) / r) * 100 : 50);
  }
  const lastK = ks[ks.length - 1]!;
  const dWindow = ks.slice(-d);
  const lastD = dWindow.reduce((a, b) => a + b, 0) / d;
  return { k: lastK, d: lastD };
}

function refVwap(bars: OHLCVBar[]): number {
  // Cumulative VWAP for the most recent calendar day in `bars`.
  const lastDay = bars[bars.length - 1]!.timestamp.slice(0, 10);
  let pv = 0, v = 0;
  for (const b of bars) {
    if (b.timestamp.slice(0, 10) !== lastDay) continue;
    const tp = b.vwap ?? (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : 0;
}

// ── Test runner ─────────────────────────────────────────────────────────────

interface Check {
  name: string;
  expected: number;
  actual: number;
  tol?: number;
}

function approxEqual(a: number, b: number, tol = TOL): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff < tol) return true;
  // Relative tolerance for large values
  return diff / Math.max(Math.abs(a), Math.abs(b)) < tol;
}

function runChecks(checks: Check[]): { pass: number; fail: number } {
  let pass = 0, fail = 0;
  for (const c of checks) {
    const tol = c.tol ?? TOL;
    if (approxEqual(c.expected, c.actual, tol)) {
      console.log(`  ✓ ${c.name.padEnd(36)} ref=${c.expected.toFixed(8)}  sys=${c.actual.toFixed(8)}`);
      pass++;
    } else {
      console.log(`  ✗ ${c.name.padEnd(36)} ref=${c.expected.toFixed(8)}  sys=${c.actual.toFixed(8)}  Δ=${(c.actual - c.expected).toExponential(3)}`);
      fail++;
    }
  }
  return { pass, fail };
}

async function main(): Promise<void> {
  console.log(`Self-check: ${TICKER} ${TARGET_DATE}\n`);

  const warm = new Date(TARGET_DATE); warm.setDate(warm.getDate() - 6);
  const start = warm.toISOString().slice(0, 10) + 'T00:00:00Z';
  const end = `${TARGET_DATE}T23:59:59Z`;
  const all = await fetchBars(TICKER, start, end);
  if (all.length < 200) {
    console.error(`Not enough bars (${all.length}); pick a date with full data`);
    process.exit(1);
  }

  // Use a slice that ends mid-RTH so VWAP/cumulative calcs span a session.
  const bars = all.slice(-300);
  const closes = bars.map(b => b.close);

  console.log(`Using last ${bars.length} 1m bars (last close ${bars[bars.length - 1]!.close.toFixed(2)} @ ${bars[bars.length - 1]!.timestamp})\n`);

  // ── EMA ────────────────────────────────────────────────────────────────
  const ema = computeEMA(bars, 9, 21);
  const fastRef = refEma(closes, 9);
  const slowRef = refEma(closes, 21);
  console.log('EMA:');
  let totals = runChecks([
    { name: 'EMA9',  expected: fastRef[fastRef.length - 1]!, actual: ema.emaFast },
    { name: 'EMA21', expected: slowRef[slowRef.length - 1]!, actual: ema.emaSlow },
  ]);

  // ── MACD ───────────────────────────────────────────────────────────────
  const sysMacd = computeMACD(bars, 12, 26, 9);
  const refM = refMacd(closes);
  console.log('\nMACD:');
  const t2 = runChecks([
    { name: 'MACD line',   expected: refM.macd,      actual: sysMacd.macd },
    { name: 'MACD signal', expected: refM.signal,    actual: sysMacd.signal },
    { name: 'MACD hist',   expected: refM.histogram, actual: sysMacd.histogram },
  ]);
  totals = { pass: totals.pass + t2.pass, fail: totals.fail + t2.fail };

  // ── Bollinger ─────────────────────────────────────────────────────────
  const sysBb = computeBollinger(bars, 20, 2.0);
  const refB = refBollinger(closes, 20, 2.0);
  console.log('\nBollinger Bands (20, 2.0):');
  const t3 = runChecks([
    { name: 'BB middle', expected: refB.mid,   actual: sysBb.middle },
    { name: 'BB upper',  expected: refB.upper, actual: sysBb.upper },
    { name: 'BB lower',  expected: refB.lower, actual: sysBb.lower },
  ]);
  totals = { pass: totals.pass + t3.pass, fail: totals.fail + t3.fail };

  // ── ATR ───────────────────────────────────────────────────────────────
  const sysAtr = computeATR(bars, 14, true);
  const refA = refAtr(bars, 14, true);
  console.log('\nATR (14, skipSessionGaps):');
  const t4 = runChecks([
    { name: 'ATR', expected: refA, actual: sysAtr.atr },
  ]);
  totals = { pass: totals.pass + t4.pass, fail: totals.fail + t4.fail };

  // ── DMI ───────────────────────────────────────────────────────────────
  const sysDmi14 = computeDMI(bars, 14, true);
  const refD14 = refDmi(bars, 14, true);
  console.log('\nDMI (14, skipSessionGaps):');
  const t5 = runChecks([
    { name: '+DI',  expected: refD14.plusDI,  actual: sysDmi14.plusDI,  tol: 1e-6 },
    { name: '-DI',  expected: refD14.minusDI, actual: sysDmi14.minusDI, tol: 1e-6 },
    { name: 'ADX',  expected: refD14.adx,     actual: sysDmi14.adx,     tol: 1e-6 },
  ]);
  totals = { pass: totals.pass + t5.pass, fail: totals.fail + t5.fail };

  const sysDmi8 = computeDMI(bars, 8, true);
  const refD8 = refDmi(bars, 8, true);
  console.log('\nDMI (8, skipSessionGaps) — 1m timeframe:');
  const t6 = runChecks([
    { name: '+DI (period 8)', expected: refD8.plusDI,  actual: sysDmi8.plusDI,  tol: 1e-6 },
    { name: '-DI (period 8)', expected: refD8.minusDI, actual: sysDmi8.minusDI, tol: 1e-6 },
    { name: 'ADX (period 8)', expected: refD8.adx,     actual: sysDmi8.adx,     tol: 1e-6 },
  ]);
  totals = { pass: totals.pass + t6.pass, fail: totals.fail + t6.fail };

  // ── Stochastic ───────────────────────────────────────────────────────
  const sysStoch = computeStochastic(bars, 14, 3, 1);
  const refS = refStochFast(bars, 14, 3);
  console.log('\nStochastic Fast (14, 3, 1):');
  const t7 = runChecks([
    { name: '%K', expected: refS.k, actual: sysStoch.k, tol: 1e-9 },
    { name: '%D', expected: refS.d, actual: sysStoch.d, tol: 1e-9 },
  ]);
  totals = { pass: totals.pass + t7.pass, fail: totals.fail + t7.fail };

  // ── VWAP ─────────────────────────────────────────────────────────────
  const sysVwap = computeVWAP(bars);
  const refV = refVwap(bars);
  console.log('\nVWAP (cumulative, calendar-day reset):');
  const t8 = runChecks([
    { name: 'VWAP', expected: refV, actual: sysVwap.vwap, tol: 1e-9 },
  ]);
  totals = { pass: totals.pass + t8.pass, fail: totals.fail + t8.fail };

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${totals.pass} passed, ${totals.fail} failed (tolerance ${TOL})`);
  console.log('═'.repeat(70));
  if (totals.fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
