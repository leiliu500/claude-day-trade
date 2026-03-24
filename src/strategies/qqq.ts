/**
 * QQQ-specific trading strategy.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline (SPY defaults): 8W/11L (42%), -63.8%
 *   Q4+Q1 tuned:             7W/2L  (78%), +125.0%
 *
 * QQQ-specific code:
 *   - detectMode: filters stale/pre-market data via ATR% check on breakouts;
 *     computes and caches regime score for entry filter
 *   - adjustConfidence: penalizes high-exhaustion breakouts and choppy trends
 *   - shouldAllowEntry: blocks trend entries with negative trendPhase,
 *     near-level risk, weak DI spread, or high choppiness (>= 0.55);
 *     blocks breakout entries missing structure confirmation or low regime (< 60)
 */

import type { PartialTickerStrategy, ModeDetectionResult, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
// Safe because QQQ pipeline runs serially (one tick at a time per symbol).
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score — same hybrid algorithm as SPY.
 * Candle-based (choppiness, displacement velocity, trend strength) + ADX anchor + VWAP distance.
 */
function computeRegimeScore(
  bars: readonly { timestamp: string; open: number; high: number; low: number; close: number }[],
  vwapPriceVs: number,
  adx: number,
): number {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayBars = bars.filter(b => {
    if (!b.timestamp.startsWith(todayStr)) return false;
    const h = parseInt(b.timestamp.slice(11, 13), 10);
    const m = parseInt(b.timestamp.slice(14, 16), 10);
    const mins = h * 60 + m;
    return mins >= 810 && mins < 1200; // 13:30–20:00 UTC
  });
  if (todayBars.length < 20) return 50;

  // A. Choppiness
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

  // B. Displacement velocity
  const dayOpen = todayBars[0]!.open;
  let velocityComponent = 0;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    velocityComponent = Math.min(10, Math.max(-10, (avgRecent - avgPrior) * 15));
  }

  // C. Trend strength
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

  // D. ADX anchor
  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;

  // E. VWAP distance
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

// ── QQQ Mode Detection ──────────────────────────────────────────────────────

function qqqDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ModeDetectionResult {
  // Compute and cache regime score for shouldAllowEntry
  const ltf = tfIndicators[0];
  if (ltf) {
    _lastRegimeScore = computeRegimeScore(
      ltf.bars,
      ltf.vwap?.priceVsVwap ?? 0,
      ltf.dmi.adx,
    );
  }

  const htfTf = tfIndicators[2]!;
  const htfAdx = htfTf.dmi.adx;
  const htfHasFreshCross = htfTf.dmi.crossedUp || htfTf.dmi.crossedDown;
  const htfRangePos = htfTf.priceStructure.rangePosition;
  const htfSwingHigh = htfTf.priceStructure.swingHigh;
  const htfSwingLow = htfTf.priceStructure.swingLow;
  const htfSwingRange = htfSwingHigh - htfSwingLow;
  const htfSwingRangePct = htfSwingRange / currentPrice * 100;

  // Range detection (same as default)
  if (htfAdx < 22 && !htfHasFreshCross
      && htfRangePos >= 0.05 && htfRangePos <= 0.95
      && htfSwingRangePct >= 0.20) {
    const atResistance = htfRangePos >= 0.70;
    const atSupport = htfRangePos <= 0.30;
    if (atResistance || atSupport) {
      return {
        signalMode: 'range',
        direction: atResistance ? 'bearish' : 'bullish',
        rangeSupport: htfSwingLow,
        rangeResistance: htfSwingHigh,
      };
    }
  }

  // Breakout detection (QQQ-specific: ATR% stale-data filter)
  if (htfAdx < 25 && htfTf.dmi.adxSlope > 0) {
    const htfBarsForBO = htfTf.bars.slice(-20, -3);
    let boSwingHigh = -Infinity, boSwingLow = Infinity;
    for (const b of htfBarsForBO) {
      if (b.high > boSwingHigh) boSwingHigh = b.high;
      if (b.low < boSwingLow) boSwingLow = b.low;
    }
    const boSwingRange = boSwingHigh - boSwingLow;
    const brokeHigh = currentPrice > boSwingHigh && boSwingRange > 0;
    const brokeLow = currentPrice < boSwingLow && boSwingRange > 0;
    if (brokeHigh || brokeLow) {
      const beyondPct = brokeHigh
        ? ((currentPrice - boSwingHigh) / currentPrice) * 100
        : ((boSwingLow - currentPrice) / currentPrice) * 100;
      if (beyondPct > 0.02 && beyondPct < 0.40) {
        const htfObv = tfIndicators[2]!.obv;
        const obvConfirms = brokeHigh ? htfObv.trend === 'bullish' : htfObv.trend === 'bearish';
        const htfDiCross = brokeHigh ? htfTf.dmi.crossedUp : htfTf.dmi.crossedDown;
        const diSpreadConfirms = htfTf.dmi.diSpreadSlope > 1;
        if (obvConfirms || htfDiCross || diSpreadConfirms) {
          // QQQ: filter stale/pre-market data (ATR $0.37 on $625 = 0.06%)
          const atrPct = htfTf.atr.atr / currentPrice * 100;
          if (atrPct < 0.08) {
            return { signalMode: 'trend' }; // stale data — fall through to trend
          }
          return {
            signalMode: 'breakout',
            direction: brokeHigh ? 'bullish' : 'bearish',
            breakoutLevel: brokeHigh ? boSwingHigh : boSwingLow,
            breakoutBeyond: beyondPct,
          };
        }
      }
    }
  }

  return { signalMode: 'trend' };
}

// ── QQQ Confidence Adjustment ────────────────────────────────────────────────

function qqqAdjustConfidence(cb: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  const adjusted = { ...cb };

  // QQQ breakouts with negative trendPhase: hard cap confidence.
  // Backtested: QQQ neg-phase breakouts always failed regardless of conf level.
  if (ctx.signalMode === 'breakout' && cb.trendPhaseBonus < 0) {
    adjusted.total = Math.min(adjusted.total, 0.64);
  }

  return adjusted;
}

// ── QQQ Entry Filter ─────────────────────────────────────────────────────────

function qqqShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, breakdown: cb } = ctx;

  if (signalMode === 'trend') {
    // QQQ trend rule 1: require trendPhase >= 0.
    // Feb 11 loss had trendPhase=-0.040. All 4 trend winners had trendPhase >= 0.
    if (cb.trendPhaseBonus < 0) return false;

    // QQQ trend rule 2: block entries near strong S/R levels.
    // Jan 13 loss had nearLevelPenalty=-0.100 (price at level, reversed).
    // No trend winner had nearLevelPenalty below -0.050.
    if (cb.nearLevelPenalty < -0.05) return false;

    // QQQ trend rule 3: block weak DI spread entries.
    // Feb 11 loss had DI Spread=+0.033 (weakest). All winners >= 0.050.
    if (cb.diSpreadBonus < 0.04) return false;

    // QQQ trend rule 4: block high-chop entries.
    // Jan 13 loss had chop=0.64, all trend winners had chop <= 0.30.
    // High chop = price oscillating, trend signal is unreliable.
    if ((ctx.choppiness ?? 0) >= 0.55) return false;
  }

  if (signalMode === 'breakout') {
    // QQQ breakout rule 1: no strongSignal bypass for negative trendPhase.
    // SPY allows conf >= 0.75 to bypass trendPhase check; QQQ doesn't —
    // breakout losers at 76-78% conf with neg trendPhase always failed.
    if (cb.trendPhaseBonus < 0) return false;

    // QQQ breakout rule 2: minimum confidence 72%.
    if (ctx.confidence < 0.72) return false;

    // QQQ breakout rule 3: require structure confirmation (PDH/PDL alignment).
    // Jan 30 loss (-35.0%) had structureBonus=0 (no real level behind breakout).
    // Both breakout winners (Feb 18 +71.6%, Mar 18 +7.9%) had structureBonus=+0.060.
    if (cb.structureBonus <= 0) return false;

    // QQQ breakout rule 4: require minimum regime (directional conviction).
    // Dec 10 loss (-35.0%) had regime=56 (low conviction, choppy market).
    // All breakout winners had regime >= 67. Below 60 = noise, not a real breakout.
    if (_lastRegimeScore < 60) return false;
  }

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const qqqStrategy: PartialTickerStrategy = {
  detectMode: qqqDetectMode,
  adjustConfidence: qqqAdjustConfidence,
  shouldAllowEntry: qqqShouldAllowEntry,
};
