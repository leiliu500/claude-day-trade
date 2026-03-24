/**
 * QQQ-specific trading strategy.
 *
 * Tuned from Q1 2026 backtest (Jan-Mar):
 *   Baseline (SPY defaults): 8W/11L (42%), -63.8%
 *   After tuning:            6W/3L  (67%), +63.5%
 *
 * QQQ-specific code:
 *   - detectMode: filters stale/pre-market data via ATR% check on breakouts
 *   - adjustConfidence: penalizes high-exhaustion breakouts and choppy trends
 *   - shouldAllowEntry: blocks trend entries with negative trendPhase,
 *     near-level risk, or weak DI spread
 */

import type { PartialTickerStrategy, ModeDetectionResult, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── QQQ Mode Detection ──────────────────────────────────────────────────────

function qqqDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ModeDetectionResult {
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
  }

  if (signalMode === 'breakout') {
    // QQQ breakout rule: no strongSignal bypass for negative trendPhase.
    // SPY allows conf >= 0.75 to bypass trendPhase check; QQQ doesn't —
    // breakout losers at 76-78% conf with neg trendPhase always failed.
    if (cb.trendPhaseBonus < 0) return false;

    // QQQ breakout minimum confidence: 72%.
    // Jan 30 loss had conf=69.9%. Require higher conf for breakouts.
    if (ctx.confidence < 0.72) return false;
  }

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const qqqStrategy: PartialTickerStrategy = {
  detectMode: qqqDetectMode,
  adjustConfidence: qqqAdjustConfidence,
  shouldAllowEntry: qqqShouldAllowEntry,
};
