/**
 * Default ticker strategy — the current SPY-tuned logic.
 *
 * Confidence models are imported from analysis-agent.ts (the canonical source).
 * Mode detection and strength scoring are defined here (ported from signal-agent.ts).
 *
 * Per-symbol strategies override individual hooks; unspecified hooks use this.
 */

import type { TickerStrategy } from './strategy.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import type { ModeDetectionResult } from './strategy.js';
import {
  computeTrendConfidenceFn,
  computeRangeConfidenceFn,
  computeBreakoutConfidenceFn,
} from '../agents/analysis-agent.js';

/**
 * Default mode detection — ported from signal-agent.ts.
 * Detects range, breakout, or trend based on HTF ADX, swing levels, and OBV.
 */
function defaultDetectMode(
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

  // ── Range detection ──
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

  // ── Breakout detection ──
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

  // ── Default: trend ──
  return { signalMode: 'trend' };
}

function defaultComputeStrength(tfIndicators: TimeframeIndicators[]): number {
  const htfAdx = tfIndicators[2]?.dmi.adx ?? tfIndicators[1]?.dmi.adx ?? 0;
  return Math.min(100, Math.round(htfAdx * 2));
}

export const defaultStrategy: TickerStrategy = {
  computeTrendConfidence: computeTrendConfidenceFn,
  computeRangeConfidence: computeRangeConfidenceFn,
  computeBreakoutConfidence: computeBreakoutConfidenceFn,
  detectMode: defaultDetectMode,
  computeStrength: defaultComputeStrength,
  adjustConfidence: (cb) => cb,       // SPY: no adjustment needed
  shouldAllowEntry: () => true,       // SPY: no additional filtering
};
