/**
 * SPY range-rebound detector.
 *
 * Narrow confidence lift for SPY range-mode calls that are close to the
 * range-bypass threshold. The broad range pool is negative, so these branches
 * stay deliberately small:
 *
 * 1. Late support shelf: VWAP-confirmed bullish rebound near 14:30-15:00 ET.
 *    Apr 29 2026 14:45 is the canonical missed entry.
 * 2. Morning compression rebound: bullish range call 45-120 minutes after open,
 *    positive range position, mild/absent near-level penalty, no immediate
 *    recent-price-action chase, and visible consolidation.
 *
 * The +0.15 lift moves these 0.55-0.65 range signals to >=0.70 so the existing
 * range bypass can fire. It intentionally does not add a new gate bypass.
 */

import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { SignalDirection } from '../types/signal.js';

export const SPY_RANGE_REBOUND_BONUS = 0.15;

export interface SpyRangeReboundInput {
  signalMode: string;
  direction: SignalDirection;
  minutesSinceOpen?: number;
  breakdown: ConfidenceBreakdown;
}

export function isSpyRangeRebound(input: SpyRangeReboundInput): boolean {
  if (input.signalMode !== 'range') return false;
  if (input.direction !== 'bullish') return false;

  const mins = input.minutesSinceOpen;
  if (mins === undefined) return false;

  const b = input.breakdown;
  if (b.total < 0.55 || b.total >= 0.65) return false;

  const lateSupportShelf = mins >= 300 && mins < 330
    && b.vwapBonus >= 0.08
    && b.pricePositionAdjustment >= 0.05
    && b.nearLevelPenalty >= 0.08;

  const morningCompressionRebound = mins >= 45 && mins < 120
    && b.pricePositionAdjustment >= 0.06
    && b.nearLevelPenalty <= 0.05
    && b.recentPriceActionBonus <= 0
    && b.consolidationPenalty >= 0.02
    && b.orbBonus <= 0
    && b.candlePatternBonus <= 0;

  return lateSupportShelf || morningCompressionRebound;
}
