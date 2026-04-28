/**
 * SPY-specific trading strategy.
 *
 * Built from scratch 2026-04-28 — discarded prior tuning chain (a4387bd /
 * 7dfc0a2 / da864c0 / 01081e8 / eb86c5b / 3ced689 / 2bb1b39 / 9ecbff7) and
 * starting fresh from bare baseline. Same playbook as DIA `b21bf7b` and IWM
 * `eaa89cb` rebuilds: start with regime score only, mine F-clusters from
 * 15-mo SPY backtest, add filters incrementally based on what SPY's data
 * actually shows.
 *
 * SPY tracks the S&P 500 broad-cap basket — fundamental microstructure:
 *   - 500 large-cap constituents; thicker liquidity per name
 *   - Higher absolute price (~$560 currently) than IWM/DIA
 *   - Tight options spreads, deep open interest
 *   - Most-traded ETF; reflects broad-market institutional flow
 *   - Typical atrPct 0.08-0.18 (smaller than IWM 0.15-0.30)
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import { defaultStrategy } from './default.js';

let _lastRegimeScore = 50;

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

function spyDetectMode(
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

// Filters added incrementally from 15-mo SPY F-cluster mining.
// Order matches backtest-configs/spy.ts (single source of truth).
function spyShouldAllowEntry(ctx: EntryContext): true | string {
  // v1: bullish low-atr (any mode).
  // Bare-baseline mining (n=1133 exp -0.513): bullish (trend + breakout) at
  // atr < 0.60 is uniformly catastrophic — direction accuracy 31-50%, F-rate
  // 50-70%, expectancy -1.10 to -1.47:
  //   bullish trend × atr breakdown:
  //     atr < 0.40:   n=36  exp -1.47  dir 31%  (0A/3B/2C/6D/25F)
  //     atr 0.40-50:  n=40  exp -1.18  dir 40%
  //     atr 0.50-60:  n=47  exp -0.87  dir 49%
  //     atr 0.60+:    structurally negative but at -0.22 to -0.97
  //   bullish breakout × atr breakdown:
  //     atr < 0.40:   n=36  exp -1.44  dir 31%
  //     atr 0.40-50:  n=32  exp -0.91  dir 44%
  //     atr 0.50-60:  n=26  exp -0.96  dir 50%
  //     atr 0.60+:    healthier (+0.50 at 1.0-1.5)
  // Combined block: 217 entries (5A+13B+39C+20D+129F) → 60% F. Same low-atr
  // pattern as IWM v4/v6, but SPY's threshold is higher (0.60 vs IWM's 0.40)
  // because SPY trades at ~$560 vs IWM ~$215.
  if (ctx.direction === 'bullish' && ctx.atr < 0.60) {
    return `bullish low atr ${ctx.atr.toFixed(2)} < 0.60`;
  }

  // v2: bearish-trend mid-confidence anti-predictive band [0.70, 0.90).
  // SPY-specific: bearish trend confidence is non-monotonic (U-shape) with a
  // bimodal good/bad pattern. The 0.65-0.70 and 0.90-0.95 bands are positive,
  // everything in between is bad:
  //   conf 0.65-0.70: n=113 exp +0.381 dir 76% — BEST slice (lowest conf!)
  //   conf 0.70-0.75: n=49  exp -0.388 dir 55%
  //   conf 0.75-0.80: n=70  exp -0.686 dir 53%
  //   conf 0.80-0.85: n=71  exp -1.056 dir 34%  — anti-predictive
  //   conf 0.85-0.90: n=40  exp -1.050 dir 45%  — anti-predictive
  //   conf 0.90-0.95: n=19  exp +0.158 dir 74%  — positive island, KEEP
  //   conf 0.95+:     n=14  exp -0.714 dir 43%  — small N
  // Filter blocks 230 entries (49+70+71+40) in the bad mid-conf trough.
  // First-attempt narrower filter [0.80, 0.90) was cascade-nullified (+0.026
  // vs +0.124 predicted) — cluster cascade backfilled with same-cluster bad
  // entries. Broader filter eliminates the backfill pool.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.confidence >= 0.70 && ctx.confidence < 0.90) {
    return `bearish-trend mid-conf ${(ctx.confidence * 100).toFixed(0)}% anti-predictive`;
  }

  // v3: bullish-trend low-atr extension (mode-specific tightening of v1).
  // v2b residual: bullish trend at atr 0.6-0.8 still uniformly catastrophic:
  //   atr 0.60-0.70: n=42 exp -0.952 dir 48%  (1A/7B/7C/5D/22F)
  //   atr 0.70-0.80: n=31 exp -1.000 dir 48%  (2A/2B/6C/5D/16F)
  //   atr 0.80-1.00: n=67 exp -0.239 dir 66%  (recovery)
  // Combined 0.60-0.80 in bull-trend: n=73 exp -0.97, 3A+9B vs 38F.
  // Mode-specific because bull-breakout at atr 0.6-0.8 is only mildly bad
  // (-0.35 in v0). Effective bull-trend atr threshold: 0.80.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend' && ctx.atr < 0.80) {
    return `bullish-trend low atr ${ctx.atr.toFixed(2)} < 0.80`;
  }

  return true;
}

function spyAdjustConfidence(breakdown: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return breakdown;
}

export const spyStrategy: PartialTickerStrategy = {
  detectMode: spyDetectMode,
  shouldAllowEntry: spyShouldAllowEntry,
  adjustConfidence: spyAdjustConfidence,
};

export { _lastRegimeScore };
