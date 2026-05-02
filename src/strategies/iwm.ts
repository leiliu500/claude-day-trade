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

  // v6+v8: bullish-breakout low-atr (extended <0.40 → <0.45 in v8).
  // v6 probe of bullish-breakout slice (n=153 exp -0.183 in v5-residual):
  //   atr < 0.30:   n=44  exp -0.614 dir 55% (3A/9B/10C/2D/20F)
  //   atr 0.30-40:  n=46  exp -0.239 dir 63% (9A/9B/7C/4D/17F)
  //   atr 0.40+:    healthy
  // v8 probe (post-v7 cache) revealed a 2nd bad pocket just above the v6 boundary:
  //   atr 0.40-0.42: n=5  exp -0.40 (1A/0B/2C/0D/2F)
  //   atr 0.42-0.45: n=10 exp -1.20 dir 40% (0A/1B/2C/1D/6F) — terrible
  //   atr 0.45+:    +0.04 to +0.95 (clean)
  // Combined 0.40-0.45 → 15 entries exp -0.93, 1A+1B vs 8F. mine-rejected-goods
  // confirmed v6 boundary was not blocking AB-rich entries at the upper edge.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout' && ctx.atr < 0.45) {
    return `bullish-breakout low atr ${ctx.atr.toFixed(2)} < 0.45`;
  }

  // v10: bearish + candlePatternBonus [0.06, 0.07) — narrow perverse band.
  // Direction-split factor analysis on v9 cache surfaced bearish candlePatternBonus
  // as the only factor with Δmean(F-AB) above SPY's +0.007 viable threshold:
  // bearish d=-0.39 Δmean +0.0087 range 0.140 (perverse-signed). Fine-resolution
  // probe revealed a narrow bad bucket:
  //   cpb 0.04-0.045 bearish: n=28 exp +0.50  (clean)
  //   cpb 0.05-0.055 bearish: n=3  exp +0.67
  //   cpb 0.06-0.065 bearish: n=33 exp -0.697 (5A/4B/3C/5D/16F) — 48% F
  //   cpb 0.08+ bearish:      n=12 exp +0.25  (clean)
  // The 0.06-0.07 band is uniquely perverse — surrounded by positive cpb cells.
  // Distribution well-spread (13 months affected, worst single-month -1.80 N=5).
  if (ctx.direction === 'bearish'
      && ctx.breakdown.candlePatternBonus >= 0.06
      && ctx.breakdown.candlePatternBonus < 0.07) {
    return `bearish cpb ${ctx.breakdown.candlePatternBonus.toFixed(3)} in [0.06, 0.07)`;
  }

  // v9: bullish-trend in first 30-45m bucket — direction-asymmetric open window.
  // Compound probe (v7 cache, confirmed on v8): bullish 30-45m n=49 exp -0.408 vs
  // bearish 30-45m strongly positive — direction-asymmetric. Within bullish, the
  // trend-mode slice is the killer: n=41 exp -0.488 dir 56% (12A/1B/5C/1D/22F).
  // atr-bucket carve-out: 0.60-0.80 is the only AB-positive sub-band (n=7 exp
  // +0.143, 3A/1B/0C/0D/3F) — keep it.
  // Filter blocks ~34 entries (~9A/0B/5C/1D/19F) → projected Δexp ~+0.025.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 30 && ctx.minutesSinceOpen < 45
      && !(ctx.atr >= 0.60 && ctx.atr < 0.80)) {
    return `bullish-trend open-30m atr ${ctx.atr.toFixed(2)}`;
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

  // v14: bearish-trend strength>=80 atr [0.55, 0.85) — high-strength mid-atr block.
  // Strength × atr cross-tab on v13 baseline surfaced a sharp pocket:
  //   bearish-trend strength [80, 100) atr [0.55, 0.70): n=24 exp -0.500 (10F+7AB)
  //   bearish-trend strength [80, 100) atr [0.70, 0.85): n= 7 exp -1.429 (4F+0AB)
  //   bearish-trend strength [70, 80) atr [0.55, 0.70): n=16 exp -0.312 (8F+6A) [skip-mixed]
  // Combined strength>=80 atr [0.55, 0.85) → 36 entries (4A+4B vs 17F, mid-mix C/D).
  // Predicted Δexp +0.032. By-month: 9 months affected, worst 2025-01 -0.122 (cap
  // -0.15), 2025-03 -0.017, 2025-09 -0.005. Big winners 2025-07 +0.743 (saves 5F),
  // 2026-02 +0.136 (3F removed from a +0.745 month).
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.strengthScore >= 80 && ctx.atr >= 0.55 && ctx.atr < 0.85) {
    return `bearish-trend strength ${ctx.strengthScore} atr ${ctx.atr.toFixed(2)} in [0.55, 0.85)`;
  }

  // v13: bearish-breakout time-of-day F-pockets — 10:15-10:30 + 12:15-12:30 ET.
  // v12-residual time-of-day mining surfaced two bearish-breakout dead zones:
  //
  //   bearish-breakout 45-60m (10:15-10:30 ET) by atr (n=11 exp -1.000):
  //     atr [0.40, 0.50): n=4 exp -1.000 (3F+1A)         — block
  //     atr [0.50, 0.60): n=5 exp -1.400 (3F+0AB)        — block
  //     atr [0.60, 0.75): n=2 exp 0      (clean)         — preserve
  //
  //   bearish-breakout 165-180m (12:15-12:30 ET) (n=7 exp -1.143):
  //     n=7 5F vs 1A (no atr discrimination needed)      — block all
  //
  // Combined block: 9 (10:15-10:30 atr<0.60, 6F+1A) + 7 (12:15-12:30, 5F+1A) =
  // 16 entries, 11F+2A+0B+2C+1D, dir 0.31. Predicted Δexp +0.023.
  // 6 months affected, max 6/16 in 2026-03 (no single-day cluster).
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout'
      && ctx.minutesSinceOpen !== undefined) {
    if (ctx.minutesSinceOpen >= 45 && ctx.minutesSinceOpen < 60 && ctx.atr < 0.60) {
      return `bearish-breakout 10:15-10:30 atr ${ctx.atr.toFixed(2)} < 0.60`;
    }
    if (ctx.minutesSinceOpen >= 165 && ctx.minutesSinceOpen < 180) {
      return `bearish-breakout 12:15-12:30 ${ctx.minutesSinceOpen}m`;
    }
  }

  // v12: trend-mode 225-240m (13:15-13:30 ET) direction-asymmetric atr carve-outs.
  // v11-residual time-of-day mining surfaced 13:15-13:30 ET as a load-bearing
  // F-cluster window across both directions. Direction-asymmetric atr split:
  //
  //   bearish-trend 225-240m by atr (n=17 exp -0.471):
  //     atr [0.40, 0.50): n=8 exp -1.750 (7F)        — block
  //     atr [0.50, 0.60): n=3 exp -1.333 (2F)        — block
  //     atr [0.60, 0.75): n=5 exp +1.600 (4A)        — preserve
  //     atr [0.75, 1.00): n=1 exp +2.000 (1A)        — preserve
  //
  //   bullish-trend 225-240m by atr (n=14 exp -0.643):
  //     atr [0.40, 0.50): n=6 exp -1.167 (mixed C/D) — keep (predΔ -0.008)
  //     atr [0.75, 1.00): n=4 exp -2.000 (ALL F)     — block
  //     atr [1.00, 1.50): n=2 exp +2.000 (2A)        — preserve
  //
  // Combined block: 11 bearish (9F+2C, dir 0.18) + 4 bullish (4F) = 15 entries
  // exp ~-1.7, ZERO AB. Predicted Δexp +0.030.
  if (ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 225 && ctx.minutesSinceOpen < 240) {
    if (ctx.direction === 'bearish' && ctx.atr < 0.60) {
      return `bearish-trend 13:15-13:30 atr ${ctx.atr.toFixed(2)} < 0.60`;
    }
    if (ctx.direction === 'bullish' && ctx.atr >= 0.75 && ctx.atr < 1.00) {
      return `bullish-trend 13:15-13:30 atr ${ctx.atr.toFixed(2)} in [0.75, 1.00)`;
    }
  }

  // v11: bearish-trend anti-predictive confidence [0.82, 0.86).
  // 16-mo bearish-trend confidence breakdown surfaced this band as the worst
  // sub-slice across all confidence levels:
  //   conf [0.78, 0.80): n=16 exp +0.250 dir 64%   (clean)
  //   conf [0.80, 0.82): n=19 exp -0.053 dir ~     (mild)
  //   conf [0.82, 0.84): n=16 exp -1.062 dir 31%   (anti-predictive!)
  //   conf [0.84, 0.86): n=17 exp -0.706 dir 53%
  //   conf [0.86, 0.88): n=22 exp -0.045 dir ~     (mild)
  //   conf [0.88, 0.92): mixed back to neutral
  // Combined [0.82, 0.86) → 33 entries exp -0.879, 5A+3B vs 19F (dir 42%
  // sub-random). 2026-02 single-month risk: only 3 entries in band (1A+2F),
  // net +1 grade-pt to that month. Predicted Δexp +0.034.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.confidence >= 0.82 && ctx.confidence < 0.86) {
    return `bearish-trend conf ${ctx.confidence.toFixed(2)} in [0.82, 0.86)`;
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
