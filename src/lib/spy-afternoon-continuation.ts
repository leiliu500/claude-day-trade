/**
 * SPY afternoon flow-continuation detector.
 *
 * Narrow carve-out for the SPY bullish low-ATR guards when a mature afternoon
 * trend is still being confirmed by order flow and clean trend structure. The
 * broad low-ATR filter remains correct for SPY overall; this releases only the
 * high-conviction 13:50-14:10 ET continuation shape seen on Apr 30, 2026.
 */

import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { SignalDirection } from '../types/signal.js';

export interface SpyAfternoonContinuationInput {
  ticker?: string;
  signalMode: string;
  direction: SignalDirection;
  confidence: number;
  atr: number;
  minutesSinceOpen?: number;
  displacementVelocity?: number;
  atrRatio?: number;
  breakdown: ConfidenceBreakdown;
}

export function isSpyAfternoonFlowContinuation(input: SpyAfternoonContinuationInput): boolean {
  if (input.ticker !== undefined && input.ticker !== 'SPY') return false;
  if (input.signalMode !== 'trend' || input.direction !== 'bullish') return false;

  const mins = input.minutesSinceOpen;
  if (mins === undefined || mins < 260 || mins >= 280) return false;
  if (input.atr < 0.49 || input.atr >= 0.60 || input.confidence < 0.90) return false;
  if (input.displacementVelocity === undefined || input.displacementVelocity > 0.025) return false;
  if (input.displacementVelocity < -0.03) return false;
  if (input.atrRatio === undefined || input.atrRatio > 1.0) return false;

  const b = input.breakdown;
  const common = b.orderFlowBonus >= 0.10
    && b.trendPersistenceBonus >= 0.06
    && b.trendPhaseBonus >= 0.04
    && b.recentPriceActionBonus >= 0.04
    && b.diSpreadBonus >= 0.08
    && b.alignmentBonus >= 0.06
    && b.adxBonus >= 0.05
    && b.macdBonus >= 0.03
    && b.candlePatternBonus <= 0.04
    && b.volumeSurgeBonus <= 0
    && b.nearLevelPenalty >= -0.01
    && b.moveExhaustionPenalty >= -0.03;
  if (!common) return false;

  const initialFlowPulse = b.candlePatternBonus >= 0.035
    && b.candlePatternBonus <= 0.045
    && b.priceVelocityBonus >= 0.02
    && b.orderFlowBonus <= 0.115;
  const flowReacceleration = b.candlePatternBonus <= 0
    && b.priceVelocityBonus <= 0
    && b.orderFlowBonus >= 0.20;

  return initialFlowPulse || flowReacceleration;
}
