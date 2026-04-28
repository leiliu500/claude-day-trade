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

  // v8: bearish-trend high-conf [0.90, 1.0) extension of v2's anti-predictive band.
  // v0 mining showed conf 0.90-0.95 was a positive island (n=19 exp +0.158) but
  // small-N. v7 cache (with v2b applied) shows the band has flipped:
  //   conf 0.90-0.95: n=46 exp -0.326 dir 57%  — slice composition shifted
  //   conf 0.95-1.00: n=25 exp -0.840 dir 44%  — anti-predictive
  // Combined [0.90, 1.0): 71 entries exp -0.51. Bear-trend confidence is now
  // monotonically anti-predictive ABOVE 0.65-0.70 (the only positive band).
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.confidence >= 0.90) {
    return `bearish-trend high-conf ${(ctx.confidence * 100).toFixed(0)}% anti-predictive`;
  }

  // v4: bearish-breakout low-atr — symmetric mirror of v1 for bearish.
  // v3 residual: bearish breakout × atr buckets uniformly catastrophic at low atr:
  //   atr 0.0-0.4: n=25 exp -1.160 dir 28%  (2A/3B/2C/0D/18F)
  //   atr 0.4-0.5: n=19 exp -1.684 dir 16%  (0A/1B/1C/1D/16F) — dir 16%, 84% F
  //   atr 0.5-0.6: n=17 exp -0.882 dir 41%
  //   atr 0.6-0.8: -0.64 (recovery)
  //   atr 0.8+:    -0.19 to +0.91
  // Combined atr<0.60 in bearish-breakout: 61 entries exp ~-1.27, dir 28-41%.
  // The atr 0.4-0.5 dir 16% means system is wrong 84% of the time at these
  // confidence levels — clear anti-predictive zone.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout' && ctx.atr < 0.60) {
    return `bearish-breakout low atr ${ctx.atr.toFixed(2)} < 0.60`;
  }

  // v10: bearish-breakout mid-atr [0.70, 1.00) — second bad pocket above v4.
  // v9 residual showed bear-breakout atr is non-monotonic:
  //   atr <0.60:    blocked by v4
  //   atr 0.60-0.70: n=25 exp -0.08  — mild bad (borderline, not filtered)
  //   atr 0.70-0.80: n=15 exp -1.40 dir 33% — narrow anti-predictive pocket
  //   atr 0.80-1.00: n=29 exp -0.31  — mid bad
  //   atr 1.00-1.50: n=30 exp -0.13  — mild bad (preserved)
  //   atr 1.50+:    n=12 exp +1.00   — KEEP (positive)
  // Combined [0.70, 1.00): 44 entries exp -0.68, 8A+5B vs 23F.
  // Skip [0.60, 0.70) to preserve some AB; skip [1.00, 1.50) (mild) and [1.50+]
  // (positive). Targets only the worst non-contiguous bands.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout'
      && ctx.atr >= 0.70 && ctx.atr < 1.00) {
    return `bearish-breakout mid-atr ${ctx.atr.toFixed(2)} in [0.70, 1.00)`;
  }

  // v5: bearish-trend mid-atr U-shape — block 0.4-0.6 trough, KEEP both tails.
  // v4 residual reveals U-shape in bear-trend × atr (NOT a low-atr pattern):
  //   atr 0.0-0.4: n=43 exp +0.279 dir 65% — POSITIVE (low-atr is good for bear-trend!)
  //   atr 0.4-0.5: n=31 exp -0.645 dir 48%  — BAD trough start
  //   atr 0.5-0.6: n=50 exp -0.680 dir 60%  — BAD trough
  //   atr 0.6-0.8: n=98 exp -0.194 dir 65%  — recovery
  //   atr 0.8+:    +0.04 to +0.38           — clean
  // Bear-trend uniquely has positive expectancy at very low atr (unlike bull
  // modes and bear-breakout which are uniformly bad at low atr). Filter
  // targets only the 0.40-0.60 trough — preserves both the low-atr good zone
  // and the high-atr good zone.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.atr >= 0.40 && ctx.atr < 0.60) {
    return `bearish-trend mid-atr ${ctx.atr.toFixed(2)} in [0.40, 0.60)`;
  }

  // v7: bullish-breakout low-atr extension <0.60 → <0.80.
  // Symmetric to v3 (which set bull-trend atr threshold to 0.80). v6 residual:
  //   bull-breakout × atr 0.6-0.8: n=54 exp -0.519 (5A/10B/10C/10D/19F)
  //   bull-breakout × atr 0.8-1.0: n=32 exp -0.313 (mid bad, kept for v8 probe)
  //   bull-breakout × atr 1.0+:    healthy (+0.22 to +1.0)
  // Both bull modes now share atr < 0.80 floor. SPY-wide pattern: bullish at
  // low-mid atr is anti-predictive (different from bear-trend U-shape).
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout' && ctx.atr < 0.80) {
    return `bullish-breakout low atr ${ctx.atr.toFixed(2)} < 0.80`;
  }

  // v9: bullish-trend post-lunch dead-zone (150-210m = 12:00-13:30 ET) extension of v6.
  // v8 residual: bull-trend lunch+early-afternoon uniformly bad:
  //   mins [105,150): blocked by v6
  //   mins [150,180): n=21 exp -0.429 dir 57% (2A/7B/1C/2D/9F)
  //   mins [180,210): n=19 exp -0.421 dir 63% (3A/1B/7C/1D/7F)
  //   mins [210+):    smaller N, similar bad pattern
  // Bull-trend lunch+post-lunch combined ([105, 210)) is now blocked.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 150 && ctx.minutesSinceOpen < 210) {
    return `bullish-trend post-lunch ${ctx.minutesSinceOpen}m (12:00-13:30 ET)`;
  }

  // v11: bearish-trend pre-lunch dead-zone (105-135m = 11:15-11:45 ET).
  // v10 residual: bear-trend × time pockets surfaced largest single bad slice:
  //   mins [105,135): n=40 exp -0.525 dir 48%  (10A/4B/2C/3D/21F)
  //   mins [120,150): n=35 exp -0.400          (overlaps, similar pattern)
  //   mins [180,210): n=16 exp -0.500          (smaller, separate pocket)
  //   mins [270,300): n=14 exp -1.071 dir 36%  (small N, very anti-predictive)
  // The 105-135m window targets the cleanest bear-trend bad block. Symmetric
  // to v6 (bull-trend at same window) but slightly earlier (105-135 vs 105-150).
  // Bear-trend at 12:00-13:30 ET is actually positive — different pattern from bull.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 105 && ctx.minutesSinceOpen < 135) {
    return `bearish-trend pre-lunch ${ctx.minutesSinceOpen}m (11:15-11:45 ET)`;
  }

  // v6: bullish-trend lunch dead-zone (105-150m = 11:15 ET-12:30 ET).
  // v5 residual direction×mode×time probe revealed asymmetric lunch pattern:
  //   bull-trend mins [105,150):    n=42 exp -0.714 dir 50%  (5A/4B/10C/2D/21F)
  //   bull-breakout mins [105,150): n=16 exp +0.063 dir 69%  — POSITIVE (keep!)
  //   bear-trend mins [105,150):    n=66 exp -0.273          (mid bad, smaller signal)
  // Mode-specific block — bull-breakout in this window is healthy. Bull-trend
  // alone has 50% F-rate during lunch hour, dir 50% (random).
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 105 && ctx.minutesSinceOpen < 150) {
    return `bullish-trend lunch ${ctx.minutesSinceOpen}m (11:15-12:30 ET)`;
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
