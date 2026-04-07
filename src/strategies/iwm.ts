/**
 * IWM-specific trading strategy.
 *
 * Shares SPY's 2-layer multiplicative confidence model but with IWM-tuned
 * leading indicator thresholds.
 *
 * Key difference from SPY:
 *   - IWM (2000-stock small-cap ETF) has no usable OBV divergence at
 *     turning points — it's always 'none' at high-confidence entries.
 *   - Velocity also doesn't go negative until AFTER confidence drops below
 *     threshold — unlike SPY/QQQ where velocity leads by 3-5 min.
 *   - VETO: uses velocity like QQQ but with higher threshold (-0.05)
 *     since IWM velocity is noisier. Also adds OBV trend + LTF DMI combo.
 *   - BOOST: LTF convergence boost works for IWM since it catches
 *     turning-point entries earlier (April 6 13:01 bearish A-grade).
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

function buildIWMConfidence(signal: SignalPayload): ConfidenceBreakdown {
  const cb = spyStrategy.computeTrendConfidence!(signal, {} as OptionEvaluation);
  let total = cb.total;

  const tfs = signal.timeframes;
  const ltf = tfs[0];
  const htf = tfs[tfs.length - 1];
  if (!ltf || !htf) return cb;

  const direction = signal.direction;
  const ds = dirSign(direction);

  // ── A. IWM VETO: velocity + OBV trend combo ───────────────────────────
  // IWM's velocity is noisier than SPY/QQQ — need higher threshold.
  // Strong opposing velocity alone: -0.05 threshold (vs QQQ's -0.035)
  if (ltf.priceVelocity) {
    const velAligned = ds * ltf.priceVelocity.directionalVelocity;
    if (velAligned < -0.05) {
      total = Math.max(0, total - 0.10);
    }
    // Moderate velocity + OBV trend opposing = move reversing
    else if (velAligned < -0.025) {
      const ltfOBVTrendOpposes =
        (direction === 'bullish' && ltf.obv.trend === 'bearish') ||
        (direction === 'bearish' && ltf.obv.trend === 'bullish');
      if (ltfOBVTrendOpposes) {
        total = Math.max(0, total - 0.08);
      }
    }
  }

  // OBV divergence veto (inherited from SPY base, but recheck with IWM threshold)
  // IWM does show divergence sometimes — when it fires it's meaningful
  const ltfOBVDivOpposes =
    (direction === 'bullish' && ltf.obv.divergence === 'bearish') ||
    (direction === 'bearish' && ltf.obv.divergence === 'bullish');
  if (ltfOBVDivOpposes) {
    total = Math.max(0, total - 0.10);
  }

  // ── B. Leading indicator convergence BOOST ─────────────────────────────
  // Same as SPY but with slightly smaller boost (IWM LTF signals noisier)
  {
    const ltfDMIConfirms =
      (direction === 'bullish' && ltf.dmi.trend === 'bullish') ||
      (direction === 'bearish' && ltf.dmi.trend === 'bearish');
    const ltfOBVConfirms =
      (direction === 'bullish' && ltf.obv.trend === 'bullish') ||
      (direction === 'bearish' && ltf.obv.trend === 'bearish');
    const ltfVelConfirms = ltf.priceVelocity
      ? ((direction === 'bullish' && ltf.priceVelocity.directionalVelocity > 0.015) ||
         (direction === 'bearish' && ltf.priceVelocity.directionalVelocity < -0.015))
      : false;

    const leadingConvergence = ltfDMIConfirms && ltfOBVConfirms && ltfVelConfirms;
    const htfLags = htf.dmi.trend !== direction;
    const isEarlyMove = signal.leadingSignalOverride || signal.reversalOverride;

    if (leadingConvergence && htfLags) {
      total = Math.min(1, total + 0.08);
    } else if (leadingConvergence && isEarlyMove) {
      total = Math.min(1, total + 0.04);
    }
  }

  return { ...cb, total: clamp(total, 0, 1) };
}

export const iwmStrategy: PartialTickerStrategy = {
  ...spyStrategy,
  computeTrendConfidence: (signal: SignalPayload) => buildIWMConfidence(signal),
  computeRangeConfidence: (signal: SignalPayload) => buildIWMConfidence(signal),
  computeBreakoutConfidence: (signal: SignalPayload) => buildIWMConfidence(signal),
};
