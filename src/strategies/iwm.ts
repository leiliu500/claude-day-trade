/**
 * IWM-specific trading strategy.
 *
 * Built from scratch 2026-04-28 (NOT a SPY clone). IWM tracks the Russell 2000
 * small-cap index — fundamentally different microstructure from SPY's broad-500
 * basket:
 *   - 2000 small-cap constituents vs 500 large-caps; thinner per-name liquidity
 *   - Lower absolute price (~$215 vs SPY ~$560) means same atrPct% maps to
 *     smaller absolute moves — entry filters tuned in dollar terms drift
 *   - Higher beta to risk-on/risk-off macro flows; strong reaction to credit
 *     spreads, regional bank events, financial conditions
 *   - More volatile intraday than large-caps (typical IWM atrPct 0.15-0.30
 *     vs SPY 0.08-0.18)
 *   - Wider effective options spreads, especially in tail strikes
 *
 * Approach: start with no entry filters (only the structural regime score
 * computation), mine F-clusters from 15-mo IWM backtest data, then add filters
 * incrementally based on what IWM's data actually shows. SPY's filter set is
 * intentionally NOT cloned — prior IWM tuning session (2026-04-25 commits
 * c311395..cac3642) tried that approach and produced 4 reverts + 4 marginal
 * merges, leaving 15-mo at -0.197 — worse per-entry than building from data.
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

function iwmDetectMode(
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

// Filters added incrementally from 15-mo IWM F-cluster mining.
// Order matches backtest-configs/iwm.ts (single source of truth).
function iwmShouldAllowEntry(ctx: EntryContext): true | string {
  // v1: mid-afternoon dead-zone 14:30-15:15 ET (300-345m).
  // Bare-baseline mining: n=74 exp -0.661, direction 38% — three contiguous
  // 15-min buckets that are all losing (300m -0.750, 315m -0.211, 330m -0.871).
  // Largest single time-of-day F-cluster.
  if (ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 300 && ctx.minutesSinceOpen < 345) {
    return `mid-afternoon dead-zone ${ctx.minutesSinceOpen}m (14:30-15:15 ET)`;
  }

  // v2: midday-deep 12:30-13:30 ET (180-225m).
  // v1-residual mining: n=164 exp -0.421, four contiguous buckets all losing
  // (180m -0.558 dir 50%, 195m -0.122, 210m -0.545 dir 49%, 225m -0.447).
  // 195m is dilution-positive but contiguous block is cleaner than carve-out.
  if (ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 180 && ctx.minutesSinceOpen < 225) {
    return `midday-deep ${ctx.minutesSinceOpen}m (12:30-13:30 ET)`;
  }

  // v3: late-morning chop 11:15-11:30 ET (105-120m).
  // v2-residual mining: n=85 exp -0.365 dir 54%, isolated bad bucket between
  // positive 11:00 (+0.087 dir 68%) and milder 11:30 (-0.148).
  // (Tried entry-window 30→45 first — only 14 entries lost due to cascade,
  // 2025-08 regressed -0.364 single-month — REVERTED.)
  if (ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 105 && ctx.minutesSinceOpen < 120) {
    return `late-morning chop ${ctx.minutesSinceOpen}m (11:15-11:30 ET)`;
  }

  // v4: bullish-trend low-atr filter.
  // Probe of bullish-trend slice (n=376 exp -0.194 in v2-residual): atr-bucket
  // breakdown shows striking thinness:
  //   atr < 0.30:   n=42  exp -0.690 dir 57% (4A/5B/9C/6D/18F)
  //   atr 0.30-40:  n=99  exp -0.475 dir 53% (21A/10B/15C/7D/46F)
  //   atr 0.40+:    healthy (positive expectancy at 0.50-0.60 = +0.143)
  // Combined atr<0.40 → 141 entries exp -0.54, 25A+15B vs 64F, F-rate 45%.
  // IWM-specific: lower-atr bullish trend = thin tape extension (small-cap
  // breadth thinner than SPY's broad-500 basket).
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend' && ctx.atr < 0.40) {
    return `bullish-trend low atr ${ctx.atr.toFixed(2)} < 0.40`;
  }

  // v5: bearish-trend low-atr filter — symmetric mirror of v4.
  // Probe of bearish-trend slice (n=397 exp +0.065 in v4-residual): atr buckets:
  //   atr < 0.30:   n=50  exp -0.660 dir 50% (7A/7B/7C/4D/25F)
  //   atr 0.30-40:  n=98  exp -0.265 dir 58% (24A/14B/13C/6D/41F)
  //   atr 0.40+:    healthy (+0.155 to +0.582)
  // Combined atr<0.40 → 148 entries exp -0.40, 38AB+14AB vs 41F+25F.
  // Same thin-tape pathology as v4 — symmetric IWM small-cap pattern.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend' && ctx.atr < 0.40) {
    return `bearish-trend low atr ${ctx.atr.toFixed(2)} < 0.40`;
  }

  // v6: bullish-breakout low-atr.
  // Probe of bullish-breakout slice (n=153 exp -0.183 in v5-residual):
  //   atr < 0.30:   n=44  exp -0.614 dir 55% (3A/9B/10C/2D/20F)
  //   atr 0.30-40:  n=46  exp -0.239 dir 63% (9A/9B/7C/4D/17F)
  //   atr 0.40-50:  n=33  exp -0.455 dir 67% (small-N outlier, skipped)
  //   atr 0.50+:    healthy (+0.632 to +0.857)
  // Combined atr<0.40 → 90 entries exp -0.42, 12AB+18AB vs 20F+17F.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout' && ctx.atr < 0.40) {
    return `bullish-breakout low atr ${ctx.atr.toFixed(2)} < 0.40`;
  }

  // v7: bearish-breakout low-atr — symmetric mirror of v6.
  // Probe of bearish-breakout slice (n=136 exp -0.103 in v6-residual): worst
  // remaining slice. atr buckets:
  //   atr < 0.30:   n=44  exp -0.636 dir 48% (6A/8B/5C/2D/23F) — dir near random
  //   atr 0.30-40:  n=39  exp -0.231 dir 67% (11A/3B/4C/8D/13F)
  //   atr 0.40+:    healthy (+0.21 to +0.65)
  // Combined atr<0.40 → 83 entries exp -0.45, 17A+11B vs 36F. Same thin-tape
  // pathology as v6 — completes the symmetric direction × mode atr-floor set.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout' && ctx.atr < 0.40) {
    return `bearish-breakout low atr ${ctx.atr.toFixed(2)} < 0.40`;
  }
  return true;
}

function iwmAdjustConfidence(breakdown: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return breakdown;
}

export const iwmStrategy: PartialTickerStrategy = {
  detectMode: iwmDetectMode,
  shouldAllowEntry: iwmShouldAllowEntry,
  adjustConfidence: iwmAdjustConfidence,
};

export { _lastRegimeScore };
