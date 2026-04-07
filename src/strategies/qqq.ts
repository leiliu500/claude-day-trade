/**
 * QQQ-specific trading strategy.
 *
 * Shares SPY's 2-layer multiplicative confidence model but with QQQ-tuned
 * leading indicator veto thresholds.
 *
 * Key difference from SPY:
 *   - QQQ (100-stock composite) rarely shows LTF OBV divergence — the
 *     component stocks diverge independently, washing out the signal.
 *   - Instead, QQQ relies on velocity reversal as the primary veto signal.
 *     On April 6, LTF velocity hit -0.073 while OBV stayed bullish.
 *   - Boost and faster direction override both tested but rejected:
 *     QQQ's noisier LTF signals create too many false early entries.
 *     The veto alone is the value-add for QQQ.
 */

import { spyStrategy } from './spy.js';
import type { PartialTickerStrategy } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function dirSign(direction: string): number {
  return direction === 'bullish' ? 1 : direction === 'bearish' ? -1 : 0;
}

function buildQQQConfidence(signal: SignalPayload): ConfidenceBreakdown {
  // Start with SPY's confidence model (2-layer multiplicative + penalties)
  const cb = spyStrategy.computeTrendConfidence!(signal, {} as OptionEvaluation);
  let total = cb.total;

  const tfs = signal.timeframes;
  const ltf = tfs[0];
  if (!ltf) return cb;

  const direction = signal.direction;
  const ds = dirSign(direction);

  // ── QQQ VETO: velocity-based (OBV divergence unreliable for ETFs) ──────
  //
  // Strong opposing velocity = price momentum already reversed.
  // QQQ April 6: velocity hit -0.073 at 10:04 while bullish at 78% conf.
  // SPY's OBV divergence veto doesn't fire for QQQ (always 'none'),
  // so we use velocity as the primary veto instead.
  if (ltf.priceVelocity) {
    const velAligned = ds * ltf.priceVelocity.directionalVelocity;
    // Strong opposing velocity: the move has reversed
    if (velAligned < -0.035) {
      total = Math.max(0, total - 0.12);
    }
    // Moderate opposing velocity + OBV trend opposing = weaker but still meaningful
    else if (velAligned < -0.015) {
      const ltfOBVTrendOpposes =
        (direction === 'bullish' && ltf.obv.trend === 'bearish') ||
        (direction === 'bearish' && ltf.obv.trend === 'bullish');
      if (ltfOBVTrendOpposes) {
        total = Math.max(0, total - 0.08);
      }
    }
  }

  return { ...cb, total: clamp(total, 0, 1) };
}

export const qqqStrategy: PartialTickerStrategy = {
  ...spyStrategy,
  computeTrendConfidence: (signal: SignalPayload) => buildQQQConfidence(signal),
  computeRangeConfidence: (signal: SignalPayload) => buildQQQConfidence(signal),
  computeBreakoutConfidence: (signal: SignalPayload) => buildQQQConfidence(signal),
};
