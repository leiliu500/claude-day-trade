/**
 * SPY morning microtrend detector — narrow carve-out for SPY trend signals
 * during the 10:00-11:15 ET window where order-flow + options confirmation are
 * strong enough that 2-stage waiting gives back most of the move.
 *
 * Target use case: SPY morning PARITY GAPs where backtest fires at 0.65 conf
 * but live's running confidence is in the [0.55, 0.65) band at the same minute
 * (Apr 29 2026 10:11 + 10:58 are the canonical examples — both grade B/C with
 * 0.22% MFE each that the deployed system missed because live conf peaked at
 * 0.55 vs backtest's 0.65). The bonus pushes live's 0.55 → 0.65 to cross the
 * gate; the bypass skips stage-2 wait so the entry catches the move; and the
 * filter carve-outs (v1/v3/v5 in spy.ts) keep this narrow pattern from being
 * blocked by SPY's existing low-atr / mid-atr filters which were calibrated
 * for the broader trend pool, not this specific morning microtrend slice.
 *
 * Design note: this detector applies THREE actions on the same signal —
 *   1. +0.10 confidence bonus (in adjustConfidence)
 *   2. Bypass of v1/v3/v5 filters (in shouldAllowEntry)
 *   3. Stage-2 bypass (via flowMicrotrendBypass in entry-gate)
 * Each layer compounds; the detector's 11-factor floor is what makes the
 * compound action safe. If thresholds are loosened, evaluate whether all
 * three actions are still warranted or just the bonus.
 *
 * Validation status (as of 2026-04-30): INCONCLUSIVE on 16mo SPY harness
 * (Δexp +0.002, CI [-0.170, +0.176]). Detector fires only on Apr 29 in the
 * full 16mo window (+2 entries: 10:11 BULLISH C + 10:58 BEARISH B). Live
 * impact cannot be measured by the backtest harness because the bonus only
 * matters for ticks where backtest is in [0.55, 0.65) — exactly the slice
 * backtest filters out. Needs live-replay verifier or paper deployment for
 * real evaluation. Per memory's cherry-picked-window rule, the Apr-2026-only
 * signal is a risk factor — factor thresholds may be over-fit to those 2
 * entries.
 *
 * Factor threshold provenance: hand-tuned from the Apr 29 2026 PARITY GAP
 * factor profiles (10:11 bullish + 10:58 bearish). Common gates target
 * order-flow + options confirmation (oiVolumeBonus, consolidationPenalty,
 * thetaDecayPenalty); per-direction gates capture the asymmetric bullish
 * vs bearish factor signatures. Future tuning should be backed by miner
 * output across the full ConfidenceBreakdown pool, not single-day examples.
 */

import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { SignalDirection } from '../types/signal.js';

export const SPY_MORNING_MICROTREND_BONUS = 0.10;

export interface SpyMicrotrendInput {
  ticker?: string;
  signalMode: string;
  direction: SignalDirection;
  minutesSinceOpen?: number;
  breakdown: ConfidenceBreakdown;
}

export function isSpyMorningMicrotrend(input: SpyMicrotrendInput): boolean {
  if (input.ticker !== undefined && input.ticker !== 'SPY') return false;
  if (input.signalMode !== 'trend') return false;
  const mins = input.minutesSinceOpen;
  if (mins === undefined || mins < 30 || mins >= 105) return false;

  const b = input.breakdown;
  const common =
    b.oiVolumeBonus >= 0.05
    && b.consolidationPenalty >= -0.04
    && b.thetaDecayPenalty >= -0.03;

  if (!common) return false;

  if (input.direction === 'bullish') {
    return b.orderFlowBonus >= 0.12
      && b.recentPriceActionBonus >= 0.06
      && b.vwapBonus >= 0.04
      && b.nearLevelPenalty >= -0.06
      && b.orbBonus >= 0
      && b.momentumAccelBonus >= -0.03;
  }

  if (input.direction === 'bearish') {
    return b.orderFlowBonus >= 0.15
      && b.vwapBonus >= 0.04
      && b.structureBonus >= 0.02
      && b.trendPhaseBonus >= 0.02
      && b.candlePatternBonus >= 0.04
      && b.nearLevelPenalty >= -0.01;
  }

  return false;
}
