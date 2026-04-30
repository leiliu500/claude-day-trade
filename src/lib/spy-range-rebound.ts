/**
 * SPY late range-rebound detector.
 *
 * Narrow confidence lift for SPY range-mode calls near the late-session support
 * shelf. The broad 14:30-15:00 bullish range pool is negative, but the
 * VWAP-confirmed subset (range support + positive range position + vwapBonus
 * at the model's +0.08 tier) showed 3 historical near-threshold rejects in the
 * 2025-01-02..2026-04-29 cache: 1A/1B/1C and 0F. Apr 29 2026 14:45 is the
 * canonical missed entry.
 *
 * The +0.15 lift moves these 0.55-0.65 range signals to >=0.70 so the existing
 * range bypass can fire. It intentionally does not add a new gate bypass.
 */

import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { SignalDirection } from '../types/signal.js';

export const SPY_LATE_RANGE_REBOUND_BONUS = 0.15;

export interface SpyLateRangeReboundInput {
  signalMode: string;
  direction: SignalDirection;
  minutesSinceOpen?: number;
  breakdown: ConfidenceBreakdown;
}

export function isSpyLateRangeRebound(input: SpyLateRangeReboundInput): boolean {
  if (input.signalMode !== 'range') return false;
  if (input.direction !== 'bullish') return false;

  const mins = input.minutesSinceOpen;
  if (mins === undefined || mins < 300 || mins >= 330) return false;

  const b = input.breakdown;
  if (b.total < 0.55 || b.total >= 0.65) return false;

  return b.vwapBonus >= 0.08
    && b.pricePositionAdjustment >= 0.05
    && b.nearLevelPenalty >= 0.08;
}
