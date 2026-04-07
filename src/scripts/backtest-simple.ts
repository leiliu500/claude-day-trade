/**
 * backtest-simple.ts — Event-driven entry backtest.
 *
 * Replaces the 30+ factor confidence model with 3 simple discrete triggers:
 *   1. ORB Breakout — price breaks 30-min opening range + volume confirms
 *   2. VWAP Pullback — trending day + price touches VWAP + reversal candle
 *   3. Momentum Break — new HOD/LOD + volume surge
 *
 * Each trigger is pass/fail. No partial credit, no scores adding up.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-simple.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: 2026-03-18, SPY
 */

import 'dotenv/config';
import { config } from '../config.js';
import { computeDMI } from '../indicators/dmi.js';
import { computeATR } from '../indicators/atr.js';
import { computeOBV } from '../indicators/obv.js';
import { computeVWAP } from '../indicators/vwap.js';
import { detectCandlePattern } from '../indicators/candle-patterns.js';
import { computePriceVelocity } from '../indicators/price-velocity.js';
import { computeVolumeSurge } from '../indicators/volume-surge.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { simulateOrderAgent, type SimResult } from '../lib/order-agent-sim.js';

// ── Config ────────────────────────────────────────────────────────────────────

const TARGET_DATE = process.argv.filter(a => !a.startsWith('--'))[2] || '2026-03-18';
const TICKER = process.argv.filter(a => !a.startsWith('--'))[3] || 'SPY';

const MARKET_OPEN_UTC = '13:30';
const MARKET_CLOSE_UTC = '20:00';

// ── Alpaca REST ──────────────────────────────────────────────────────────────

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
    if (data.next_page_token) { pageToken = data.next_page_token; } else { break; }
  }
  return allBars;
}

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
      vwap: (() => {
        if (!bars.some(b => b.vwap !== undefined)) return undefined;
        const totalVol = bars.reduce((s, b) => s + b.volume, 0);
        if (totalVol === 0) return undefined;
        return bars.reduce((s, b) => s + (b.vwap ?? 0) * b.volume, 0) / totalVol;
      })(),
    }));
}

function isRegularSession(timestamp: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp));
  const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function utcToET(utcTime: string): string {
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4);
  return d.toISOString().slice(11, 16);
}

// ── Regime detection (simple) ────────────────────────────────────────────────

type Regime = 'trending' | 'ranging' | 'skip';

function detectRegime(htfBars: OHLCVBar[], todayBarsToNow: OHLCVBar[]): Regime {
  if (htfBars.length < 14) return 'skip';
  const dmi = computeDMI(htfBars, 14, true);

  // Trending: ADX >= 22 — clear directional movement
  if (dmi.adx >= 22) return 'trending';

  // Ranging: ADX < 22 — no clear trend
  // But skip if ADX is collapsing (< 12) — no volatility at all
  if (dmi.adx < 12) return 'skip';

  return 'ranging';
}

// ── Event triggers (v2 — confirmation-based) ────────────────────────────────
//
// Key insight from v1: entering on the FIRST occurrence of an event (break,
// bounce, new HOD/LOD) catches mostly noise. Real edge comes from entering
// on CONFIRMATION — the market proves the move is real before we join.
//
// Each trigger now tracks state across bars and requires multi-bar confirmation.

type SignalDirection = 'bullish' | 'bearish';
type TriggerType = 'ORB_RETEST' | 'VWAP_RECLAIM' | 'MOMENTUM_CONTINUATION';

interface TriggerResult {
  fired: boolean;
  type: TriggerType;
  direction: SignalDirection;
  reason: string;
}

// ── Stateful trigger tracking ────────────────────────────────────────────────

interface ORBState {
  // Track if ORB was broken and in which direction
  brokenBullish: boolean;
  brokenBearish: boolean;
  breakTime: number;           // timestamp of first break
  // After break, track if price retested the ORB level
  retestStarted: boolean;
  retestBarsNearLevel: number; // consecutive bars near the broken level
  breakoutBarVolume: number;   // volume on the breakout bar
}

interface VWAPState {
  // Track bars since VWAP was touched
  touchedVWAP: boolean;
  touchTime: number;
  touchDirection: SignalDirection | null; // which side it came from
  barsAfterTouch: number;
  consecutiveTrendBars: number; // bars closing in trend direction after touch
}

interface MomentumState {
  // Track new HOD/LOD events and follow-through
  newExtreme: boolean;
  extremeTime: number;
  extremeDirection: SignalDirection | null;
  extremePrice: number;
  barsHoldingBeyond: number; // consecutive bars closing beyond the extreme
  breakVolume: number;
}

function createORBState(): ORBState {
  return { brokenBullish: false, brokenBearish: false, breakTime: 0,
    retestStarted: false, retestBarsNearLevel: 0, breakoutBarVolume: 0 };
}

function createVWAPState(): VWAPState {
  return { touchedVWAP: false, touchTime: 0, touchDirection: null,
    barsAfterTouch: 0, consecutiveTrendBars: 0 };
}

function createMomentumState(): MomentumState {
  return { newExtreme: false, extremeTime: 0, extremeDirection: null,
    extremePrice: 0, barsHoldingBeyond: 0, breakVolume: 0 };
}

/**
 * Trigger 1: ORB Break + Retest
 *
 * Phase 1 (Detection): Price breaks ORB high/low with volume > 1.2x avg
 * Phase 2 (Pullback):  Price pulls back toward ORB level (within 0.15% of broken level)
 * Phase 3 (Confirm):   Price holds at level for 2+ bars, then resumes break direction
 *
 * This catches the 2nd leg of the move, avoiding false breakouts.
 */
function updateORBState(
  state: ORBState, currentBar: OHLCVBar, currentPrice: number, currentTs: number,
  orbHigh: number, orbLow: number, orbFormed: boolean, avgVolume: number,
): TriggerResult {
  const result: TriggerResult = { fired: false, type: 'ORB_RETEST', direction: 'bullish', reason: '' };
  if (!orbFormed) return result;

  const volumeRatio = avgVolume > 0 ? currentBar.volume / avgVolume : 0;

  // Phase 1: Detect initial break (if not already broken)
  if (!state.brokenBullish && !state.brokenBearish) {
    if (currentPrice > orbHigh && volumeRatio >= 1.2) {
      state.brokenBullish = true;
      state.breakTime = currentTs;
      state.breakoutBarVolume = currentBar.volume;
    } else if (currentPrice < orbLow && volumeRatio >= 1.2) {
      state.brokenBearish = true;
      state.breakTime = currentTs;
      state.breakoutBarVolume = currentBar.volume;
    }
    return result;
  }

  // Phase 2: Wait for pullback to ORB level
  const brokenLevel = state.brokenBullish ? orbHigh : orbLow;
  const distFromLevel = Math.abs(currentPrice - brokenLevel) / brokenLevel * 100;

  if (!state.retestStarted) {
    // Need price to come back near the level (within 0.15%)
    if (distFromLevel <= 0.15) {
      state.retestStarted = true;
      state.retestBarsNearLevel = 1;
    }
    // If price ran too far without retesting (> 0.5%), the setup is dead
    if (state.brokenBullish && currentPrice > orbHigh * 1.005) {
      // Reset — no retest coming
      state.brokenBullish = false; state.retestStarted = false; state.retestBarsNearLevel = 0;
    }
    if (state.brokenBearish && currentPrice < orbLow * 0.995) {
      state.brokenBearish = false; state.retestStarted = false; state.retestBarsNearLevel = 0;
    }
    return result;
  }

  // Phase 3: Confirm hold at level + resume
  if (distFromLevel <= 0.15) {
    state.retestBarsNearLevel++;
  }

  // Need 2+ bars near level, then price moves back in breakout direction
  if (state.retestBarsNearLevel >= 2) {
    if (state.brokenBullish && currentBar.close > brokenLevel && currentBar.close > currentBar.open) {
      result.fired = true;
      result.direction = 'bullish';
      result.reason = `ORB break+retest: broke $${orbHigh.toFixed(2)}, retested ${state.retestBarsNearLevel} bars, resumed bullish`;
      // Reset for next potential setup
      state.brokenBullish = false; state.retestStarted = false; state.retestBarsNearLevel = 0;
      return result;
    }
    if (state.brokenBearish && currentBar.close < brokenLevel && currentBar.close < currentBar.open) {
      result.fired = true;
      result.direction = 'bearish';
      result.reason = `ORB break+retest: broke $${orbLow.toFixed(2)}, retested ${state.retestBarsNearLevel} bars, resumed bearish`;
      state.brokenBearish = false; state.retestStarted = false; state.retestBarsNearLevel = 0;
      return result;
    }
  }

  // Timeout: if retest takes > 20 bars, reset
  const barsSinceBreak = Math.round((currentTs - state.breakTime) / 60_000);
  if (barsSinceBreak > 20) {
    state.brokenBullish = false; state.brokenBearish = false;
    state.retestStarted = false; state.retestBarsNearLevel = 0;
  }

  return result;
}

/**
 * Trigger 2: VWAP Reclaim
 *
 * Phase 1 (Detection): Price crosses/touches VWAP (was on one side, moves to other)
 * Phase 2 (Confirm):   3 consecutive bars closing in trend direction after touch
 *
 * Unlike v1's "near VWAP" check, this requires directional follow-through.
 * The trend direction is determined by which side price approaches VWAP from.
 */
function updateVWAPState(
  state: VWAPState, currentBar: OHLCVBar, currentPrice: number, currentTs: number,
  vwapPrice: number, prevBar: OHLCVBar | undefined,
  dmiTrend: 'bullish' | 'bearish' | 'neutral', regime: Regime,
): TriggerResult {
  const result: TriggerResult = { fired: false, type: 'VWAP_RECLAIM', direction: 'bullish', reason: '' };

  // Only in trending regime
  if (regime !== 'trending') { state.touchedVWAP = false; return result; }
  if (dmiTrend === 'neutral') { state.touchedVWAP = false; return result; }

  const vwapDist = (currentPrice - vwapPrice) / vwapPrice * 100; // positive = above VWAP

  // Phase 1: Detect VWAP touch/cross
  if (!state.touchedVWAP) {
    // Price within 0.05% of VWAP = touching it
    if (Math.abs(vwapDist) <= 0.05) {
      state.touchedVWAP = true;
      state.touchTime = currentTs;
      // Direction: if trend is bullish and price pulled back DOWN to VWAP, entry is bullish
      state.touchDirection = dmiTrend === 'bullish' ? 'bullish' : 'bearish';
      state.barsAfterTouch = 0;
      state.consecutiveTrendBars = 0;
    }
    // Also trigger on wicks through VWAP (low touches VWAP in uptrend)
    if (dmiTrend === 'bullish' && currentBar.low <= vwapPrice * 1.0005 && currentBar.close > vwapPrice) {
      state.touchedVWAP = true;
      state.touchTime = currentTs;
      state.touchDirection = 'bullish';
      state.barsAfterTouch = 0;
      state.consecutiveTrendBars = 1; // this bar already counts as confirmation
    }
    if (dmiTrend === 'bearish' && currentBar.high >= vwapPrice * 0.9995 && currentBar.close < vwapPrice) {
      state.touchedVWAP = true;
      state.touchTime = currentTs;
      state.touchDirection = 'bearish';
      state.barsAfterTouch = 0;
      state.consecutiveTrendBars = 1;
    }
    return result;
  }

  // Phase 2: Count consecutive bars in trend direction
  state.barsAfterTouch++;

  if (state.touchDirection === 'bullish') {
    if (prevBar && currentBar.close > prevBar.close && currentBar.close > vwapPrice) {
      state.consecutiveTrendBars++;
    } else {
      state.consecutiveTrendBars = 0;
    }
  } else {
    if (prevBar && currentBar.close < prevBar.close && currentBar.close < vwapPrice) {
      state.consecutiveTrendBars++;
    } else {
      state.consecutiveTrendBars = 0;
    }
  }

  // Fire on 3 consecutive trend bars after VWAP touch
  if (state.consecutiveTrendBars >= 3) {
    result.fired = true;
    result.direction = state.touchDirection!;
    result.reason = `VWAP reclaim: touched $${vwapPrice.toFixed(2)}, ${state.consecutiveTrendBars} bars confirming ${state.touchDirection}`;
    state.touchedVWAP = false; // reset
    return result;
  }

  // Timeout: if no confirmation within 10 bars, reset
  if (state.barsAfterTouch > 10) {
    state.touchedVWAP = false;
  }

  return result;
}

/**
 * Trigger 3: Momentum Continuation
 *
 * Phase 1 (Detection): New HOD or LOD with volume > 1.3x avg
 * Phase 2 (Confirm):   Next 3 bars all close beyond the prior extreme level
 *                       (proves it's a real breakout, not a wick/fakeout)
 *
 * This filters out false breakouts where price spikes to new extreme but
 * immediately reverses.
 */
function updateMomentumState(
  state: MomentumState, currentBar: OHLCVBar, currentPrice: number, currentTs: number,
  dayHigh: number, dayLow: number, avgVolume: number, minutesSinceOpen: number,
  dmiTrend: 'bullish' | 'bearish' | 'neutral', adx: number,
): TriggerResult {
  const result: TriggerResult = { fired: false, type: 'MOMENTUM_CONTINUATION', direction: 'bullish', reason: '' };

  // Time window: 15 min to 14:30 ET (300 min from open)
  if (minutesSinceOpen > 300 || minutesSinceOpen < 15) return result;

  // ADX minimum
  if (adx < 18) return result;

  const volumeRatio = avgVolume > 0 ? currentBar.volume / avgVolume : 0;

  // Phase 1: Detect new extreme
  if (!state.newExtreme) {
    if (currentBar.high >= dayHigh && volumeRatio >= 1.3 && dmiTrend === 'bullish') {
      state.newExtreme = true;
      state.extremeTime = currentTs;
      state.extremeDirection = 'bullish';
      state.extremePrice = dayHigh;
      state.barsHoldingBeyond = 0;
      state.breakVolume = currentBar.volume;
    } else if (currentBar.low <= dayLow && volumeRatio >= 1.3 && dmiTrend === 'bearish') {
      state.newExtreme = true;
      state.extremeTime = currentTs;
      state.extremeDirection = 'bearish';
      state.extremePrice = dayLow;
      state.barsHoldingBeyond = 0;
      state.breakVolume = currentBar.volume;
    }
    return result;
  }

  // Phase 2: Count bars holding beyond the extreme
  if (state.extremeDirection === 'bullish') {
    if (currentBar.close > state.extremePrice) {
      state.barsHoldingBeyond++;
    } else {
      // Failed to hold — reset
      state.newExtreme = false;
      return result;
    }
  } else {
    if (currentBar.close < state.extremePrice) {
      state.barsHoldingBeyond++;
    } else {
      state.newExtreme = false;
      return result;
    }
  }

  // Fire on 3 bars holding beyond extreme
  if (state.barsHoldingBeyond >= 3) {
    result.fired = true;
    result.direction = state.extremeDirection!;
    const label = state.extremeDirection === 'bullish' ? 'HOD' : 'LOD';
    result.reason = `Momentum: new ${label} $${state.extremePrice.toFixed(2)}, held ${state.barsHoldingBeyond} bars, ADX ${adx.toFixed(0)}`;
    state.newExtreme = false; // reset
    return result;
  }

  // Timeout
  const barsSinceExtreme = Math.round((currentTs - state.extremeTime) / 60_000);
  if (barsSinceExtreme > 10) {
    state.newExtreme = false;
  }

  return result;
}

// ── Entry quality analysis (same as backtest-day.ts) ─────────────────────────

interface SimpleEntry {
  time: string;
  timeET: string;
  trigger: TriggerType;
  direction: SignalDirection;
  price: number;
  reason: string;
  regime: Regime;
  // Forward-move metrics
  mfePct: number;
  maePct: number;
  mfeOverMae: number;
  seqMfePct: number;
  seqMaePct: number;
  stoppedOut: boolean;
  stopThresholdPct: number;
  entryGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  mfePeakMinutes: number;
  move5mPct: number | null;
  move10mPct: number | null;
  move15mPct: number | null;
  move30mPct: number | null;
  sim: SimResult;
}

function computeForwardMoves(
  currentTs: number, currentPrice: number, direction: SignalDirection,
  atr: number, targetDateBars: OHLCVBar[],
) {
  const futureBars = targetDateBars.filter(b => {
    const bt = new Date(b.timestamp).getTime();
    return bt > currentTs && bt <= currentTs + 120 * 60_000;
  });
  const allFutureBars = targetDateBars.filter(b => new Date(b.timestamp).getTime() > currentTs);

  let maxFavorable = 0, maxAdverse = 0, mfePeakMinutes = 0;
  for (const fb of futureBars) {
    const move = direction === 'bullish' ? fb.high - currentPrice : currentPrice - fb.low;
    const adverse = direction === 'bullish' ? currentPrice - fb.low : fb.high - currentPrice;
    if (move > maxFavorable) {
      maxFavorable = move;
      mfePeakMinutes = Math.round((new Date(fb.timestamp).getTime() - currentTs) / 60_000);
    }
    if (adverse > maxAdverse) maxAdverse = adverse;
  }

  const findPriceAt = (mins: number): number | null => {
    const targetTime = currentTs + mins * 60_000;
    const bar = targetDateBars.find(b => {
      const bt = new Date(b.timestamp).getTime();
      return bt >= targetTime && bt < targetTime + 60_000;
    });
    return bar?.close ?? null;
  };

  const mfePct = (maxFavorable / currentPrice) * 100;
  const maePct = (maxAdverse / currentPrice) * 100;
  const mfeOverMae = maePct > 0.01 ? mfePct / maePct : (mfePct > 0 ? 99.9 : 0);

  const computeMovePct = (priceAtN: number | null): number | null => {
    if (priceAtN === null) return null;
    const move = direction === 'bullish' ? priceAtN - currentPrice : currentPrice - priceAtN;
    return (move / currentPrice) * 100;
  };

  const p5m = findPriceAt(5), p10m = findPriceAt(10), p15m = findPriceAt(15), p30m = findPriceAt(30);

  // Sequence-aware grading
  const stopThresholdPct = (atr / currentPrice) * 100 * 0.40;
  let seqMfePct = 0, seqMaePct = 0, stoppedOut = false;
  for (const fb of futureBars) {
    const favMove = direction === 'bullish'
      ? ((fb.open - currentPrice) / currentPrice) * 100
      : ((currentPrice - fb.open) / currentPrice) * 100;
    const advMove = favMove < 0 ? -favMove : 0;
    const favGain = favMove > 0 ? favMove : 0;
    if (advMove > seqMaePct) seqMaePct = advMove;
    if (seqMaePct >= stopThresholdPct) { stoppedOut = true; break; }
    if (favGain > seqMfePct) seqMfePct = favGain;
  }

  const directionCorrect = seqMfePct > 0.10;
  let entryGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (seqMfePct > 0.40) entryGrade = 'A';
  else if (seqMfePct > 0.25) entryGrade = 'B';
  else if (seqMfePct > 0.15 && directionCorrect) entryGrade = 'C';
  else if (directionCorrect) entryGrade = 'D';
  else entryGrade = 'F';

  let outcome: 'GOOD' | 'BAD' | 'MARGINAL' = 'MARGINAL';
  if (entryGrade === 'A' || entryGrade === 'B') outcome = 'GOOD';
  else if (entryGrade === 'F') outcome = 'BAD';

  // Sim
  const recentBars = targetDateBars.filter(b => {
    const bt = new Date(b.timestamp).getTime();
    return bt <= currentTs && bt > currentTs - 10 * 60_000;
  });
  const sim = simulateOrderAgent(currentPrice, direction, atr, allFutureBars, { recentBars });

  return {
    mfePct, maePct, mfeOverMae, seqMfePct, seqMaePct, stoppedOut, stopThresholdPct,
    entryGrade, outcome, mfePeakMinutes, sim,
    move5mPct: computeMovePct(p5m),
    move10mPct: computeMovePct(p10m),
    move15mPct: computeMovePct(p15m),
    move30mPct: computeMovePct(p30m),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  SIMPLE EVENT-DRIVEN BACKTEST: ${TICKER} on ${TARGET_DATE}`);
  console.log(`  Triggers: ORB_RETEST | VWAP_RECLAIM | MOMENTUM_CONTINUATION`);
  console.log(`${'='.repeat(80)}\n`);

  // ── Fetch data ────────────────────────────────────────────────────────────
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 4);
  const startStr = warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const endStr = TARGET_DATE + 'T23:59:59Z';

  console.log(`Fetching 1m bars: ${startStr} → ${endStr}`);
  const allOneMinRaw = await fetchBarsRange(TICKER, '1m', startStr, endStr);
  const allOneMin = allOneMinRaw.filter(b => isRegularSession(b.timestamp));
  console.log(`  → ${allOneMinRaw.length} raw, ${allOneMin.length} regular-session`);

  const targetDateBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  console.log(`  → ${targetDateBars.length} bars on ${TARGET_DATE}`);
  if (targetDateBars.length === 0) {
    console.error(`No bars for ${TARGET_DATE}. Was it a trading day?`);
    process.exit(1);
  }

  const dayOpen = targetDateBars[0]!.open;
  const dayClose = targetDateBars[targetDateBars.length - 1]!.close;
  console.log(`  Day: Open $${dayOpen.toFixed(2)}, Close $${dayClose.toFixed(2)}, Change ${((dayClose - dayOpen) / dayOpen * 100).toFixed(2)}%\n`);

  // ── Build stream cache (same as backtest-day.ts) ──────────────────────────
  const BAR_CACHE_SIZE = 800;
  const openTime = new Date(`${TARGET_DATE}T${MARKET_OPEN_UTC}:00Z`);
  const closeTime = new Date(`${TARGET_DATE}T${MARKET_CLOSE_UTC}:00Z`);
  const openTs = openTime.getTime();

  const warmupTs = new Date(TARGET_DATE);
  warmupTs.setDate(warmupTs.getDate() - 4);
  const seedFiltered = allOneMinRaw
    .filter(b => {
      const ts = new Date(b.timestamp).getTime();
      return ts >= warmupTs.getTime() && ts < openTs;
    })
    .slice(0, 1000)
    .filter(b => isRegularSession(b.timestamp));
  const streamCache: OHLCVBar[] = seedFiltered.slice(-BAR_CACHE_SIZE);
  console.log(`  Stream cache: ${streamCache.length} bars seeded\n`);

  // ── ORB computation (first 30 min) ────────────────────────────────────────
  const orbEndTs = openTs + 30 * 60_000;
  const orbBars = targetDateBars.filter(b => {
    const ts = new Date(b.timestamp).getTime();
    return ts >= openTs && ts < orbEndTs;
  });
  const orbHigh = orbBars.length > 0 ? Math.max(...orbBars.map(b => b.high)) : 0;
  const orbLow = orbBars.length > 0 ? Math.min(...orbBars.map(b => b.low)) : 0;
  const orbFormed = orbBars.length >= 25; // need at least 25 of 30 bars
  console.log(`  ORB: $${orbLow.toFixed(2)} – $${orbHigh.toFixed(2)} (${orbBars.length} bars, formed: ${orbFormed})`);

  // ── Walk market hours ──────────────────────────────────────────────────────
  const entries: SimpleEntry[] = [];
  let todayBarIdx = 0;
  let tickCount = 0;

  // Day tracking
  let dayHigh = targetDateBars[0]!.high;
  let dayLow = targetDateBars[0]!.low;

  // Cooldowns: one entry per trigger type, 20 min between any entries
  let lastEntryTs = 0;
  const MAX_ENTRIES = 3; // max 3 entries per day total
  const COOLDOWN_MIN = 20; // 20 min between any entries
  const MAX_PER_TYPE = 1; // max 1 entry per trigger type
  const entryCountByType: Record<TriggerType, number> = {
    ORB_RETEST: 0, VWAP_RECLAIM: 0, MOMENTUM_CONTINUATION: 0,
  };

  // Volume tracking
  const recentVolumes: number[] = [];
  const VOLUME_WINDOW = 20;

  // Stateful trigger tracking
  const orbState = createORBState();
  const vwapState = createVWAPState();
  const momentumState = createMomentumState();

  for (let t = new Date(openTime); t <= closeTime; t.setMinutes(t.getMinutes() + 1)) {
    const currentTs = t.getTime();
    const timeStr = t.toISOString();
    const timeET = utcToET(timeStr);
    const minutesSinceOpen = (currentTs - openTs) / 60_000;

    // Add completed bars to cache
    while (todayBarIdx < targetDateBars.length) {
      const barTs = new Date(targetDateBars[todayBarIdx]!.timestamp).getTime();
      if (barTs < currentTs) {
        const bar = targetDateBars[todayBarIdx]!;
        streamCache.push(bar);
        if (streamCache.length > BAR_CACHE_SIZE) streamCache.splice(0, 1);

        // Track day high/low and volume
        if (bar.high > dayHigh) dayHigh = bar.high;
        if (bar.low < dayLow) dayLow = bar.low;
        recentVolumes.push(bar.volume);
        if (recentVolumes.length > VOLUME_WINDOW) recentVolumes.shift();

        todayBarIdx++;
      } else {
        break;
      }
    }

    if (streamCache.length < 30) continue;

    const currentBar = streamCache[streamCache.length - 1]!;
    const prevBar = streamCache.length >= 2 ? streamCache[streamCache.length - 2]! : undefined;
    const currentPrice = currentBar.close;

    // Average volume
    const avgVolume = recentVolumes.length > 0
      ? recentVolumes.reduce((s, v) => s + v, 0) / recentVolumes.length
      : 0;

    // ── Compute minimal indicators ───────────────────────────────────────────
    const htfBars = aggregate1mBars(streamCache, '5m', currentTs).slice(-100);
    if (htfBars.length < 14) continue;

    const dmi = computeDMI(htfBars, 14, true);
    const atrResult = computeATR(htfBars, 14, true);
    const atr = atrResult.atr;
    const vwapResult = computeVWAP(streamCache.slice(-400)); // VWAP from today's bars

    // ── Regime detection ─────────────────────────────────────────────────────
    const regime = detectRegime(htfBars, targetDateBars.slice(0, todayBarIdx));

    // ── Update stateful triggers (always update, even during cooldown) ─────
    // This ensures state tracking continues even when we can't enter.
    // Triggers are pass/fail with multi-bar confirmation.

    // 1. ORB Break + Retest (after ORB forms, within first 3h)
    let orbTrigger: TriggerResult = { fired: false, type: 'ORB_RETEST', direction: 'bullish', reason: '' };
    if (minutesSinceOpen >= 30 && minutesSinceOpen <= 210) {
      orbTrigger = updateORBState(orbState, currentBar, currentPrice, currentTs,
        orbHigh, orbLow, orbFormed, avgVolume);
    }

    // 2. VWAP Reclaim (after first 45 min)
    let vwapTrigger: TriggerResult = { fired: false, type: 'VWAP_RECLAIM', direction: 'bullish', reason: '' };
    if (minutesSinceOpen >= 45) {
      vwapTrigger = updateVWAPState(vwapState, currentBar, currentPrice, currentTs,
        vwapResult.vwap, prevBar, dmi.trend, regime);
    }

    // 3. Momentum Continuation (15 min to 14:30 ET)
    let momentumTrigger: TriggerResult = { fired: false, type: 'MOMENTUM_CONTINUATION', direction: 'bullish', reason: '' };
    momentumTrigger = updateMomentumState(momentumState, currentBar, currentPrice, currentTs,
      dayHigh, dayLow, avgVolume, minutesSinceOpen, dmi.trend, dmi.adx);

    // ── Check if any trigger fired ──────────────────────────────────────────
    const totalEntries = entries.length;
    if (totalEntries >= MAX_ENTRIES) continue;

    const cooldownOk = (currentTs - lastEntryTs) >= COOLDOWN_MIN * 60_000 || lastEntryTs === 0;
    if (!cooldownOk) continue;

    // Don't enter in last 30 min
    if (minutesSinceOpen > 360) continue;

    // Find first fired trigger that hasn't exceeded its per-type limit
    const allTriggers = [orbTrigger, vwapTrigger, momentumTrigger];
    const fired = allTriggers.find(t => t.fired && entryCountByType[t.type] < MAX_PER_TYPE);
    if (!fired) continue;

    // Compute forward moves and grade
    const fwd = computeForwardMoves(currentTs, currentPrice, fired.direction, atr, targetDateBars);

    entries.push({
      time: timeStr,
      timeET,
      trigger: fired.type,
      direction: fired.direction,
      price: currentPrice,
      reason: fired.reason,
      regime,
      ...fwd,
    });

    lastEntryTs = currentTs;
    entryCountByType[fired.type]++;

    tickCount++;
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  RESULTS: ${entries.length} entries fired`);
  console.log(`${'='.repeat(80)}\n`);

  if (entries.length === 0) {
    console.log('  No triggers fired today. This is expected — the system is selective.\n');

    // Still scan for moves to see what was available
    scanMoves(targetDateBars, openTs, []);
    return;
  }

  // Entry table
  console.log(`  #   Time    Trigger           Dir      Price      Grade  MFE%    MAE%   R     seqMFE%  Outcome    Reason`);
  console.log(`  ${'─'.repeat(130)}`);

  let goodCount = 0, badCount = 0, marginalCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const num = String(i + 1).padStart(2);
    const trigger = e.trigger.padEnd(18);
    const dir = (e.direction === 'bullish' ? '▲ bull' : '▼ bear').padEnd(8);
    const grade = e.entryGrade;
    const mfe = e.mfePct.toFixed(2).padStart(5);
    const mae = e.maePct.toFixed(2).padStart(5);
    const ratio = e.mfeOverMae.toFixed(1).padStart(5);
    const seqMfe = e.seqMfePct.toFixed(2).padStart(5);
    const outcomeIcon = e.outcome === 'GOOD' ? '✅ GOOD' : e.outcome === 'BAD' ? '❌ BAD' : '➖ MARG';

    if (e.outcome === 'GOOD') goodCount++;
    else if (e.outcome === 'BAD') badCount++;
    else marginalCount++;

    console.log(`  ${num}  ${e.timeET}  ${trigger} ${dir} $${e.price.toFixed(2)}    ${grade}     ${mfe}%  ${mae}%  ${ratio}   ${seqMfe}%   ${outcomeIcon}   ${e.reason}`);
  }

  // Summary
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  SUMMARY`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Total entries:  ${entries.length}`);
  console.log(`  GOOD (A/B):     ${goodCount}`);
  console.log(`  BAD (F):        ${badCount}`);
  console.log(`  MARGINAL (C/D): ${marginalCount}`);
  console.log(`  Win rate:       ${entries.length > 0 ? ((goodCount / entries.length) * 100).toFixed(0) : 'N/A'}%`);

  // Per-trigger breakdown
  const triggerTypes: TriggerType[] = ['ORB_RETEST', 'VWAP_RECLAIM', 'MOMENTUM_CONTINUATION'];
  console.log(`\n  Per-trigger:`);
  for (const tt of triggerTypes) {
    const tEntries = entries.filter(e => e.trigger === tt);
    if (tEntries.length === 0) continue;
    const tGood = tEntries.filter(e => e.outcome === 'GOOD').length;
    const tBad = tEntries.filter(e => e.outcome === 'BAD').length;
    const avgMfe = tEntries.reduce((s, e) => s + e.seqMfePct, 0) / tEntries.length;
    console.log(`    ${tt.padEnd(18)}: ${tEntries.length} entries, ${tGood}W/${tBad}L, avg seqMFE ${avgMfe.toFixed(2)}%`);
  }

  // Sim results
  console.log(`\n  Simulated exits:`);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const pnl = e.sim.pnlPct >= 0 ? `+${e.sim.pnlPct.toFixed(1)}%` : `${e.sim.pnlPct.toFixed(1)}%`;
    console.log(`    #${i + 1} ${e.timeET} ${e.trigger}: ${e.sim.exitReason} after ${e.sim.holdMinutes}m, P&L ${pnl} (peak ${e.sim.peakPnlPct.toFixed(1)}%)`);
  }

  // Forward moves detail
  console.log(`\n  Forward moves:`);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const m5 = e.move5mPct !== null ? `${e.move5mPct >= 0 ? '+' : ''}${e.move5mPct.toFixed(2)}%` : '—';
    const m10 = e.move10mPct !== null ? `${e.move10mPct >= 0 ? '+' : ''}${e.move10mPct.toFixed(2)}%` : '—';
    const m15 = e.move15mPct !== null ? `${e.move15mPct >= 0 ? '+' : ''}${e.move15mPct.toFixed(2)}%` : '—';
    const m30 = e.move30mPct !== null ? `${e.move30mPct >= 0 ? '+' : ''}${e.move30mPct.toFixed(2)}%` : '—';
    console.log(`    #${i + 1} 5m:${m5}  10m:${m10}  15m:${m15}  30m:${m30}  peak@${e.mfePeakMinutes}m`);
  }

  // Scan for missed moves
  scanMoves(targetDateBars, openTs, entries);
}

// ── Market move scanner (same logic as backtest-day.ts) ──────────────────────

function scanMoves(targetDateBars: OHLCVBar[], openTs: number, entries: SimpleEntry[]) {
  const MIN_MFE_PCT = 0.30;

  interface MarketMove {
    startTime: string; startTimeET: string; startPrice: number; startIdx: number;
    peakTime: string; peakTimeET: string; peakPrice: number;
    direction: 'bullish' | 'bearish';
    mfePct: number; maePct: number; mfePeakMinutes: number;
  }

  const moves: MarketMove[] = [];

  for (let i = 0; i < targetDateBars.length - 5; i++) {
    const bar = targetDateBars[i]!;
    const startPrice = bar.close;
    const startTs = new Date(bar.timestamp).getTime();

    // Check for significant moves starting from each bar
    for (const dir of ['bullish', 'bearish'] as const) {
      let mfe = 0, mae = 0, peakPrice = startPrice, peakTime = bar.timestamp, peakMin = 0;
      for (let j = i + 1; j < Math.min(i + 121, targetDateBars.length); j++) {
        const fb = targetDateBars[j]!;
        const fav = dir === 'bullish' ? fb.high - startPrice : startPrice - fb.low;
        const adv = dir === 'bullish' ? startPrice - fb.low : fb.high - startPrice;
        if (fav > mfe) {
          mfe = fav;
          peakPrice = dir === 'bullish' ? fb.high : fb.low;
          peakTime = fb.timestamp;
          peakMin = Math.round((new Date(fb.timestamp).getTime() - startTs) / 60_000);
        }
        if (adv > mae) mae = adv;
      }
      const mfePct = (mfe / startPrice) * 100;
      const maePct = (mae / startPrice) * 100;
      const mfeOverMae = maePct > 0.01 ? mfePct / maePct : 999;

      if (mfePct >= MIN_MFE_PCT && mfeOverMae > 1.2 && peakMin >= 5) {
        moves.push({
          startTime: bar.timestamp,
          startTimeET: utcToET(bar.timestamp),
          startPrice, startIdx: i,
          peakTime, peakTimeET: utcToET(peakTime), peakPrice,
          direction: dir, mfePct, maePct, mfePeakMinutes: peakMin,
        });
      }
    }
  }

  // Deduplicate overlapping moves
  const dedupedMoves: MarketMove[] = [];
  for (const mv of moves.sort((a, b) => b.mfePct - a.mfePct)) {
    const overlap = dedupedMoves.some(d => {
      const dStart = new Date(d.startTime).getTime();
      const dPeak = new Date(d.peakTime).getTime();
      const mvStart = new Date(mv.startTime).getTime();
      const mvPeak = new Date(mv.peakTime).getTime();
      return d.direction === mv.direction &&
        ((mvStart >= dStart && mvStart <= dPeak) || (dStart >= mvStart && dStart <= mvPeak));
    });
    if (!overlap) dedupedMoves.push(mv);
  }
  dedupedMoves.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  MARKET MOVE SCANNER`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Significant moves: ${dedupedMoves.length} (MFE >= ${MIN_MFE_PCT}%, R > 1.2)`);

  // Check which moves were caught
  let caught = 0, missed = 0;
  console.log(`\n  #   Time Range          Dir      Price Range             MFE%   MAE%   R      Status`);
  console.log(`  ${'─'.repeat(95)}`);
  for (let mi = 0; mi < dedupedMoves.length; mi++) {
    const mv = dedupedMoves[mi]!;
    const mvTs = new Date(mv.startTime).getTime();
    const caughtByEntry = entries.some(e => {
      const eTs = new Date(e.time).getTime();
      return Math.abs(eTs - mvTs) <= 5 * 60_000 && e.direction === mv.direction;
    });
    const dirIcon = mv.direction === 'bullish' ? '▲' : '▼';
    const mfeOverMae = mv.maePct > 0.01 ? (mv.mfePct / mv.maePct).toFixed(1) : '∞';
    const status = caughtByEntry ? '✅ CAUGHT' : '❌ MISSED';
    if (caughtByEntry) caught++; else missed++;

    console.log(`  ${String(mi + 1).padStart(2)}  ${mv.startTimeET}→${mv.peakTimeET}    ${dirIcon} ${mv.direction.padEnd(7)}  $${mv.startPrice.toFixed(2)} → $${mv.peakPrice.toFixed(2)}    ${mv.mfePct.toFixed(2)}%  ${mv.maePct.toFixed(2)}%  ${mfeOverMae.padStart(5)}  ${status}`);
  }
  console.log(`\n  Capture rate: ${dedupedMoves.length > 0 ? (caught / dedupedMoves.length * 100).toFixed(0) : 'N/A'}% (${caught}/${dedupedMoves.length})`);
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
