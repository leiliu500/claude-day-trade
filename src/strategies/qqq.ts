/**
 * QQQ-specific trading strategy.
 *
 * Uses the same 2-layer multiplicative confidence model as SPY:
 *   Layer 1: Direction Strength (DI spread, OBV trend, TF alignment)
 *   Layer 2: Entry Quality (DI slope, VWAP extension, OBV divergence, ADX, TD)
 *   Confidence = sqrt(direction_strength × entry_quality)
 *
 * Also shares: direction override (VWAP + DI slope + OBV + velocity + LTF flip),
 * stale data guard, and directEntry mode.
 */

import { spyStrategy } from './spy.js';
import type { PartialTickerStrategy } from './strategy.js';

export const qqqStrategy: PartialTickerStrategy = { ...spyStrategy };
