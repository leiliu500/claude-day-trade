/**
 * DIA-specific trading strategy.
 *
 * Built from scratch 2026-04-27 (NOT a SPY clone). DIA tracks 30 large-cap
 * blue-chip Dow components — different microstructure from SPY's broad-500
 * basket. Even though both are large-cap ETFs, DIA's narrower constituent set
 * + price-weighted index produce different intraday signal distributions:
 *   - Heavier concentration in industrials/financials/healthcare vs SPY's
 *     tech-heavy weighting
 *   - Lower absolute price (~$425 vs ~$560) means similar atrPct% maps to
 *     smaller absolute moves — entry filters tuned in dollar terms drift
 *   - Slightly lower options liquidity than SPY, wider effective spreads
 *   - 30-stock basket reacts more linearly to broad macro / Fed headlines
 *     than SPY's tech-influenced moves
 *
 * Approach: start with no entry filters (only the structural regime score
 * computation), mine F-clusters from 15-mo backtest data, then add filters
 * incrementally based on what DIA's data actually shows. SPY's filter set is
 * intentionally NOT cloned — prior DIA tuning session (2026-04-25/26 commits
 * 57659fa..41fef00) tried that approach and produced 4 reverts + 1 marginal
 * merge before being discarded.
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import { defaultStrategy } from './default.js';

// ── Module-level state ──────────────────────────────────────────────────────
let _lastRegimeScore = 50;

// ── Regime score ────────────────────────────────────────────────────────────
// Same hybrid algorithm as SPY/QQQ/IWM/TSLA — kept identical because regime is
// a structural breadth signal, not ticker-specific.
function computeRegimeScore(
  bars: readonly { timestamp: string; open: number; high: number; low: number; close: number }[],
  vwapPriceVs: number,
  adx: number,
): number {
  const lastBar = bars[bars.length - 1];
  if (!lastBar) return 50;
  const todayStr = lastBar.timestamp.slice(0, 10);
  const todayBars = bars.filter(b => {
    if (!b.timestamp.startsWith(todayStr)) return false;
    const h = parseInt(b.timestamp.slice(11, 13), 10);
    const m = parseInt(b.timestamp.slice(14, 16), 10);
    const mins = h * 60 + m;
    return mins >= 810 && mins < 1200;
  });
  if (todayBars.length < 20) return 50;

  const recent30 = todayBars.slice(-30);
  let flips = 0;
  let prevDir: 'up' | 'down' | null = null;
  for (const bar of recent30) {
    const dir = bar.close >= bar.open ? 'up' : 'down';
    if (prevDir && dir !== prevDir) flips++;
    prevDir = dir;
  }
  const expectedFlips = Math.max(1, recent30.length / 4);
  const choppiness = Math.max(0, Math.min(4, flips / expectedFlips));
  const choppinessComponent = (1 - choppiness) * 15;

  const dayOpen = todayBars[0]!.open;
  let velocityComponent = 0;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    velocityComponent = Math.min(10, Math.max(-10, (avgRecent - avgPrior) * 15));
  }

  const last10 = todayBars.slice(-10);
  let consecUp = 0, consecDown = 0, maxConsecUp = 0, maxConsecDown = 0;
  for (let i = 1; i < last10.length; i++) {
    if (last10[i]!.close > last10[i - 1]!.close) {
      consecUp++; consecDown = 0;
      if (consecUp > maxConsecUp) maxConsecUp = consecUp;
    } else {
      consecDown++; consecUp = 0;
      if (consecDown > maxConsecDown) maxConsecDown = consecDown;
    }
  }
  const trendStrComponent = Math.min(10, Math.max(maxConsecUp, maxConsecDown) * 2.5);
  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

// ── DIA Mode Detection ──────────────────────────────────────────────────────
function diaDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ReturnType<typeof defaultStrategy.detectMode> {
  const ltf = tfIndicators[0];
  if (ltf) {
    _lastRegimeScore = computeRegimeScore(
      ltf.bars,
      ltf.vwap?.priceVsVwap ?? 0,
      ltf.dmi.adx,
    );
  }
  return defaultStrategy.detectMode(tfIndicators, direction, currentPrice);
}

// ── DIA Entry Filter ────────────────────────────────────────────────────────
// Filters added 2026-04-27 from 15-mo F-cluster mining + time-of-day analysis.
// Order matches backtest-configs/dia.ts (single source of truth).
function diaShouldAllowEntry(ctx: EntryContext): true | string {
  // Open window — first 30 min (9:30-10:00 ET). Backtest enforces this via
  // entryWindowStartMin/EndMin in DIA_CONFIG; explicit filter ensures live
  // pipeline agrees. 15-mo bucket: n=202, exp -0.762, F-rate 60%.
  if (ctx.minutesSinceOpen !== undefined && ctx.minutesSinceOpen < 30) {
    return `open window ${ctx.minutesSinceOpen}m < 30 (first 30 min)`;
  }

  // EOD window — last 30 min (15:30-16:00 ET). 15-mo bucket: n=27, exp -1.319,
  // F-rate 74% (highest of any time bucket).
  if (ctx.minutesSinceOpen !== undefined && ctx.minutesSinceOpen >= 360) {
    return `EOD window ${ctx.minutesSinceOpen}m >= 360 (last 30 min)`;
  }

  // Midday-deep window — 12:30-13:00 ET. 15-mo: n=80, exp -1.038, F-rate 56%.
  if (ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 180 && ctx.minutesSinceOpen < 210) {
    return `midday-deep ${ctx.minutesSinceOpen}m (12:30-13:00 ET)`;
  }

  // Mid-afternoon window — 14:00-15:30 ET. 15-mo baseline: 14:00 n=51 exp -0.961,
  // 14:30 n=42 exp -1.048, 15:00 n=41 exp -0.780. Combined n=134, exp -0.943,
  // F-rate 53%. Pre-Fed-headline waiting / lower-volume regime on Dow basket.
  if (ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 270 && ctx.minutesSinceOpen < 360) {
    return `mid-afternoon ${ctx.minutesSinceOpen}m (14:00-15:30 ET)`;
  }

  // F-cluster filter: absolute ATR < 0.35 (DIA at ~$425 → ~0.08% atrPct).
  // Mined 2026-04-27 progressively from baseline → v1 (+time blocks) → v2
  // (+bullish-breakout block). v2 mining showed F-density concentrated below
  // 0.35: 51 entries at [0.30, 0.32) are 1A/6B/3C/1D/40F (78% F), 50 entries
  // at [0.32, 0.35) are 7A/2B/8C/7D/26F (52% F). Below 0.30: 6A/4B/17C/12D/104F
  // from baseline mining. Total <0.35 catches ~140 F entries with modest AB cost.
  if (ctx.atr < 0.35) {
    return `atr ${ctx.atr.toFixed(2)} < 0.35 (dead zone)`;
  }

  // Bullish breakout block — direction × mode mining 2026-04-27:
  // BULLISH/BREAKOUT n=144, exp -0.736, F-rate 49%. Bad in 14/16 monthly buckets
  // (only 2025-04 +0.143 and 2026-03 +0.444 positive). DIA Dow basket is
  // structurally bad at bullish breakout signals — without SPY's tuned breakout
  // filter chain, every confidence band ≤ 80% loses badly. Bearish breakouts
  // (exp -0.531) are kept since they match bearish-trend (no directional bias).
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout') {
    return `bullish breakout (15-mo exp -0.736)`;
  }

  // Bearish 10:30-11:00 ET window — time × direction mining 2026-04-27:
  // n=68, exp -0.779, F-rate 53%. Significant cluster of bearish entries that
  // fail in the late-morning bounce window. Same direction in earlier (10:00-10:30
  // exp -0.275) and later (11:00-11:30 exp -0.516) windows is materially better.
  if (ctx.direction === 'bearish' && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 60 && ctx.minutesSinceOpen < 90) {
    return `bearish 10:30-11:00 ET window ${ctx.minutesSinceOpen}m`;
  }

  return true;
}

// ── Export ───────────────────────────────────────────────────────────────────
export const diaStrategy: PartialTickerStrategy = {
  detectMode: diaDetectMode,
  shouldAllowEntry: diaShouldAllowEntry,
};

export { _lastRegimeScore };
