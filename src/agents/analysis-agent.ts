import OpenAI from 'openai';
import { config } from '../config.js';
import { loadSkillTemplate } from '../utils/skill-loader.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult, ConfidenceBreakdown } from '../types/analysis.js';
import { getRecentSignals } from '../db/repositories/signals.js';
import { computeEntryMetrics } from '../lib/entry-context.js';
import { applySoftGates } from '../lib/soft-gates.js';
import { computeConvergence, convergenceAdjustment } from '../lib/signal-convergence.js';
import { getCrossTickerBus } from '../lib/cross-ticker.js';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

/**
 * Compute deterministic confidence score from signal data.
 * Range: 0.00 – 1.00
 */
// ── Exported for per-symbol strategy overrides ────────────────────────────────
// These wrap the private functions so strategies/default.ts can reference them.
// Per-symbol strategies (e.g. strategies/qqq.ts) do NOT import these — they
// provide their own implementations.

/** Trend confidence model — SPY-tuned default.
 *  Calls computeConfidence which routes by signalMode; for trend signals
 *  (the default), it falls through to the trend-specific logic. */
export const computeTrendConfidenceFn = (signal: SignalPayload, option: OptionEvaluation): ConfidenceBreakdown => {
  return computeConfidence(signal, option);
};
/** Range confidence model — SPY-tuned default */
export const computeRangeConfidenceFn = (signal: SignalPayload): ConfidenceBreakdown => {
  return computeRangeConfidence(signal);
};
/** Breakout confidence model — SPY-tuned default */
export const computeBreakoutConfidenceFn = (signal: SignalPayload): ConfidenceBreakdown => {
  return computeBreakoutConfidence(signal);
};

/**
 * Internal confidence router — dispatches to mode-specific model.
 * Used internally by AnalysisAgent.run() for backward compat.
 * Strategies bypass this and call mode-specific functions directly.
 */
function computeConfidence(signal: SignalPayload, option: OptionEvaluation): ConfidenceBreakdown {
  if (signal.signalMode === 'range') {
    return computeRangeConfidence(signal);
  }
  if (signal.signalMode === 'breakout') {
    return computeBreakoutConfidence(signal);
  }
  if (signal.signalMode === 'vwap_reversion') {
    // VWAP reversion uses the range confidence model as a base
    // (both are mean-reversion setups, same factor structure)
    return computeRangeConfidence(signal);
  }

  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) {
    return { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, candlePatternBonus: 0, priceVelocityBonus: 0, volumeSurgeBonus: 0, trendPersistenceBonus: 0, total: 0.38 };
  }

  // Base: direction-neutral starting point
  const base = 0.38;

  // DI spread bonus — signed spread aligned with signal direction, scaled -0.15..+0.15
  // Positive = DI dominance confirms signal direction (bonus)
  // Negative = DI dominance opposes signal direction (penalty)
  const avgDISpread = signal.direction === 'neutral'
    ? 0
    : tfs.reduce((sum, tf) => {
        const spread = signal.direction === 'bullish'
          ? tf.dmi.plusDI - tf.dmi.minusDI
          : tf.dmi.minusDI - tf.dmi.plusDI;
        return sum + spread;
      }, 0) / tfs.length;
  let diSpreadBonus = Math.max(-0.15, Math.min(0.15, (avgDISpread / 40) * 0.15));

  // ADX bonus: HTF ADX > 25
  // Full bonus at ADX > 25; partial bonus at ADX 20-25 with rapidly rising slope —
  // catches early-trend entries where ADX hasn't peaked yet but momentum is building.
  const adxBonus = htf.dmi.adx > 25 ? 0.05 : (htf.dmi.adx > 20 && htf.dmi.adxSlope > 2 ? 0.03 : 0);

  // DI cross bonus — fresh DI crossover on the most recent bar is a strong timing signal.
  // HTF aligned cross: +0.05 | MTF aligned cross: +0.03 | HTF growth cross: +0.04 extra (cap +0.10)
  // HTF adverse cross: -0.05 | MTF adverse cross: -0.03  (cap -0.06 combined)
  // Adverse cross means momentum just flipped opposite to signal direction.
  let diCrossBonus = 0;
  if (signal.direction !== 'neutral') {
    const htfAligned = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
    const htfAdverse = signal.direction === 'bullish' ? htf.dmi.crossedDown : htf.dmi.crossedUp;
    const mtfAligned = signal.direction === 'bullish' ? mtf.dmi.crossedUp : mtf.dmi.crossedDown;
    const mtfAdverse = signal.direction === 'bullish' ? mtf.dmi.crossedDown : mtf.dmi.crossedUp;
    if (htfAligned) diCrossBonus += 0.05;
    if (mtfAligned) diCrossBonus += 0.03;
    if (htfAdverse) diCrossBonus -= 0.05;
    if (mtfAdverse) diCrossBonus -= 0.03;
    // Growth cross (DI cross + rising ADX) is a phase-change signal — extra bonus
    const htfGrowth = signal.direction === 'bullish' ? htf.dmi.growthCrossUp : htf.dmi.growthCrossDown;
    if (htfGrowth) diCrossBonus += 0.04;
    // Convergence cross — DI lines squeezed together then crossed. High-conviction entry.
    const htfConvCross = signal.direction === 'bullish' ? htf.dmi.convergenceCrossUp : htf.dmi.convergenceCrossDown;
    const mtfConvCross = signal.direction === 'bullish' ? mtf.dmi.convergenceCrossUp : mtf.dmi.convergenceCrossDown;
    if (htfConvCross) diCrossBonus += 0.06;
    if (mtfConvCross) diCrossBonus += 0.03;
    // Fast DMI cross: period-7 DMI crossed on HTF/MTF but regular DMI-14 hasn't yet.
    // Catches sharp reversals ~5-7 bars earlier than the standard cross.
    const htfFastAligned = signal.direction === 'bullish' ? htf.fastDmi.recentCrossUp : htf.fastDmi.recentCrossDown;
    const mtfFastAligned = signal.direction === 'bullish' ? mtf.fastDmi.recentCrossUp : mtf.fastDmi.recentCrossDown;
    const htfFastAdverse = signal.direction === 'bullish' ? htf.fastDmi.recentCrossDown : htf.fastDmi.recentCrossUp;
    if (htfFastAligned && !htfAligned) diCrossBonus += 0.05; // fast HTF cross leading regular
    if (mtfFastAligned && !mtfAligned) diCrossBonus += 0.02; // fast MTF cross leading regular
    if (htfFastAdverse && !htfAdverse) diCrossBonus -= 0.04; // fast adverse = momentum fading
    // Leading cross: LTF+MTF both crossed in signal direction while HTF DI lines are
    // close (spread < 5) and converging — HTF cross is imminent, don't wait for it.
    const ltfAligned = signal.direction === 'bullish' ? ltf.dmi.recentCrossUp : ltf.dmi.recentCrossDown;
    const mtfRecentAligned = signal.direction === 'bullish' ? mtf.dmi.recentCrossUp : mtf.dmi.recentCrossDown;
    const htfSpread = Math.abs(htf.dmi.plusDI - htf.dmi.minusDI);
    const htfApproachingCross = htfSpread < 5 && htf.dmi.diConverging;
    if (ltfAligned && mtfRecentAligned && htfApproachingCross && !htfAligned) {
      diCrossBonus += 0.06; // treat as early HTF cross
    }
    // Discount cross bonus when HTF ADX is low AND declining — a cross in a fading
    // low-ADX market is unreliable (loser #5: ADX=13, slope=-2.1).
    // Any positive ADX slope means trend is emerging — trust the cross.
    // Skip discount for convergence/leading/fast crosses — validated by structure.
    const hasLeadingCross = ltfAligned && mtfRecentAligned && htfApproachingCross;
    const hasFastCross = htfFastAligned && !htfAligned;
    if (diCrossBonus > 0 && htf.dmi.adx < 20 && htf.dmi.adxSlope <= 0 && !htfConvCross && !hasLeadingCross && !hasFastCross) {
      diCrossBonus *= 0.50; // half credit for crosses in low-ADX with declining momentum
    }
    // DI Cross without established trend is unreliable — cap at +0.05
    // Convergence, leading, and fast crosses bypass this cap.
    if (diCrossBonus > 0.05 && htf.dmi.adx < 25 && !htfConvCross && !hasLeadingCross && !hasFastCross) diCrossBonus = 0.05;
    diCrossBonus = Math.max(-0.06, Math.min(0.15, diCrossBonus));
  }

  // Alignment bonus
  const alignmentBonusMap: Record<string, number> = {
    all_aligned: 0.06,
    htf_mtf_aligned: 0.03,
    mtf_ltf_aligned: 0.02,
    mixed: 0,
  };
  // Reversal override: LTF is leading a direction change, higher TFs haven't caught up.
  // Floor alignment at all_aligned (+0.06) — the 3-condition reversal detection
  // (LTF opposing + HTF fading + range extreme) is a strong composite signal.
  let alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;
  if (signal.reversalOverride && alignmentBonus < 0.06) {
    alignmentBonus = 0.06;
  }
  // Leading signal override: direction was set/confirmed by leading indicators (velocity,
  // volume-confirmed candle). When alignment is 'mixed' because MTF/HTF DMI hasn't caught
  // up yet, floor alignment at mtf_ltf_aligned (+0.02) — the leading indicators provide
  // the directional conviction that MTF/HTF will eventually confirm.
  if (signal.leadingSignalOverride && alignmentBonus < 0.02) {
    alignmentBonus = 0.02;
  }

  // TD adjustment — TERTIARY indicator with minimal weight. Late-stage confirming setups (7-9)
  // provide minor support; opposing completed setups are weak exhaustion signals. TD does NOT
  // mean immediate reversal — it is background context, not a decision driver.
  let tdAdjustment = 0;
  for (const tf of tfs) {
    const setup = tf.td.setup;
    const confirmDir = signal.direction === 'bullish' ? 'buy' : 'sell';
    const opposingDir = signal.direction === 'bullish' ? 'sell' : 'buy';

    if (setup.completed) {
      // Tiny penalty if opposing setup just completed (9-bar exhaustion on wrong side)
      if (setup.completedDirection === opposingDir) tdAdjustment -= 0.01;
    } else if (setup.direction === confirmDir) {
      // Confirming setup in progress — minor reward for late-stage only
      if (setup.count >= 7) {
        tdAdjustment += 0.01; // Late-stage: strong momentum
      } else if (setup.count >= 5) {
        tdAdjustment += 0.005; // Mid-stage: decent momentum
      }
      // Early-stage (1-4): no bonus — too early to matter
    } else if (setup.direction === opposingDir && setup.count >= 7) {
      // Opposing setup near completion → tiny caution
      tdAdjustment -= 0.005;
    }
  }
  tdAdjustment = Math.max(-0.015, Math.min(0.02, tdAdjustment));

  // OBV bonus — HTF and MTF only; LTF OBV is too noisy to score
  // +0.03 per TF whose OBV trend matches signal direction (max +0.06)
  // -0.02 per TF showing OBV divergence against signal direction (clamped -0.04)
  // OBV trend confirmation is largely redundant with DI spread in trending markets,
  // so kept modest to prevent confidence inflation when all indicators agree.
  let obvBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      if (tf.obv.trend === signal.direction) obvBonus += 0.03;
      const badDivergence =
        (signal.direction === 'bullish' && tf.obv.divergence === 'bearish') ||
        (signal.direction === 'bearish' && tf.obv.divergence === 'bullish');
      if (badDivergence) obvBonus -= 0.02;
    }
    obvBonus = Math.max(-0.04, Math.min(0.06, obvBonus));
  }

  // VWAP bonus — HTF and MTF direction alignment + HTF band extension penalty.
  // VWAP is the #2 signal after DI Spread — its range (-0.12..+0.10) reflects its importance.
  // Direction alignment (HTF + MTF): +0.04 per TF where price is on the correct VWAP side;
  //   -0.04 per TF where price is significantly on the wrong side (|priceVsVwap| > 0.2%)
  // Band extension penalty (HTF only — most reliable anchor):
  //   In strong trends (HTF ADX > 35), price legitimately stays beyond VWAP bands — reduce penalty.
  //   Strong trend (ADX > 35): beyond 2σ → -0.03 (normal trend extension, not overextension)
  //   Normal trend (ADX ≤ 35): beyond 2σ → -0.10 (overextended, mean-reversion risk)
  //   beyond 1σ → -0.02 regardless of ADX
  // Clamped -0.12..+0.10
  let vwapBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      const pvv = tf.vwap.priceVsVwap;
      if (signal.direction === 'bullish') {
        if (pvv > 0) vwapBonus += 0.04;
        else if (pvv < -0.2) vwapBonus -= 0.04;
      } else {
        if (pvv < 0) vwapBonus += 0.04;
        else if (pvv > 0.2) vwapBonus -= 0.04;
      }
    }
    // Band extension check on HTF.
    // In strong trends (ADX > 35), VWAP extension is normal — reduce the penalty so we
    // don't suppress valid trend-continuation entries during the strongest market moves.
    const { vwap: htfVwap, upperBand: htfUpper, lowerBand: htfLower, deviation: htfDev } = htf.vwap;
    const htfPrice = htf.currentPrice;
    const htfAdxStrong = htf.dmi.adx > 35;
    const beyond2sigPenalty = htfAdxStrong ? -0.03 : -0.10;
    const beyond1sigPenalty = -0.02; // same regardless of ADX

    if (signal.direction === 'bullish') {
      if (htfPrice > htfUpper)              vwapBonus += beyond2sigPenalty;
      else if (htfPrice > htfVwap + htfDev) vwapBonus += beyond1sigPenalty;
    } else {
      if (htfPrice < htfLower)              vwapBonus += beyond2sigPenalty;
      else if (htfPrice < htfVwap - htfDev) vwapBonus += beyond1sigPenalty;
    }
    // Suppress positive VWAP bonus when HTF DI spread is narrowing — being on the "right"
    // side of VWAP during a fading trend is a mean-reversion trap, not a confirmation.
    // Losers #1 (diSlope=-0.8), #4 (diSlope=-6.5), #5 (diSlope=+1.4 but ADX declining) all
    // had positive VWAP bonuses that inflated confidence during exhausting moves.
    // Only suppress when momentum is clearly fading (slope < -2), not on minor fluctuations.
    // Threshold -1 was too aggressive — killed winners with mild slope jitter.
    if (vwapBonus > 0 && htf.dmi.diSpreadSlope < -2) {
      vwapBonus = 0; // VWAP alignment is unreliable when momentum is clearly fading
    }
    vwapBonus = Math.max(-0.12, Math.min(0.10, vwapBonus));
  }

  // OI/Volume bonus — triggered only when option volume is extremely high.
  // High volume relative to open interest signals fresh speculative momentum.
  //   volume >= 1000 AND vol/OI >= 1.0  → +0.05 (volume exceeds all existing OI)
  //   volume >= 1000 AND vol/OI >= 0.5  → +0.03 (volume is 50%+ of OI)
  //   volume >= 1000                     → +0.01 (high volume, modest OI ratio)
  //   volume >= 500                      → +0.01 (moderate-high volume)
  let oiVolumeBonus = 0;
  const winner = option.winnerCandidate;
  if (winner) {
    const { volume, openInterest } = winner.contract;
    if (volume >= 1000) {
      const volToOI = openInterest > 0 ? volume / openInterest : 1;
      if (volToOI >= 1.0) {
        oiVolumeBonus = 0.05;
      } else if (volToOI >= 0.5) {
        oiVolumeBonus = 0.03;
      } else {
        oiVolumeBonus = 0.01;
      }
    } else if (volume >= 500) {
      oiVolumeBonus = 0.01;
    }
  }
  oiVolumeBonus = Math.min(oiVolumeBonus, 0.05);

  // ADX maturity penalty — penalizes entering a trend that has already been running strong for many bars.
  // Skipped when a fresh DI cross is present on HTF (cross signals new momentum regardless of maturity).
  // Very mature trends (15-20+ bars) get aggressive penalties because lagging indicators (DMI/ADX)
  // still read "strong trend" at the exact point where price is most likely to reverse.
  // HTF adxBarsAbove25 >= 20 bars: extremely mature → -0.15 (trend exhaustion highly likely)
  // HTF adxBarsAbove25 >= 15 bars: very mature      → -0.12 (late entry, reversal risk elevated)
  // HTF adxBarsAbove25 >= 10 bars: mature            → -0.08
  // HTF adxBarsAbove25 >= 5 bars:  moderately mature → -0.04
  // Clamped -0.15..0
  let adxMaturityPenalty = 0;
  const htfFreshCross = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
  if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 20) {
    adxMaturityPenalty = -0.15;
  } else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 15) {
    adxMaturityPenalty = -0.12;
  } else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 10) {
    adxMaturityPenalty = -0.08;
  } else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 5) {
    adxMaturityPenalty = -0.04;
  }
  // Halve ADX maturity penalty when all timeframes align + DI spread still widening.
  // All-aligned with expanding directional momentum = genuine continuation, not late chase.
  // NOTE: Removed 1.5x amplifier for ADX >= 40 with fading slope — phase/accel penalties
  // already capture fading momentum; amplifying maturity triple-counted the same phenomenon,
  // blocking all_aligned entries across SPY/QQQ/IWM (maturity=-0.225 + phase=-0.08 + accel=-0.06).
  if (adxMaturityPenalty < 0 && (signal.alignment === 'all_aligned' || signal.alignment === 'htf_mtf_aligned') && htf.dmi.adx >= 20) {
    const dirSpread = signal.direction === 'bullish'
      ? htf.dmi.plusDI - htf.dmi.minusDI
      : htf.dmi.minusDI - htf.dmi.plusDI;
    if (dirSpread > 0 && htf.dmi.diSpreadSlope > 0) {
      adxMaturityPenalty *= 0.5;
    }
  }

  // Halve maturity when MTF or LTF recently crossed in the signal direction.
  // A fresh cross on a faster timeframe means direction recently reversed — the high
  // adxBarsAbove25 on HTF is inherited from the OLD trend, not the current direction.
  // Apr 1 SPY: bearish reversal after strong bullish morning had adxBarsAbove25=20+ from
  // the prior bullish run. MTF crossed bearish at ~14:05 ET but maturity stayed at -0.15.
  if (adxMaturityPenalty < 0) {
    const mtfFreshCross = signal.direction === 'bullish' ? mtf.dmi.recentCrossUp : mtf.dmi.recentCrossDown;
    const ltfFreshCross = ltf && (signal.direction === 'bullish' ? ltf.dmi.recentCrossUp : ltf.dmi.recentCrossDown);
    if (mtfFreshCross || ltfFreshCross) {
      adxMaturityPenalty *= 0.5;
    }
  }

  // Trend phase bonus — uses ADX slope to detect WHERE in the trend lifecycle we are.
  // Rising ADX = trend strengthening (growth phase) → bonus for entering
  // Falling ADX = trend weakening (exhaustion) → penalty to avoid late entries
  // This directly addresses the "not too early, not too late" timing problem.
  // Uses HTF ADX slope (most reliable) with MTF as confirmation.
  // Applies when HTF ADX >= 15, OR when ADX >= 10 with a strong rising slope (>3).
  // The strong-slope exception catches emerging trends where ADX is still building
  // but price is clearly trending — prevents the 30-min gap where confidence stays
  // low because ADX hasn't crossed the threshold yet.
  // Clamped -0.08..+0.06
  let trendPhaseBonus = 0;
  if (signal.direction !== 'neutral' && (htf.dmi.adx >= 15 || (htf.dmi.adx >= 10 && htf.dmi.adxSlope > 3))) {
    const htfSlope = htf.dmi.adxSlope;
    const mtfSlope = mtf.dmi.adxSlope;

    if (htfSlope > 2) {
      // HTF ADX rising strongly — growth phase, ideal entry
      trendPhaseBonus += 0.04;
      if (mtfSlope > 1) trendPhaseBonus += 0.02; // MTF confirms
    } else if (htfSlope > 0.5) {
      // HTF ADX rising modestly — early growth
      trendPhaseBonus += 0.02;
    } else if (htfSlope < -2) {
      // HTF ADX falling strongly — trend weakening, late entry risk
      trendPhaseBonus -= 0.06;
      if (mtfSlope < -1) trendPhaseBonus -= 0.02; // MTF confirms weakness
    } else if (htfSlope < -0.5) {
      // HTF ADX falling modestly — trend starting to fade
      trendPhaseBonus -= 0.03;
    }
    trendPhaseBonus = Math.max(-0.08, Math.min(0.06, trendPhaseBonus));
    // Halve negative trendPhase when all timeframes align + DI spread still widening.
    // All-aligned with expanding DI spread = genuine trending move still in progress,
    // even if ADX slope is declining (ADX peaks during strong trends).
    const htfDirSpread = signal.direction === 'bullish'
      ? htf.dmi.plusDI - htf.dmi.minusDI
      : htf.dmi.minusDI - htf.dmi.plusDI;
    if (trendPhaseBonus < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20 && htfDirSpread > 0 && htf.dmi.diSpreadSlope > 0) {
      trendPhaseBonus *= 0.5;
    }
  }

  // Momentum acceleration bonus — uses DI spread velocity to detect momentum changes.
  // Widening DI spread = momentum accelerating → good time to enter
  // Narrowing DI spread = momentum decelerating → bad time to enter (trend losing steam)
  // Uses signed spread (aligned with direction) so we measure directional momentum.
  //
  // IMPORTANT: When the trend is mature AND ADX is declining (exhaustion), a still-widening
  // DI spread is a lagging artifact — it reflects the tail end of a move, not fresh momentum.
  // In this state, positive accel bonus is suppressed to avoid entering at tops/bottoms.
  // Clamped -0.06..+0.05
  let momentumAccelBonus = 0;
  const isExhaustingTrend = adxMaturityPenalty < 0 && trendPhaseBonus < 0;
  if (signal.direction !== 'neutral') {
    // Compute directional spread slope: positive = momentum growing in signal direction
    const htfDirSpreadNow = signal.direction === 'bullish'
      ? htf.dmi.plusDI - htf.dmi.minusDI
      : htf.dmi.minusDI - htf.dmi.plusDI;
    const htfSpreadSlope = htf.dmi.diSpreadSlope;
    // Only give momentum bonus when spread is positive (confirming direction)
    // and slope is also positive (accelerating in that direction)
    if (htfDirSpreadNow > 0 && htfSpreadSlope > 2) {
      momentumAccelBonus += 0.03;
      if (mtf.dmi.diSpreadSlope > 1) momentumAccelBonus += 0.02; // MTF confirms
    } else if (htfDirSpreadNow > 0 && htfSpreadSlope > 0.5) {
      momentumAccelBonus += 0.02;
    } else if (htfSpreadSlope < -2) {
      // Momentum decelerating — spread narrowing
      momentumAccelBonus -= 0.04;
      if (mtf.dmi.diSpreadSlope < -1) momentumAccelBonus -= 0.02;
    } else if (htfSpreadSlope < -0.5) {
      momentumAccelBonus -= 0.02;
    }
    // Suppress positive accel during exhaustion: mature trend + declining ADX means
    // a widening DI spread is lagging, not a genuine momentum signal.
    if (isExhaustingTrend && momentumAccelBonus > 0) {
      momentumAccelBonus = 0;
    }
    momentumAccelBonus = Math.max(-0.06, Math.min(0.05, momentumAccelBonus));
  }

  // Price position adjustment — penalizes entering in the direction of an already-extended move.
  // Uses HTF rangePosition: 0.0 = at swing low, 1.0 = at swing high.
  //   Bullish from upper half: price already extended up, limited upside → penalty up to -0.12
  //   Bearish from lower half: price already extended down, limited downside → penalty up to -0.12
  //   Bullish from lower half / bearish from upper half = following momentum with room to run (no penalty).
  // Extreme positions (>85% bullish or <15% bearish) get aggressive penalty — entering at the edge
  // of a range is almost always chasing the last move.
  // Losers #2 (93%), #4 (81%), #6 (9%) all entered at range extremes.
  let pricePositionAdjustment = 0;
  {
    const htfRangePosition = htf.priceStructure.rangePosition;
    // Strong active trend (ADX > 25 + rising) means genuine breakout/breakdown — range is
    // resetting, not about to reverse. Exempt from extreme penalty.
    // Very low ADX (< 15) means the swing range is too narrow to be meaningful — the
    // extreme penalty (-0.12) would punish entries in ranges of just $0.50-1.00.
    // The gradual penalty still applies via the normal path.
    const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0;
    const extremePenaltyApplies = !strongActiveTrend && htf.dmi.adx >= 15;

    // Softer extreme penalty when all_aligned — genuine trend pushes price to range edge.
    const extremePenalty = (signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) ? -0.06 : -0.12;
    if (signal.direction === 'bullish' && htfRangePosition > 0.5) {
      if (htfRangePosition >= 0.85 && extremePenaltyApplies) {
        pricePositionAdjustment = extremePenalty;
      } else if (adxMaturityPenalty === 0) {
        pricePositionAdjustment = Math.max(-0.08, -(htfRangePosition - 0.5) * 0.16);
      }
    } else if (signal.direction === 'bearish' && htfRangePosition < 0.5) {
      if (htfRangePosition <= 0.15 && extremePenaltyApplies) {
        pricePositionAdjustment = extremePenalty;
      } else if (adxMaturityPenalty === 0) {
        pricePositionAdjustment = Math.max(-0.08, -(0.5 - htfRangePosition) * 0.16);
      }
    }
    // Halve scaled price-position penalty when all_aligned — genuine trend pushes
    // through range, not a reversal setup.
    if (pricePositionAdjustment < 0 && pricePositionAdjustment > -0.06 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) {
      pricePositionAdjustment *= 0.5;
    }
  }

  // Prior Day Levels bonus — institutional reference prices that confirm or oppose the trade.
  //   Bullish entry above PDH: +0.06 (price broke yesterday's high — structural strength)
  //   Bullish entry above PDC but below PDH: +0.02 (above prior close, approaching PDH)
  //   Bullish entry below PDL: -0.08 (buying when price can't hold prior day's floor)
  //   Bearish entry below PDL: +0.06 (price broke yesterday's low — structural weakness)
  //   Bearish entry below PDC but above PDL: +0.02 (below prior close, approaching PDL)
  //   Bearish entry above PDH: -0.08 (selling when price is breaking out to upside)
  //   Clamped -0.08..+0.06
  let structureBonus = 0;
  if (signal.direction !== 'neutral' && signal.priorDayLevels.pdh > 0) {
    const { abovePDH, belowPDL, pdc, priceVsPDH, priceVsPDL } = signal.priorDayLevels;
    const price = signal.currentPrice;
    if (signal.direction === 'bullish') {
      if (abovePDH) {
        // False breakout filter: if price barely crossed PDH (< 0.10%), it's likely
        // a wick/false breakout — reduce bonus from +0.06 to +0.02.
        structureBonus = priceVsPDH < 0.10 ? 0.02 : 0.06;
      }
      else if (price > pdc)      structureBonus = 0.02;
      else if (belowPDL)         structureBonus = -0.08;
    } else {
      if (belowPDL) {
        // False breakout filter: barely below PDL (< 0.10% distance) → reduce bonus.
        structureBonus = Math.abs(priceVsPDL) < 0.10 ? 0.02 : 0.06;
      }
      else if (price < pdc)      structureBonus = 0.02;
      else if (abovePDH)         structureBonus = -0.08;
    }
    structureBonus = Math.max(-0.08, Math.min(0.06, structureBonus));
    // Zero structure penalty when all timeframes align + very strong active trend.
    // Prior day levels reflect the old market regime; a strong aligned trend today
    // legitimately pushes price through yesterday's levels. Only for ADX > 30 + rising
    // to avoid suppressing the penalty for weak or fading trends.
    // Halve for moderate trends (ADX > 25 + rising).
    if (structureBonus < 0 && (signal.alignment === 'all_aligned' || signal.alignment === 'htf_mtf_aligned')) {
      if (htf.dmi.adx > 30 && htf.dmi.adxSlope > 0) {
        structureBonus = 0;
      } else if (htf.dmi.adx > 25 && htf.dmi.adxSlope > 0) {
        structureBonus *= 0.5;
      }
    }
  }

  // Opening Range Breakout bonus — confirms or contradicts entry direction vs ORB.
  // Only scored when the ORB has fully formed (after 10:00 AM ET).
  //   Breakout in trade direction: +0.06 (momentum aligned with day's directional bias)
  //   Breakout against trade direction: -0.08 (trading against the day's established direction)
  //   No breakout (price still inside ORB): 0 (neutral — range-bound, no ORB edge)
  //   Clamped -0.08..+0.06
  let orbBonus = 0;
  if (signal.direction !== 'neutral' && signal.orb.orbFormed) {
    const { breakoutDirection, breakoutStrength } = signal.orb;
    if (breakoutDirection === signal.direction) {
      // False breakout filter: breakoutStrength < 0.25 means price barely crossed
      // the ORB boundary (< 25% of range beyond it) — likely a false breakout.
      // Reduce bonus from +0.06 to +0.02 for weak breakouts.
      orbBonus = breakoutStrength < 0.25 ? 0.02 : 0.06;
    } else if (breakoutDirection !== 'none' && breakoutDirection !== signal.direction) {
      orbBonus = -0.08;
    }
    orbBonus = Math.max(-0.08, Math.min(0.06, orbBonus));
  }

  // Recent price action — checks last 3 LTF bars to verify price is actually moving
  // in the signal direction RIGHT NOW.  Lagging indicators (DMI, ADX) can say "bullish"
  // while price is actively declining.  This penalty catches that disconnect.
  //
  // CRITICAL: The MOST RECENT bar has disproportionate weight.  When earlier bars
  // confirmed a trend but the latest bar flips direction, that's a reversal signal —
  // lagging indicators (DMI/ADX) haven't caught up yet but price already turned.
  // This prevents entries right at the point of direction change.
  //
  //   Direction change detected (last bar opposes, prior bars confirmed): -0.15
  //   All 3 recent bars oppose direction AND net move opposes: -0.12 (strong contradiction)
  //   2 of 3 bars oppose AND net move opposes: -0.08 (moderate contradiction)
  //   Net move opposes but bars are mixed: -0.04 (mild headwind)
  //   Last bar opposes (but prior bars also mixed): -0.06 (latest bar reversal)
  //   Price action confirms direction: +0.04 (small bonus for real-time confirmation)
  // Uses LTF bars (most granular) for the freshest price action read.
  // Clamped -0.15..+0.04
  let recentPriceActionBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const bars = ltf.bars;
    if (bars.length >= 4) {
      const recentBars = bars.slice(-3); // last 3 bars
      const netMove = recentBars[recentBars.length - 1].close - recentBars[0].open;
      const bearishBars = recentBars.filter(b => b.close < b.open).length;
      const bullishBars = recentBars.filter(b => b.close > b.open).length;

      const isBullish = signal.direction === 'bullish';
      const netOpposes = isBullish ? netMove < 0 : netMove > 0;
      const opposingBarCount = isBullish ? bearishBars : bullishBars;
      const confirmingBarCount = isBullish ? bullishBars : bearishBars;

      // Direction change detection: the LAST bar is the key reversal signal.
      // When prior bars confirmed the trend but the latest bar flips, lagging
      // indicators still read "strong trend" but price has already turned.
      const lastBar = recentBars[recentBars.length - 1]!;
      const lastBarOpposes = isBullish
        ? lastBar.close < lastBar.open   // bearish candle in bullish signal
        : lastBar.close > lastBar.open;  // bullish candle in bearish signal
      const priorBars = recentBars.slice(0, -1);
      const priorConfirming = priorBars.filter(b =>
        isBullish ? b.close > b.open : b.close < b.open
      ).length;

      if (lastBarOpposes && priorConfirming >= 2) {
        // Direction change: prior bars built the trend, last bar reversed.
        // This is the exact scenario where lagging indicators peak at the reversal.
        // When all_aligned, cap at -0.08: a single opposing 1m bar in a confirmed
        // multi-TF trend is likely noise, not a genuine reversal. Without this cap,
        // the -0.15 triggers the 60% hard gate and blocks valid entries.
        // Mar 20 SPY: bearish all_aligned at $652, single green 1m bar triggered
        // -0.15 + hard gate → missed the $1.70 continuation drop.
        recentPriceActionBonus = (signal.alignment === 'all_aligned' || signal.reversalOverride) ? -0.08 : -0.15;
      } else if (netOpposes && opposingBarCount >= 3) {
        recentPriceActionBonus = -0.12; // strong: all bars + net move oppose
      } else if (netOpposes && opposingBarCount >= 2) {
        recentPriceActionBonus = -0.08; // moderate: most bars + net move oppose
      } else if (lastBarOpposes) {
        // Last bar opposes but prior bars were mixed — still a warning
        recentPriceActionBonus = -0.06;
      } else if (netOpposes) {
        recentPriceActionBonus = -0.04; // mild: net move opposes but bars are mixed
      } else if (!netOpposes && confirmingBarCount >= 3 && !lastBarOpposes) {
        recentPriceActionBonus = 0.08;  // strong: all 3 bars + net move confirm direction
      } else if (!netOpposes && confirmingBarCount >= 2 && !lastBarOpposes) {
        recentPriceActionBonus = 0.04;  // moderate: 2 of 3 bars confirm direction
      }
      // Suppress positive price action bonus when at range extreme — consecutive confirming
      // bars at a range boundary are the final push of exhaustion, not fresh momentum.
      // Loser #2 had 5 green bars into 93% range, #4 had 4 green bars into 81%, #5 had 4 green bars into range top.
      // Only suppress at range extremes when the range is meaningful (ADX >= 15).
      if (recentPriceActionBonus > 0 && htf.dmi.adx >= 15) {
        const rp = htf.priceStructure.rangePosition;
        const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0;
        const atExtreme = (signal.direction === 'bullish' && rp >= 0.80) || (signal.direction === 'bearish' && rp <= 0.20);
        if (atExtreme && !strongActiveTrend) {
          recentPriceActionBonus = 0; // confirming bars at range edge = exhaustion, not signal
        }
      }
    }
  }

  // TR contraction penalty — uses raw True Range from the last 3 LTF bars vs the prior
  // 10-bar average TR to detect momentum drying up IN REAL TIME (no smoothing lag).
  // When a trend is exhausting, bars get smaller (lower TR) even while lagging indicators
  // like ADX/DI still read "strong trend".  This catches the instant momentum fade.
  //   Recent TR < 50% of avg TR: -0.08 (severe contraction — momentum dried up)
  //   Recent TR < 70% of avg TR: -0.05 (moderate contraction — momentum fading)
  //   Recent TR > 130% of avg TR: +0.00 (expanding TR — no penalty, genuine momentum)
  // Uses LTF bars for the most granular real-time read.
  // Clamped -0.08..0
  let trContractionPenalty = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const bars = ltf.bars;
    if (bars.length >= 14) { // need enough bars for avg + recent
      // Compute TR for last 13 bars (index 1..13 relative to slice)
      const window = bars.slice(-14);
      const trValues: number[] = [];
      for (let i = 1; i < window.length; i++) {
        const curr = window[i]!;
        const prev = window[i - 1]!;
        const tr = Math.max(
          curr.high - curr.low,
          Math.abs(curr.high - prev.close),
          Math.abs(curr.low - prev.close)
        );
        trValues.push(tr);
      }
      // Average TR of the first 10 bars (the "baseline")
      const baselineTR = trValues.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
      // Average TR of the last 3 bars (the "recent")
      const recentTR = trValues.slice(-3).reduce((a, b) => a + b, 0) / 3;

      if (baselineTR > 0) {
        const trRatio = recentTR / baselineTR;
        if (trRatio < 0.50) {
          trContractionPenalty = -0.08; // severe: bars shrunk to half or less
        } else if (trRatio < 0.70) {
          trContractionPenalty = -0.05; // moderate: bars noticeably smaller
        }
      }
    }
  }

  // Low volatility penalty — penalizes entries when HTF ADX is very low, indicating
  // a range-bound market with no real trend. Options theta eats premium while price
  // goes nowhere. DI spread can still show a directional lean in low-vol, but it's
  // unreliable without trending ADX to back it up.
  //   HTF ADX < 15: -0.10 (no trend at all — directionless chop)
  //   HTF ADX 15-20: -0.05 (weak/emerging trend — marginal)
  //   Skipped when a recent DI cross (2-bar window) is present — cross precedes ADX rise.
  //   Halved when price action confirms direction (bars are moving, ADX just hasn't caught up).
  // Clamped -0.10..0
  let lowVolPenalty = 0;
  if (signal.direction !== 'neutral') {
    const htfFreshCrossAligned = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
    const htfRecentCross = signal.direction === 'bullish' ? htf.dmi.recentCrossUp : htf.dmi.recentCrossDown;
    if (htf.dmi.adx < 15) {
      lowVolPenalty = -0.10;
    } else if (htf.dmi.adx < 20) {
      lowVolPenalty = -0.05;
    }
    // Fresh 1-bar cross fully waives — this is the strongest timing signal and often
    // precedes ADX rise. Recent (2-bar) cross only halves — the signal is aging.
    // Loser #5 (ADX=13, recentCross) had full waive but cross didn't follow through.
    // Mar 19 winner (ADX=11, fresh cross) correctly got full waive.
    if (lowVolPenalty < 0) {
      // Fresh cross waiver: fully waive only when ADX is rising (genuine new trend).
      // When ADX slope < 0, the cross happened but momentum is fading — halve instead.
      if (htfFreshCrossAligned) {
        lowVolPenalty = htf.dmi.adxSlope >= 0 ? 0 : lowVolPenalty * 0.50;
      } else if (htfRecentCross) {
        lowVolPenalty *= 0.50; // recent cross: half waive
      }
      // All-aligned + ADX trending up reduction is applied after exhaustion is computed (see below).
    }
  }

  // Move exhaustion penalty — detects when a large directional move has already played out.
  // Uses HTF bars to measure the recent move magnitude relative to ATR.
  // After a big move (e.g. $3 drop on SPY), lagging indicators still read "strong trend" but
  // entering is chasing — most of the edge is gone and a bounce/consolidation is likely.
  //   Move ≥ 2.5× ATR in signal direction: -0.15 (major move complete, extreme chasing risk)
  //   Move ≥ 1.5× ATR: -0.10 (large move, high chasing risk)
  //   Move ≥ 1.0× ATR: -0.06 (moderate move, some chasing risk)
  // Skipped when a fresh HTF DI cross is present (cross = new phase, not exhaustion).
  // Clamped -0.15..0
  let moveExhaustionPenalty = 0;
  if (signal.direction !== 'neutral' && !htfFreshCross && htf.bars.length >= 6) {
    const recentHTF = htf.bars.slice(-5); // last 5 HTF bars
    const htfATR = htf.atr.atr;
    if (htfATR > 0) {
      // Measure max directional move in last 5 bars
      let maxHigh = -Infinity;
      let minLow = Infinity;
      for (const bar of recentHTF) {
        if (bar.high > maxHigh) maxHigh = bar.high;
        if (bar.low < minLow) minLow = bar.low;
      }
      const moveMagnitude = maxHigh - minLow;
      const moveInDirection = signal.direction === 'bearish'
        ? recentHTF[0]!.high - recentHTF[recentHTF.length - 1]!.low    // bearish: high→low drop
        : recentHTF[recentHTF.length - 1]!.high - recentHTF[0]!.low;   // bullish: low→high rise
      // Only penalize if the move was IN the signal direction (we'd be chasing it)
      if (moveInDirection > 0) {
        const moveATRs = moveInDirection / htfATR;
        if (moveATRs >= 2.5) {
          moveExhaustionPenalty = -0.15;
        } else if (moveATRs >= 1.5) {
          moveExhaustionPenalty = -0.10;
        } else if (moveATRs >= 1.0) {
          moveExhaustionPenalty = -0.06;
        }
        // NOTE: Price action confirmation does NOT reduce exhaustion penalty.
        // At the tail end of an exhausted move, recent bars still confirm direction
        // — that's what "chasing" looks like, not fresh momentum.
        // However, when ALL timeframes align + momentum still accelerating, the trend
        // may be continuing. Halve the penalty (including severe) — all-aligned with
        // rising ADX is the strongest continuation signal we have.
        // Apr 1 SPY 14:25: bearish all_aligned, adxSlope=+2.1, accel=+0.05,
        // but mex=-0.15 blocked entry despite clear trend acceleration.
        if (moveExhaustionPenalty < 0 && (signal.alignment === 'all_aligned' || signal.alignment === 'htf_mtf_aligned') && htf.dmi.adx >= 20 && momentumAccelBonus > 0) {
          moveExhaustionPenalty *= 0.5;
        }
      }
    }
  }

  // Deferred lowVol reduction: all-aligned + ADX trending up = trend forming, ADX just
  // hasn't crossed 20 yet. Skip when move exhaustion is active — weak ADX + extended
  // move = don't ease up. Mar 20 SPY 13:36 ET: lowVol + exhaustion both halved → 65.6%
  // bad entry at day's low that bounced $0.67.
  if (lowVolPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 15 && htf.dmi.adxSlope > 0 && moveExhaustionPenalty === 0) {
    lowVolPenalty *= 0.50;
  }

  // Consolidation penalty — detects sideways/choppy price action where bars heavily overlap.
  // In a trending market, each bar makes new territory (low overlap). In a range, bars retrace
  // over the same prices (high overlap). Buying directional options in chop = theta burn with no edge.
  // Uses LTF bars overlap ratio: sum of bar ranges vs total range covered.
  //   Overlap ratio ≥ 3.0: -0.10 (extreme chop — bars cover 3× the same ground)
  //   Overlap ratio ≥ 2.5: -0.06 (heavy chop)
  //   Overlap ratio ≥ 2.0: -0.03 (moderate chop)
  // Skipped when recent price action strongly confirms direction (recentPriceActionBonus >= 0.04)
  // Clamped -0.10..0
  let consolidationPenalty = 0;
  if (signal.direction !== 'neutral' && ltf && ltf.bars.length >= 8) {
    const chopBars = ltf.bars.slice(-6); // last 6 LTF bars
    const totalBarRange = chopBars.reduce((sum, b) => sum + (b.high - b.low), 0);
    let overallHigh = -Infinity;
    let overallLow = Infinity;
    for (const b of chopBars) {
      if (b.high > overallHigh) overallHigh = b.high;
      if (b.low < overallLow) overallLow = b.low;
    }
    const overallRange = overallHigh - overallLow;
    if (overallRange > 0) {
      const overlapRatio = totalBarRange / overallRange;
      if (overlapRatio >= 3.0) {
        consolidationPenalty = -0.10;
      } else if (overlapRatio >= 2.5) {
        consolidationPenalty = -0.06;
      } else if (overlapRatio >= 2.0) {
        consolidationPenalty = -0.03;
      }
    }
    // Halve consolidation when all_aligned — "pause that refreshes" in a genuine trend.
    if (consolidationPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) {
      consolidationPenalty *= 0.5;
    }
  }

  // Near-level penalty — penalizes buying puts near support or calls near resistance.
  // When price is within 0.3% of the swing low (for puts) or swing high (for calls),
  // the move is more likely to bounce than continue. Buying options at these levels
  // means paying premium right where mean-reversion kicks in.
  // Uses HTF swing levels (more meaningful than LTF noise).
  //   Price within 0.15% of level: -0.10 (right at support/resistance)
  //   Price within 0.30% of level: -0.06 (near support/resistance)
  //   Price within 0.50% of level: -0.03 (approaching support/resistance)
  // Skipped when price has already broken through the level (structure bonus confirms breakdown/breakout).
  // Clamped -0.10..0
  let nearLevelPenalty = 0;
  if (signal.direction !== 'neutral') {
    const ps = htf.priceStructure;
    const price = signal.currentPrice;
    // Halve the penalty when price action confirms direction — this may be a genuine
    // breakdown through support / breakout through resistance, not a bounce zone.
    const activeBreakdown = recentPriceActionBonus > 0;
    if (signal.direction === 'bearish') {
      // For puts: penalize when near swing low (support)
      const distToSupport = ps.swingLow > 0 ? ((price - ps.swingLow) / ps.swingLow) * 100 : 999;
      // Only penalize when price is ABOVE support (approaching it, not yet broken)
      if (distToSupport > 0 && distToSupport <= 0.15) {
        nearLevelPenalty = -0.10;
      } else if (distToSupport > 0 && distToSupport <= 0.30) {
        nearLevelPenalty = -0.06;
      } else if (distToSupport > 0 && distToSupport <= 0.50) {
        nearLevelPenalty = -0.03;
      }
    } else {
      // For calls: penalize when near swing high (resistance)
      const distToResistance = ps.swingHigh > 0 ? ((ps.swingHigh - price) / ps.swingHigh) * 100 : 999;
      if (distToResistance > 0 && distToResistance <= 0.15) {
        nearLevelPenalty = -0.10;
      } else if (distToResistance > 0 && distToResistance <= 0.30) {
        nearLevelPenalty = -0.06;
      } else if (distToResistance > 0 && distToResistance <= 0.50) {
        nearLevelPenalty = -0.03;
      }
    }
    // NOTE: Price action confirmation does NOT reduce near-level penalty.
    // Confirming bars near support/resistance are the tail end before a bounce.
    // Only halve for very strong active trends (ADX > 30 and rising) — these genuinely
    // break through levels. Weaker trends bounce off support/resistance.
    if (nearLevelPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx > 30 && htf.dmi.adxSlope > 0) {
      nearLevelPenalty = 0; // strong active trend breaks through levels
    }
    // When swing low/high was set very recently (within last 2 bars), price is actively
    // making new lows/highs — the level is breaking down, not acting as support/resistance.
    // Mar 20 SPY: bearish at $652 near swing low $651.50 got -5% near-level, but price
    // was actively pushing new lows — the swing low kept moving with price.
    if (nearLevelPenalty < 0) {
      const activelySetting = signal.direction === 'bearish'
        ? ps.swingLowBarsAgo <= 2
        : ps.swingHighBarsAgo <= 2;
      if (activelySetting) {
        nearLevelPenalty *= 0.5;
      }
    }
  }

  // Theta decay penalty — penalizes short-dated option entries as expiration approaches.
  // Theta accelerates dramatically for options nearing expiration. The penalty scales based
  // on hours remaining until the option expires (market close on expiration day = 20:00 UTC).
  //
  // 0DTE (expires today):
  //   ≤ 30 min to close: -0.10 (extreme theta, almost guaranteed loss without massive move)
  //   ≤ 60 min to close: -0.06 (heavy theta, need fast move)
  //   ≤ 90 min to close: -0.03 (elevated theta, reduced edge)
  //
  // 1DTE (expires tomorrow, entering late in the day):
  //   ≤ 150 min to today's close: -0.06 (overnight theta + gamma risk, entering near close)
  //   ≤ 180 min to today's close: -0.03 (elevated next-day theta, reduced edge)
  //
  // Market close = 20:00 UTC (4 PM ET).
  // Clamped -0.10..0
  let thetaDecayPenalty = 0;
  if (option.winnerCandidate) {
    const expDate = option.winnerCandidate.contract.expiration; // YYYY-MM-DD
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const marketCloseUtc = new Date(`${todayStr}T20:00:00Z`);
    const minutesToClose = (marketCloseUtc.getTime() - now.getTime()) / 60000;

    if (expDate === todayStr) {
      // 0DTE: aggressive penalty
      if (minutesToClose <= 30) {
        thetaDecayPenalty = -0.10;
      } else if (minutesToClose <= 60) {
        thetaDecayPenalty = -0.06;
      } else if (minutesToClose <= 90) {
        thetaDecayPenalty = -0.03;
      }
    } else {
      // 1DTE check: expiration is tomorrow
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowStr = tomorrow.toISOString().slice(0, 10);
      if (expDate === tomorrowStr) {
        // 1DTE: moderate penalty for late-day entries (high overnight theta + gamma decay)
        if (minutesToClose <= 150) {
          thetaDecayPenalty = -0.06;
        } else if (minutesToClose <= 180) {
          thetaDecayPenalty = -0.03;
        }
      }
    }
  }

  // Narrow range penalty — detects range-bound/choppy days where the intraday range so far
  // is small relative to the prior day's range. On narrow-range days, directional signals are
  // unreliable: DMI/ADX can show alignment in a $2-3 range that has no follow-through.
  // Uses prior day high/low (pdh/pdl) as the baseline for a "normal" day's range.
  //   Today's range < 40% of prior day: -0.12 (extremely tight — directionless chop)
  //   Today's range < 55% of prior day: -0.08 (tight range — limited follow-through)
  //   Today's range < 70% of prior day: -0.04 (below-average range — cautious)
  // Clamped -0.12..0
  let narrowRangePenalty = 0;
  if (signal.direction !== 'neutral' && htf.bars.length >= 3 && signal.priorDayLevels.pdh > 0) {
    const priorDayRange = signal.priorDayLevels.pdh - signal.priorDayLevels.pdl;
    if (priorDayRange > 0) {
      let dayHigh = -Infinity;
      let dayLow = Infinity;
      for (const bar of htf.bars) {
        if (bar.high > dayHigh) dayHigh = bar.high;
        if (bar.low < dayLow) dayLow = bar.low;
      }
      const todayRange = dayHigh - dayLow;
      const rangeRatio = todayRange / priorDayRange;
      if (rangeRatio < 0.40) {
        narrowRangePenalty = -0.12;
      } else if (rangeRatio < 0.55) {
        narrowRangePenalty = -0.08;
      } else if (rangeRatio < 0.70) {
        narrowRangePenalty = -0.04;
      }
    }
  }

  // ── LEADING INDICATORS — zero-lag signals that detect moves before DMI/ADX ──
  // These bonuses compensate for lagged indicator delays by rewarding real-time
  // price action, candle structure, and volume that appear at the START of moves.

  // Candle pattern bonus — engulfing and reversal patterns are instant signals.
  // Already computed per-timeframe but previously unused in confidence scoring.
  // Engulfing patterns are especially powerful: they signal institutional conviction
  // in a single bar, often appearing 5-10 bars before DMI confirms.
  //   Aligned engulfing (HTF): +0.06 | Aligned engulfing (MTF): +0.04
  //   Aligned engulfing (LTF): +0.02 (noisy, small weight)
  //   Hammer at support (bullish) / shooting star at resistance (bearish): +0.04
  //   Opposing engulfing on HTF: -0.06 (strong counter-signal)
  //   Opposing engulfing on MTF: -0.04
  //   Clamped -0.08..+0.08
  let candlePatternBonus = 0;
  if (signal.direction !== 'neutral') {
    const isBull = signal.direction === 'bullish';
    for (let i = 0; i < tfs.length; i++) {
      const tf = tfs[i]!;
      const cp = tf.allCandlePatterns;
      const weight = i === 2 ? 0.06 : i === 1 ? 0.04 : 0.02; // HTF > MTF > LTF
      // Aligned engulfing
      if (isBull && cp.bullishEngulfing.present) candlePatternBonus += weight;
      if (!isBull && cp.bearishEngulfing.present) candlePatternBonus += weight;
      // Opposing engulfing (penalty)
      if (isBull && cp.bearishEngulfing.present) candlePatternBonus -= weight;
      if (!isBull && cp.bullishEngulfing.present) candlePatternBonus -= weight;
    }
    // Hammer / shooting star — directional reversal candles at key levels
    const htfCp = htf.allCandlePatterns;
    const rp = htf.priceStructure.rangePosition;
    if (isBull && htfCp.hammer.present && rp <= 0.35) candlePatternBonus += 0.04;
    if (!isBull && htfCp.shootingStar.present && rp >= 0.65) candlePatternBonus += 0.04;
    // Opposing hammer/star (wrong context)
    if (isBull && htfCp.shootingStar.present && rp >= 0.75) candlePatternBonus -= 0.03;
    if (!isBull && htfCp.hammer.present && rp <= 0.25) candlePatternBonus -= 0.03;
    candlePatternBonus = Math.max(-0.08, Math.min(0.08, candlePatternBonus));
  }

  // Price velocity bonus — raw ROC and directional velocity with ZERO smoothing lag.
  // While DMI takes 14+ bars to confirm direction via Wilder's smoothing,
  // price velocity measures the actual speed of price movement RIGHT NOW.
  //   Strong directional velocity aligned with signal: +0.06
  //   Moderate directional velocity aligned: +0.03
  //   Acceleration (velocity building): +0.02 extra
  //   Velocity opposing signal direction: -0.04 to -0.06
  //   Clamped -0.06..+0.08
  let priceVelocityBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const pv = ltf.priceVelocity;
    const isBull = signal.direction === 'bullish';
    const dirVel = pv.directionalVelocity;
    const aligned = isBull ? dirVel > 0 : dirVel < 0;
    const absVel = Math.abs(dirVel);

    if (aligned) {
      // Directional velocity confirms signal — this is real-time price momentum
      if (absVel > 0.08) priceVelocityBonus += 0.06;       // strong velocity (>0.08% per bar)
      else if (absVel > 0.04) priceVelocityBonus += 0.03;  // moderate velocity
      // Acceleration bonus: momentum is BUILDING, not just present
      if (pv.acceleration > 0.02) priceVelocityBonus += 0.02;
    } else if (absVel > 0.04) {
      // Velocity opposes signal — price is actively moving against the trade
      if (absVel > 0.08) priceVelocityBonus -= 0.06;
      else priceVelocityBonus -= 0.04;
    }
    // Suppress positive velocity bonus in exhausting trends — fast price at the end of
    // a move looks like "strong velocity" but is chasing, not fresh momentum.
    if (isExhaustingTrend && priceVelocityBonus > 0 && moveExhaustionPenalty <= -0.10) {
      priceVelocityBonus = 0;
    }
    priceVelocityBonus = Math.max(-0.06, Math.min(0.08, priceVelocityBonus));
  }

  // Volume surge bonus — institutional activity signal.
  // Large volume spikes at the start of moves indicate institutional participation,
  // which leads price action. A volume surge with aligned price direction = strong entry signal.
  //   Volume ratio > 2.0 + confirms direction: +0.06 (strong institutional activity)
  //   Volume ratio > 1.5 + confirms direction: +0.04 (elevated activity)
  //   Volume ratio > 1.3 + increasing trend: +0.02 (building activity)
  //   Volume drying up (ratio < 0.5): -0.02 (no conviction behind move)
  //   Clamped -0.02..+0.06
  let volumeSurgeBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const vs = ltf.volumeSurge;
    const isBull = signal.direction === 'bullish';
    // Check if volume surge aligns with price direction
    const lastBar = ltf.bars[ltf.bars.length - 1];
    const priceConfirms = lastBar
      ? (isBull ? lastBar.close > lastBar.open : lastBar.close < lastBar.open)
      : false;

    if (vs.recentVolumeRatio > 2.0 && priceConfirms) {
      volumeSurgeBonus = 0.06;
    } else if (vs.recentVolumeRatio > 1.5 && priceConfirms) {
      volumeSurgeBonus = 0.04;
    } else if (vs.recentVolumeRatio > 1.3 && vs.volumeTrend === 'increasing') {
      volumeSurgeBonus = 0.02;
    } else if (vs.recentVolumeRatio < 0.5) {
      // Volume drying up — no conviction behind the current move
      volumeSurgeBonus = -0.02;
    }
    volumeSurgeBonus = Math.max(-0.02, Math.min(0.06, volumeSurgeBonus));
  }

  // Reversal override adjustments: suppress penalties that are artifacts of the old direction.
  // In a reversal, exhaustion/nearLevel/fading momentum/DI spread/low ADX all reflect the
  // OLD trend completing, not the new direction being weak.
  if (signal.reversalOverride) {
    if (moveExhaustionPenalty < 0) moveExhaustionPenalty = 0;
    if (nearLevelPenalty < 0) nearLevelPenalty = 0;
    if (trendPhaseBonus < 0) trendPhaseBonus = 0;
    if (momentumAccelBonus < 0) momentumAccelBonus = 0;
    if (pricePositionAdjustment < 0) pricePositionAdjustment = 0;
    if (diSpreadBonus < 0) diSpreadBonus = 0;   // MTF/HTF show old direction's DI dominance
    if (lowVolPenalty < 0) lowVolPenalty = 0;    // low ADX = old trend weakening, expected
    if (vwapBonus === 0) vwapBonus = 0.06;       // restore VWAP bonus killed by fading diSpreadSlope
    // ADX maturity reflects the OLD trend's age, not the new direction.
    // Apr 1 SPY: bearish reversal after strong bullish morning had adxBarsAbove25=20+
    // because ADX stayed high from the prior trend → -0.15 penalty on a fresh move.
    if (adxMaturityPenalty < 0) adxMaturityPenalty = 0;
  }

  // Leading signal override adjustments: when direction was set/confirmed by leading
  // indicators, some lagged-indicator penalties are artifacts of the OLD state (ADX hasn't
  // risen yet, DI spread hasn't widened yet). Suppress these to avoid blocking early entries.
  if (signal.leadingSignalOverride) {
    // Low ADX penalty: ADX is expected to be low at the START of a move — the leading
    // indicators caught it before ADX could rise. Halve the penalty instead of full suppress
    // to maintain some caution.
    if (lowVolPenalty < 0) lowVolPenalty *= 0.5;
    // DI spread opposing: MTF/HTF DI spread still shows old direction. Cap negative spread
    // at -0.05 instead of -0.15 — leading indicators provide the directional conviction.
    if (diSpreadBonus < -0.05) diSpreadBonus = -0.05;
    // Trend phase penalty: declining ADX slope is expected when the OLD trend is ending
    // and a new one starting. Suppress if velocity confirms the new direction.
    if (trendPhaseBonus < 0 && priceVelocityBonus > 0) trendPhaseBonus *= 0.5;
  }

  // Counter-trend adjustment for MTF+LTF aligned signals: when MTF+LTF agree on direction
  // but HTF still opposes (mtf_ltf_aligned), several HTF-derived penalties are artifacts of
  // the old trend rather than weaknesses of the new signal.  The "move exhaustion" on HTF
  // IS the reversal beginning; fading ADX/DI is the old trend ending; being below PDL (bullish)
  // or above PDH (bearish) is the entry point, not a trap.
  // Less aggressive than reversalOverride (which requires LTF opposing + HTF fading + range extreme).
  // SPY 2026-03-30 14:52 UTC: bullish bounce from $634.95 blocked at conf=0.00 because
  // mex/phase/accel/struct/maturity all reflected the prior bearish trend.
  if (signal.alignment === 'mtf_ltf_aligned' && !signal.reversalOverride) {
    if (moveExhaustionPenalty < 0) moveExhaustionPenalty = 0;         // HTF move = reversal start
    if (trendPhaseBonus < 0) trendPhaseBonus = 0;                     // fading ADX = old trend ending
    if (momentumAccelBonus < 0) momentumAccelBonus = 0;               // narrowing DI = old trend fading
    if (structureBonus < 0) structureBonus = 0;                        // below PDL / above PDH = entry point
    if (adxMaturityPenalty < 0) adxMaturityPenalty *= 0.5;            // HTF maturity = old trend's age
    if (pricePositionAdjustment < 0) pricePositionAdjustment *= 0.5; // range from old trend
    if (diSpreadBonus < 0) diSpreadBonus = 0;                         // HTF DI opposes by definition
    alignmentBonus = Math.max(alignmentBonus, 0.04);                  // MTF+LTF both confirm = stronger than 0.02
  }

  // DI Spread cap for aged trends: in a mature trend the DI spread reflects sustained
  // momentum, not fresh signal. Cap to prevent inflated confidence on stale setups.
  if (adxMaturityPenalty <= -0.04) diSpreadBonus = Math.min(diSpreadBonus, 0.06);

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty + candlePatternBonus + priceVelocityBonus + volumeSurgeBonus));

  // ── SOFT GATES: Replace cliff-effect hard caps with smooth sigmoid penalties ──
  // These 5 gates caused the most zero-entry days due to cliff effects (0.64 miss vs 0.66 entry).
  // Soft gates produce continuous degradation — no discontinuities, easier to tune universally.
  {
    const rp = htf.priceStructure.rangePosition;
    const softGateResult = applySoftGates({
      adx: htf.dmi.adx,
      recentPriceActionBonus,
      adxMaturityPenalty,
      structureBonus,
      rangePosition: rp,
      direction: signal.direction,
      alignment: signal.alignment,
      adxSlope: htf.dmi.adxSlope,
    });
    total = Math.max(0, total - softGateResult.totalPenalty);
  }

  // ── RETAINED SAFETY GATES: Genuine safety boundaries that should remain hard ──
  // These represent situations where entry is genuinely dangerous, not just marginal.

  // TR contraction + no price confirmation: dying momentum (softened from 0.60 to 0.62)
  if (trContractionPenalty < 0 && recentPriceActionBonus <= 0) {
    total = Math.min(total, 0.62);
  }

  // Direction change detected (PA <= -0.15): price actively reversing
  if (recentPriceActionBonus <= -0.15) {
    total = Math.min(total, 0.60);
  }

  // Exhaustion + consolidation: move spent AND chopping sideways
  if (moveExhaustionPenalty <= -0.06 && consolidationPenalty < 0) {
    total = Math.min(total, 0.58);
  }

  // Severe move exhaustion (2.5+ ATR): almost certainly done
  if (moveExhaustionPenalty <= -0.15) {
    total = Math.min(total, 0.60);
  }

  // Narrow range + extreme position: edge of a tiny box
  if (narrowRangePenalty <= -0.08 && pricePositionAdjustment <= -0.04) {
    total = Math.min(total, 0.60);
  }

  // 0DTE extreme theta (≤ 30 min): too aggressive for new entries
  if (thetaDecayPenalty <= -0.10) {
    total = Math.min(total, 0.55);
  }

  // Exhausted trend with reverting momentum (range exhaustion gates)
  if (ltf && htf) {
    const ltfBars = ltf.bars;
    const htfAtr = htf.atr.atr;
    if (ltfBars.length >= 20 && htfAtr > 0) {
      let dayHigh = -Infinity, dayLow = Infinity;
      for (const b of ltfBars) { if (b.high > dayHigh) dayHigh = b.high; if (b.low < dayLow) dayLow = b.low; }
      const rangeExhaustion = (dayHigh - dayLow) / htfAtr;
      const trendStillStrengthening = (signal.alignment === 'all_aligned' || signal.alignment === 'htf_mtf_aligned')
        && htf.dmi.adx > 25 && htf.dmi.adxSlope > 0;
      if (rangeExhaustion > 12.0 && !trendStillStrengthening) {
        total = Math.min(total, 0.55);
      } else if (rangeExhaustion > 7.0 && !trendStillStrengthening && ltfBars.length >= 10) {
        const dayOpen = ltfBars[0]!.open;
        const recent5 = ltfBars.slice(-5);
        const prior5 = ltfBars.slice(-10, -5);
        const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
        const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
        const dispVelocity = avgRecent - avgPrior;
        if (dispVelocity < 0) {
          total = Math.min(total, 0.55);
        }
      }
    }
  }

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, candlePatternBonus, priceVelocityBonus, volumeSurgeBonus, trendPersistenceBonus: 0, total };
}

/**
 * Compute range-bound (mean-reversion) confidence score.
 * Inverted logic: conditions penalized for trend trading (low ADX, consolidation,
 * near levels) are REWARDED for mean-reversion at range extremes.
 */
function computeRangeConfidence(signal: SignalPayload): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, , htf] = tfs;
  const empty: ConfidenceBreakdown = { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, candlePatternBonus: 0, priceVelocityBonus: 0, volumeSurgeBonus: 0, trendPersistenceBonus: 0, total: 0.38 };
  if (!ltf || !htf || !signal.rangeSupport || !signal.rangeResistance) return empty;

  const base = 0.38;
  const price = signal.currentPrice;
  const rangeSupport = signal.rangeSupport;
  const rangeResistance = signal.rangeResistance;
  const rangeWidth = rangeResistance - rangeSupport;
  if (rangeWidth <= 0) return empty;
  const rangePos = (price - rangeSupport) / rangeWidth;

  // Range position extremity (INVERTED: reward extremes)
  let pricePositionAdjustment = 0;
  if (signal.direction === 'bullish') {
    if (rangePos <= 0.15) pricePositionAdjustment = 0.10;
    else if (rangePos <= 0.25) pricePositionAdjustment = 0.06;
    else if (rangePos <= 0.35) pricePositionAdjustment = 0.03;
  } else {
    if (rangePos >= 0.85) pricePositionAdjustment = 0.10;
    else if (rangePos >= 0.75) pricePositionAdjustment = 0.06;
    else if (rangePos >= 0.65) pricePositionAdjustment = 0.03;
  }

  // VWAP overextension (reward being at/beyond VWAP bands)
  let vwapBonus = 0;
  const { upperBand: htfUpper, lowerBand: htfLower, deviation: htfDev, priceVsVwap } = htf.vwap;
  if (signal.direction === 'bullish') {
    if (price <= htfLower) vwapBonus = 0.08;
    else if (price <= htf.vwap.vwap - htfDev) vwapBonus = 0.04;
    else if (priceVsVwap < 0) vwapBonus = 0.02;
  } else {
    if (price >= htfUpper) vwapBonus = 0.08;
    else if (price >= htf.vwap.vwap + htfDev) vwapBonus = 0.04;
    else if (priceVsVwap > 0) vwapBonus = 0.02;
  }

  // Near level bonus (INVERTED: reward proximity to support/resistance)
  let nearLevelPenalty = 0;
  const ps = htf.priceStructure;
  if (signal.direction === 'bullish') {
    const distToSupport = ps.swingLow > 0 ? ((price - ps.swingLow) / ps.swingLow) * 100 : 999;
    if (distToSupport >= 0 && distToSupport <= 0.15) nearLevelPenalty = 0.08;
    else if (distToSupport >= 0 && distToSupport <= 0.30) nearLevelPenalty = 0.05;
    else if (distToSupport >= 0 && distToSupport <= 0.50) nearLevelPenalty = 0.02;
  } else {
    const distToResist = ps.swingHigh > 0 ? ((ps.swingHigh - price) / ps.swingHigh) * 100 : 999;
    if (distToResist >= 0 && distToResist <= 0.15) nearLevelPenalty = 0.08;
    else if (distToResist >= 0 && distToResist <= 0.30) nearLevelPenalty = 0.05;
    else if (distToResist >= 0 && distToResist <= 0.50) nearLevelPenalty = 0.02;
  }

  // Prior day level alignment
  let structureBonus = 0;
  if (signal.priorDayLevels.pdh > 0) {
    const { pdh, pdl } = signal.priorDayLevels;
    if (signal.direction === 'bullish') {
      const distToPDL = pdl > 0 ? Math.abs(price - pdl) / pdl * 100 : 999;
      if (distToPDL < 0.30) structureBonus = 0.06;
      else if (distToPDL < 0.50) structureBonus = 0.03;
    } else {
      const distToPDH = pdh > 0 ? Math.abs(price - pdh) / pdh * 100 : 999;
      if (distToPDH < 0.30) structureBonus = 0.06;
      else if (distToPDH < 0.50) structureBonus = 0.03;
    }
  }

  // Low ADX confirmation (INVERTED: reward low ADX in range mode)
  let lowVolPenalty = 0;
  if (htf.dmi.adx < 18) lowVolPenalty = 0.06;
  else if (htf.dmi.adx < 22) lowVolPenalty = 0.03;

  // Consolidation confirmation (INVERTED: chop = range)
  let consolidationPenalty = 0;
  if (ltf.bars.length >= 8) {
    const chopBars = ltf.bars.slice(-6);
    const totalBarRange = chopBars.reduce((sum, b) => sum + (b.high - b.low), 0);
    let overallHigh = -Infinity, overallLow = Infinity;
    for (const b of chopBars) { if (b.high > overallHigh) overallHigh = b.high; if (b.low < overallLow) overallLow = b.low; }
    const overallRange = overallHigh - overallLow;
    if (overallRange > 0) {
      const overlapRatio = totalBarRange / overallRange;
      if (overlapRatio >= 2.5) consolidationPenalty = 0.04;
      else if (overlapRatio >= 2.0) consolidationPenalty = 0.02;
    }
  }

  // OBV divergence (classic mean-reversion signal)
  let obvBonus = 0;
  if (signal.direction === 'bullish' && htf.obv.divergence === 'bullish') obvBonus = 0.04;
  else if (signal.direction === 'bearish' && htf.obv.divergence === 'bearish') obvBonus = 0.04;
  if (htf.obv.trend !== signal.direction && htf.obv.trend !== 'neutral') obvBonus += 0.02;
  obvBonus = Math.min(0.06, obvBonus);

  // Recent price action reversal (want bars turning at extreme)
  let recentPriceActionBonus = 0;
  if (ltf.bars.length >= 4) {
    const recentBars = ltf.bars.slice(-3);
    const lastBar = recentBars[recentBars.length - 1]!;
    const isBullish = signal.direction === 'bullish';
    const lastBarConfirms = isBullish ? lastBar.close > lastBar.open : lastBar.close < lastBar.open;
    const priorBars = recentBars.slice(0, -1);
    const priorOpposing = priorBars.filter(b => isBullish ? b.close < b.open : b.close > b.open).length;
    if (lastBarConfirms && priorOpposing >= 2) recentPriceActionBonus = 0.06;
    else if (lastBarConfirms && priorOpposing >= 1) recentPriceActionBonus = 0.03;
  }

  // Small DI spread bonus
  let diSpreadBonus = 0;
  const avgDISpread = tfs.reduce((sum, tf) => {
    const spread = signal.direction === 'bullish'
      ? tf.dmi.plusDI - tf.dmi.minusDI
      : tf.dmi.minusDI - tf.dmi.plusDI;
    return sum + spread;
  }, 0) / tfs.length;
  if (avgDISpread > 0) diSpreadBonus = Math.min(0.03, avgDISpread / 40 * 0.03);

  // Range width check
  let narrowRangePenalty = 0;
  const rangeWidthPct = rangeWidth / price * 100;
  if (rangeWidthPct < 0.20) narrowRangePenalty = -0.15;
  else if (rangeWidthPct < 0.30) narrowRangePenalty = -0.08;

  // PENALTIES: conditions that invalidate range trading
  let adxBonus = 0;
  if (htf.dmi.adx >= 30) adxBonus = -0.15;
  else if (htf.dmi.adx >= 25) adxBonus = -0.10;
  else if (htf.dmi.adx >= 22 && htf.dmi.adxSlope > 2) adxBonus = -0.06;

  let trendPhaseBonus = 0;
  if (htf.dmi.adxSlope > 4) trendPhaseBonus = -0.10;
  else if (htf.dmi.adxSlope > 2) trendPhaseBonus = -0.05;

  let orbBonus = 0;
  if (signal.orb.orbFormed && signal.orb.breakoutDirection !== 'none') {
    if (signal.orb.breakoutDirection !== signal.direction) orbBonus = -0.06;
    else orbBonus = 0.02;
  }

  let moveExhaustionPenalty = 0;
  if (signal.direction === 'bullish' && price < rangeSupport) moveExhaustionPenalty = -0.12;
  else if (signal.direction === 'bearish' && price > rangeResistance) moveExhaustionPenalty = -0.12;

  const diCrossBonus = 0;
  const alignmentBonus = 0;
  const tdAdjustment = 0;
  const oiVolumeBonus = 0;
  const adxMaturityPenalty = 0;
  const momentumAccelBonus = 0;
  const trContractionPenalty = 0;
  const thetaDecayPenalty = 0;

  // ── Leading indicators for range mode ──
  // Candle patterns at range extremes are high-value reversal signals
  let candlePatternBonus = 0;
  if (signal.direction !== 'neutral') {
    const isBull = signal.direction === 'bullish';
    const htfCp = htf.allCandlePatterns;
    // Reversal candle at range extreme = strong mean-reversion signal
    if (isBull && htfCp.hammer.present && rangePos <= 0.25) candlePatternBonus = 0.06;
    else if (isBull && htfCp.bullishEngulfing.present && rangePos <= 0.35) candlePatternBonus = 0.06;
    else if (!isBull && htfCp.shootingStar.present && rangePos >= 0.75) candlePatternBonus = 0.06;
    else if (!isBull && htfCp.bearishEngulfing.present && rangePos >= 0.65) candlePatternBonus = 0.06;
    // Opposing pattern (continuation instead of reversal)
    if (isBull && htfCp.bearishEngulfing.present) candlePatternBonus -= 0.04;
    if (!isBull && htfCp.bullishEngulfing.present) candlePatternBonus -= 0.04;
    candlePatternBonus = Math.max(-0.04, Math.min(0.06, candlePatternBonus));
  }

  // Price velocity: for range trades, we want velocity OPPOSING the signal direction
  // (price moved far in one direction → expect reversion). Velocity in signal direction
  // at range extreme = still moving away, not yet reverting.
  let priceVelocityBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const pv = ltf.priceVelocity;
    const isBull = signal.direction === 'bullish';
    const dirVel = pv.directionalVelocity;
    const aligned = isBull ? dirVel > 0 : dirVel < 0;
    // For range: reward when velocity is starting to align (bounce beginning)
    if (aligned && Math.abs(dirVel) > 0.04) priceVelocityBonus = 0.04;
    else if (aligned && Math.abs(dirVel) > 0.02) priceVelocityBonus = 0.02;
    priceVelocityBonus = Math.max(0, Math.min(0.04, priceVelocityBonus));
  }

  // Volume surge at range extremes = institutional interest in the bounce
  let volumeSurgeBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const vs = ltf.volumeSurge;
    if (vs.recentVolumeRatio > 1.5 && vs.surgeConfirmsDirection) volumeSurgeBonus = 0.04;
    else if (vs.recentVolumeRatio > 1.3 && vs.volumeTrend === 'increasing') volumeSurgeBonus = 0.02;
    volumeSurgeBonus = Math.max(0, Math.min(0.04, volumeSurgeBonus));
  }

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty + candlePatternBonus + priceVelocityBonus + volumeSurgeBonus));

  // Hard gates for range mode
  if (htf.dmi.adx >= 28) total = Math.min(total, 0.50);
  else if (htf.dmi.adx >= 25) total = Math.min(total, 0.58);
  if (htf.dmi.adxSlope > 5) total = Math.min(total, 0.55);
  if (rangeWidthPct < 0.20) total = Math.min(total, 0.45);
  if (recentPriceActionBonus < 0) total = Math.min(total, 0.58);
  // ADX slope rising (>2) = trend emerging, don't fade it
  if (trendPhaseBonus <= -0.05) total = Math.min(total, 0.55);
  // Opposing ORB + weak reversal candle = breakout against the range trade
  if (orbBonus <= -0.06 && recentPriceActionBonus <= 0.03) total = Math.min(total, 0.58);
  // VWAP overextension required: range entries without VWAP support (price not overextended
  // vs VWAP in the mean-reversion direction) lack conviction. All March range winners had
  // vwapBonus > 0; entries without it consistently failed.
  if (vwapBonus <= 0) total = Math.min(total, 0.55);
  // High choppiness = frequent direction flips = unreliable support/resistance.
  // Feb+Mar data: 0/12 range winners had choppiness >= 1.3, but 6/27 losers did.
  // Compute choppiness from LTF bars: count direction flips vs expected flips.
  if (ltf && ltf.bars.length >= 15) {
    const chopBarsAll = ltf.bars;
    let flips = 0;
    let prevDir: 'up' | 'down' | null = null;
    for (let i = 1; i < chopBarsAll.length; i++) {
      const dir = chopBarsAll[i]!.close > chopBarsAll[i - 1]!.close ? 'up' : 'down';
      if (prevDir && dir !== prevDir) flips++;
      prevDir = dir;
    }
    const expectedFlips = Math.max(1, chopBarsAll.length / 15);
    const chopRatio = flips / expectedFlips;
    if (chopRatio >= 1.3) total = Math.min(total, 0.55);
  }

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, candlePatternBonus, priceVelocityBonus, volumeSurgeBonus, trendPersistenceBonus: 0, total };
}

/**
 * Compute breakout (squeeze breakout) confidence score.
 * Rewards: fresh level break, rising ADX from low base, volume confirmation,
 * tight prior range (stored energy), confirming price action.
 * Penalizes: false breakouts (wick back), too far beyond level (chasing),
 * ADX already high (not a squeeze), opposing ORB.
 */
function computeBreakoutConfidence(signal: SignalPayload): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  const empty: ConfidenceBreakdown = { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, candlePatternBonus: 0, priceVelocityBonus: 0, volumeSurgeBonus: 0, trendPersistenceBonus: 0, total: 0.38 };
  if (!ltf || !mtf || !htf || !signal.breakoutLevel) return empty;

  const base = 0.38;
  const price = signal.currentPrice;
  const beyondPct = signal.breakoutBeyond ?? 0;

  // ── ADX slope bonus: rising ADX from low base = new trend forming ──
  // This is THE key breakout signal — ADX was dormant and is now waking up.
  let adxBonus = 0;
  if (htf.dmi.adxSlope > 3) adxBonus = 0.08;
  else if (htf.dmi.adxSlope > 1.5) adxBonus = 0.05;
  else if (htf.dmi.adxSlope > 0) adxBonus = 0.02;

  // ── DI cross bonus: fresh cross in breakout direction = timing confirmation ──
  let diCrossBonus = 0;
  const htfAligned = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
  const mtfAligned = signal.direction === 'bullish' ? mtf.dmi.crossedUp : mtf.dmi.crossedDown;
  if (htfAligned) diCrossBonus += 0.06;
  if (mtfAligned) diCrossBonus += 0.03;
  diCrossBonus = Math.min(0.09, diCrossBonus);

  // ── DI spread bonus: DI spread confirming breakout direction ──
  let diSpreadBonus = 0;
  const avgDISpread = tfs.reduce((sum, tf) => {
    const spread = signal.direction === 'bullish'
      ? tf.dmi.plusDI - tf.dmi.minusDI
      : tf.dmi.minusDI - tf.dmi.plusDI;
    return sum + spread;
  }, 0) / tfs.length;
  diSpreadBonus = Math.max(-0.05, Math.min(0.08, (avgDISpread / 30) * 0.08));

  // ── OBV confirmation: volume supporting the breakout ──
  let obvBonus = 0;
  if (htf.obv.trend === signal.direction) obvBonus += 0.04;
  if (mtf.obv.trend === signal.direction) obvBonus += 0.02;
  obvBonus = Math.min(0.06, obvBonus);

  // ── Breakout freshness: closer to level = fresher breakout ──
  // pricePositionAdjustment: reward fresh breakouts, penalize chasing
  let pricePositionAdjustment = 0;
  if (beyondPct <= 0.10) pricePositionAdjustment = 0.08;      // just barely broke through
  else if (beyondPct <= 0.20) pricePositionAdjustment = 0.04;  // still fresh
  else if (beyondPct <= 0.30) pricePositionAdjustment = 0.00;  // acceptable
  else pricePositionAdjustment = -0.06;                         // getting far, chasing

  // ── Prior range tightness: tighter range = more stored energy ──
  // Use narrowRangePenalty field (repurposed as bonus for breakout)
  let narrowRangePenalty = 0;
  if (signal.priorDayLevels.pdh > 0) {
    const ps = htf.priceStructure;
    const swingRange = ps.swingHigh - ps.swingLow;
    const swingRangePct = price > 0 ? (swingRange / price) * 100 : 0;
    // Tighter prior range = more stored energy = better breakout
    if (swingRangePct < 0.30) narrowRangePenalty = 0.06;
    else if (swingRangePct < 0.50) narrowRangePenalty = 0.03;
  }

  // ── Recent price action: bars confirming breakout direction ──
  let recentPriceActionBonus = 0;
  if (ltf.bars.length >= 4) {
    const recentBars = ltf.bars.slice(-3);
    const isBullish = signal.direction === 'bullish';
    const confirmingBars = recentBars.filter(b => isBullish ? b.close > b.open : b.close < b.open).length;
    const netMove = recentBars[recentBars.length - 1]!.close - recentBars[0]!.open;
    const netConfirms = isBullish ? netMove > 0 : netMove < 0;
    if (confirmingBars >= 3 && netConfirms) recentPriceActionBonus = 0.08;
    else if (confirmingBars >= 2 && netConfirms) recentPriceActionBonus = 0.04;
    else if (!netConfirms) recentPriceActionBonus = -0.06;  // price action opposing breakout
  }

  // ── Alignment bonus ──
  const alignmentBonusMap: Record<string, number> = { all_aligned: 0.06, htf_mtf_aligned: 0.03, mtf_ltf_aligned: 0.02, mixed: 0 };
  const alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;

  // ── VWAP alignment: breakout in VWAP direction = confirmation ──
  let vwapBonus = 0;
  const pvv = htf.vwap.priceVsVwap;
  if (signal.direction === 'bullish' && pvv > 0) vwapBonus = 0.03;
  else if (signal.direction === 'bearish' && pvv < 0) vwapBonus = 0.03;
  else if (signal.direction === 'bullish' && pvv < -0.3) vwapBonus = -0.04;
  else if (signal.direction === 'bearish' && pvv > 0.3) vwapBonus = -0.04;

  // ── ORB alignment ──
  let orbBonus = 0;
  if (signal.orb.orbFormed && signal.orb.breakoutDirection !== 'none') {
    if (signal.orb.breakoutDirection === signal.direction) orbBonus = 0.04;
    else orbBonus = -0.06;
  }

  // ── Structure bonus: breaking above PDH (bullish) or below PDL (bearish) ──
  let structureBonus = 0;
  if (signal.priorDayLevels.pdh > 0) {
    const { abovePDH, belowPDL } = signal.priorDayLevels;
    if (signal.direction === 'bullish' && abovePDH) structureBonus = 0.06;
    else if (signal.direction === 'bearish' && belowPDL) structureBonus = 0.06;
    // Breaking opposite way is not inherently bad for breakout (just no bonus)
  }

  // ── PENALTIES ──
  // ADX already high = this isn't a squeeze, it's a continuation
  let trendPhaseBonus = 0;
  if (htf.dmi.adx >= 25) trendPhaseBonus = -0.08;  // not a squeeze
  else if (htf.dmi.adx >= 22) trendPhaseBonus = -0.04;

  // Unused fields
  const tdAdjustment = 0;
  const oiVolumeBonus = 0;
  const adxMaturityPenalty = 0;
  const momentumAccelBonus = 0;
  const trContractionPenalty = 0;
  const lowVolPenalty = 0;
  const moveExhaustionPenalty = 0;
  const consolidationPenalty = 0;
  const nearLevelPenalty = 0;
  const thetaDecayPenalty = 0;

  // ── Leading indicators for breakout mode ──
  // Engulfing candle at breakout level = confirmation of breakout conviction
  let candlePatternBonus = 0;
  if (signal.direction !== 'neutral') {
    const isBull = signal.direction === 'bullish';
    // Check all TFs for engulfing in breakout direction
    for (let i = 0; i < tfs.length; i++) {
      const tf = tfs[i]!;
      const cp = tf.allCandlePatterns;
      const weight = i === 2 ? 0.05 : i === 1 ? 0.03 : 0.02;
      if (isBull && cp.bullishEngulfing.present) candlePatternBonus += weight;
      if (!isBull && cp.bearishEngulfing.present) candlePatternBonus += weight;
    }
    candlePatternBonus = Math.min(0.08, candlePatternBonus);
  }

  // Price velocity: breakouts need STRONG velocity — price should be moving fast
  let priceVelocityBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const pv = ltf.priceVelocity;
    const isBull = signal.direction === 'bullish';
    const dirVel = pv.directionalVelocity;
    const aligned = isBull ? dirVel > 0 : dirVel < 0;
    const absVel = Math.abs(dirVel);
    if (aligned && absVel > 0.10) priceVelocityBonus = 0.06;
    else if (aligned && absVel > 0.06) priceVelocityBonus = 0.04;
    else if (aligned && absVel > 0.03) priceVelocityBonus = 0.02;
    // Acceleration: momentum building = genuine breakout
    if (pv.acceleration > 0.03) priceVelocityBonus += 0.02;
    priceVelocityBonus = Math.max(0, Math.min(0.08, priceVelocityBonus));
  }

  // Volume surge: breakouts REQUIRE volume to be genuine
  // A level break without volume = false breakout
  let volumeSurgeBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const vs = ltf.volumeSurge;
    if (vs.recentVolumeRatio > 2.0 && vs.surgeConfirmsDirection) volumeSurgeBonus = 0.08;
    else if (vs.recentVolumeRatio > 1.5 && vs.surgeConfirmsDirection) volumeSurgeBonus = 0.06;
    else if (vs.recentVolumeRatio > 1.3 && vs.volumeTrend === 'increasing') volumeSurgeBonus = 0.03;
    else if (vs.recentVolumeRatio < 0.7) volumeSurgeBonus = -0.04;  // no volume = likely false breakout
    volumeSurgeBonus = Math.max(-0.04, Math.min(0.08, volumeSurgeBonus));
  }

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty + candlePatternBonus + priceVelocityBonus + volumeSurgeBonus));

  // Hard gates
  if (htf.dmi.adx >= 25) total = Math.min(total, 0.60);  // not a squeeze, use trend mode
  if (recentPriceActionBonus <= -0.06) total = Math.min(total, 0.58);  // price opposing breakout
  if (beyondPct > 0.35) total = Math.min(total, 0.58);  // too far, chasing
  // Cap breakout confidence at 0.85 — Feb+Mar data: conf > 0.85 was 0W/3L (all F).
  // The breakout model sums many small bonuses that compound to overconfident signals.
  total = Math.min(total, 0.85);
  // No structure support = breakout not at a key prior-day level, lower conviction.
  if (structureBonus <= 0) total = Math.min(total, 0.78);

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, candlePatternBonus, priceVelocityBonus, volumeSurgeBonus, trendPersistenceBonus: 0, total };
}

/**
 * Determine desired option right from signal direction
 */
function deriveDesiredRight(signal: SignalPayload): 'call' | 'put' | null {
  if (signal.direction === 'bullish') return 'call';
  if (signal.direction === 'bearish') return 'put';
  return null;
}

/**
 * Call Claude Haiku for a plain-language explanation of the indicators.
 * This is purely explanatory — Claude does NOT change confidence or direction.
 */
async function generateExplanation(
  signal: SignalPayload,
  option: OptionEvaluation,
  cb: ConfidenceBreakdown
): Promise<{ aiExplanation: string; keyFactors: string[]; risks: string[] }> {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;

  const htfPs = htf?.priceStructure;
  const payload = {
    ticker: signal.ticker,
    profile: signal.profile,
    direction: signal.direction,
    alignment: signal.alignment,
    confidence: cb.total.toFixed(2),
    price_position: {
      range_position: htfPs ? parseFloat(htfPs.rangePosition.toFixed(2)) : 0.5,
      price_half: htfPs?.priceHalf ?? 'lower',
      swing_high: htfPs?.swingHigh ?? 0,
      swing_low: htfPs?.swingLow ?? 0,
      price_position_adjustment: cb.pricePositionAdjustment.toFixed(3),
      recent_price_action_bonus: cb.recentPriceActionBonus.toFixed(3),
      tr_contraction_penalty: cb.trContractionPenalty.toFixed(3),
      low_vol_penalty: cb.lowVolPenalty.toFixed(3),
      move_exhaustion_penalty: cb.moveExhaustionPenalty.toFixed(3),
      consolidation_penalty: cb.consolidationPenalty.toFixed(3),
      near_level_penalty: cb.nearLevelPenalty.toFixed(3),
      theta_decay_penalty: cb.thetaDecayPenalty.toFixed(3),
      narrow_range_penalty: cb.narrowRangePenalty.toFixed(3),
      candle_pattern_bonus: cb.candlePatternBonus.toFixed(3),
      price_velocity_bonus: cb.priceVelocityBonus.toFixed(3),
      volume_surge_bonus: cb.volumeSurgeBonus.toFixed(3),
      note: htfPs?.priceHalf === 'lower'
        ? 'Price in lower half of range — puts preferred, calls are higher risk'
        : 'Price in upper half of range — calls preferred, puts are higher risk',
    },
    timeframes: tfs.map(tf => {
      const { vwap: tfVwap, upperBand: tfUpper, lowerBand: tfLower, deviation: tfDev } = tf.vwap;
      const tfPrice = tf.currentPrice;
      const vwapBandPosition =
        tfPrice > tfUpper             ? 'above_2sigma' :
        tfPrice > tfVwap + tfDev      ? 'above_1sigma' :
        tfPrice < tfLower             ? 'below_2sigma' :
        tfPrice < tfVwap - tfDev      ? 'below_1sigma' : 'near_vwap';
      const diCross =
        tf.dmi.convergenceCrossUp  ? 'bullish_convergence' :
        tf.dmi.convergenceCrossDown ? 'bearish_convergence' :
        tf.dmi.growthCrossUp  ? 'bullish_growth' :
        tf.dmi.growthCrossDown ? 'bearish_growth' :
        tf.dmi.crossedUp   ? 'bullish' :
        tf.dmi.crossedDown ? 'bearish' : 'none';
      return {
      tf: tf.timeframe,
      diPlus: tf.dmi.plusDI.toFixed(1),
      diMinus: tf.dmi.minusDI.toFixed(1),
      adx: tf.dmi.adx.toFixed(1),
      adxStrength: tf.dmi.adxStrength,
      trend: tf.dmi.trend,
      adx_slope: parseFloat(tf.dmi.adxSlope.toFixed(1)),
      di_spread_slope: parseFloat(tf.dmi.diSpreadSlope.toFixed(1)),
      di_cross: diCross,
      fast_di_cross: tf.fastDmi.recentCrossUp ? 'bullish' : tf.fastDmi.recentCrossDown ? 'bearish' : 'none',
      di_converging: tf.dmi.diConverging,
      obv_trend: tf.obv.trend,
      obv_divergence: tf.obv.divergence,
      td_setup: tf.td.setup,
      td_countdown: tf.td.countdown,
      vwap_band_position: vwapBandPosition,
      // Individual pattern flags for explicit formatting rules
      hammer: {
        present: tf.allCandlePatterns.hammer.present,
        type: tf.allCandlePatterns.hammer.present ? 'bullish_hammer' : null,
      },
      shooting_star: {
        present: tf.allCandlePatterns.shootingStar.present,
        type: tf.allCandlePatterns.shootingStar.present ? 'shooting_star' : null,
      },
      bullish_engulfing: {
        present: tf.allCandlePatterns.bullishEngulfing.present,
        type: tf.allCandlePatterns.bullishEngulfing.present ? 'bullish_engulfing' : null,
      },
      bearish_engulfing: {
        present: tf.allCandlePatterns.bearishEngulfing.present,
        type: tf.allCandlePatterns.bearishEngulfing.present ? 'bearish_engulfing' : null,
      },
      price_velocity: {
        roc: parseFloat(tf.priceVelocity.roc.toFixed(3)),
        roc_short: parseFloat(tf.priceVelocity.rocShort.toFixed(3)),
        directional_velocity: parseFloat(tf.priceVelocity.directionalVelocity.toFixed(4)),
        acceleration: parseFloat(tf.priceVelocity.acceleration.toFixed(4)),
      },
      volume_surge: {
        volume_ratio: parseFloat(tf.volumeSurge.volumeRatio.toFixed(2)),
        recent_volume_ratio: parseFloat(tf.volumeSurge.recentVolumeRatio.toFixed(2)),
        volume_trend: tf.volumeSurge.volumeTrend,
      },
      };
    }),
    market_structure: {
      prior_day: signal.priorDayLevels.pdh > 0
        ? {
            pdh: signal.priorDayLevels.pdh,
            pdl: signal.priorDayLevels.pdl,
            pdc: signal.priorDayLevels.pdc,
            above_pdh: signal.priorDayLevels.abovePDH,
            below_pdl: signal.priorDayLevels.belowPDL,
            structure_bias: signal.priorDayLevels.structureBias,
            structure_bonus: cb.structureBonus.toFixed(3),
          }
        : null,
      orb: signal.orb.orbFormed
        ? {
            orb_high: signal.orb.orbHigh,
            orb_low: signal.orb.orbLow,
            range_size_pct: signal.orb.rangeSizePct.toFixed(3),
            breakout_direction: signal.orb.breakoutDirection,
            breakout_strength: signal.orb.breakoutStrength.toFixed(2),
            orb_bonus: cb.orbBonus.toFixed(3),
          }
        : { orb_formed: false },
    },
    option: option.winnerCandidate
      ? {
          side: option.winnerCandidate.contract.side,
          symbol: option.winnerCandidate.contract.symbol,
          strike: option.winnerCandidate.contract.strike,
          delta: option.winnerCandidate.contract.delta,
          spread_pct: option.winnerCandidate.contract.spreadPct?.toFixed(2),
          entry: option.winnerCandidate.entryPremium,
          stop: option.winnerCandidate.stopPremium,
          tp: option.winnerCandidate.tpPremium,
          rr: option.winnerCandidate.rrRatio?.toFixed(2),
          volume: option.winnerCandidate.contract.volume,
          open_interest: option.winnerCandidate.contract.openInterest,
          vol_to_oi: option.winnerCandidate.contract.openInterest > 0
            ? (option.winnerCandidate.contract.volume / option.winnerCandidate.contract.openInterest).toFixed(2)
            : null,
          oi_volume_bonus: cb.oiVolumeBonus,
        }
      : null,
  };

  // Label timeframes for the prompt (LTF=first, MTF=second, HTF=third)
  const ltfLabel = ltf?.timeframe ?? 'LTF';
  const mtfLabel = mtf?.timeframe ?? 'MTF';
  const htfLabel = htf?.timeframe ?? 'HTF';

  const system = loadSkillTemplate('analysis-agent', {
    HTF_LABEL: htfLabel,
    MTF_LABEL: mtfLabel,
    LTF_LABEL: ltfLabel,
  });

  try {
    const msg = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 512,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });

    const text = msg.choices[0]?.message?.content ?? '{}';
    // Strip markdown code fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean) as { explanation?: string; keyFactors?: string[]; risks?: string[] };
    return {
      aiExplanation: parsed.explanation ?? 'No explanation available.',
      keyFactors: parsed.keyFactors ?? [],
      risks: parsed.risks ?? [],
    };
  } catch {
    return {
      aiExplanation: 'Explanation unavailable (AI error).',
      keyFactors: [`Direction: ${signal.direction}`, `Alignment: ${signal.alignment}`, `Confidence: ${cb.total.toFixed(2)}`],
      risks: ['Unable to generate risk assessment'],
    };
  }
}

export class AnalysisAgent {
  async run(signal: SignalPayload, option: OptionEvaluation, timeGateOk = true, tickerCfg?: import('../ticker-configs.js').TickerConfig): Promise<AnalysisResult> {
    // Use per-symbol strategy if available, otherwise fall back to internal router
    let cb: ConfidenceBreakdown;
    if (tickerCfg?.strategy) {
      const strategy = tickerCfg.strategy;
      cb = signal.signalMode === 'vwap_reversion'
        ? strategy.computeRangeConfidence(signal) // VWAP reversion uses range confidence model
        : signal.signalMode === 'range'
          ? strategy.computeRangeConfidence(signal)
          : signal.signalMode === 'breakout'
            ? strategy.computeBreakoutConfidence(signal)
            : strategy.computeTrendConfidence(signal, option);
    } else {
      cb = computeConfidence(signal, option);
    }

    // ── Compute all 4 mode confidences for dashboard transparency ──
    // The winning mode's confidence (cb) is already computed above.
    // Compute the remaining 3 modes so the dashboard can show all scores.
    const computeAll = tickerCfg?.strategy ?? { computeTrendConfidence: computeTrendConfidenceFn, computeRangeConfidence: computeRangeConfidenceFn, computeBreakoutConfidence: computeBreakoutConfidenceFn };
    const allModeConfidences = {
      trend: signal.signalMode === 'trend' ? cb.total : computeAll.computeTrendConfidence(signal, option).total,
      range: signal.signalMode === 'range' ? cb.total : computeAll.computeRangeConfidence(signal).total,
      breakout: signal.signalMode === 'breakout' ? cb.total : computeAll.computeBreakoutConfidence(signal).total,
      vwap_reversion: signal.signalMode === 'vwap_reversion' ? cb.total : computeAll.computeRangeConfidence(signal).total,
    };

    // ── Regime clarity penalty: soft multiplier when mode='none' fell through ──
    // When no mode qualified (regimeClarity near 0), apply a penalty proportional
    // to the ambiguity. This replaces the hard mode='none' → WAIT short-circuit.
    // regimeClarity 0.0 → penalty ~0.08 (reduces 0.65 → 0.57, usually blocks entry)
    // regimeClarity 0.4 → penalty ~0.04 (mild reduction, strong signals still pass)
    // regimeClarity 0.6+ → penalty ~0.02 (minimal impact)
    const regimeClarity = signal.regimeClarity ?? 1.0;
    if (regimeClarity < 0.6) {
      const regimePenalty = (0.6 - regimeClarity) * 0.13; // max ~0.08 at clarity=0
      cb = { ...cb, total: Math.max(0, cb.total - regimePenalty) };
      console.log(`[AnalysisAgent] ${signal.ticker} regime clarity penalty: clarity=${regimeClarity.toFixed(2)} → -${(regimePenalty * 100).toFixed(1)}% (total=${(cb.total * 100).toFixed(0)}%)`);
    }

    // ── Signal convergence: reward fresh multi-family convergence ──
    {
      const conv = computeConvergence(signal.timeframes, signal.direction);
      const convAdj = convergenceAdjustment(conv);
      if (convAdj !== 0) {
        cb = { ...cb, total: Math.max(0, Math.min(1, cb.total + convAdj)) };
        if (Math.abs(convAdj) >= 0.02) {
          console.log(`[AnalysisAgent] ${signal.ticker} convergence: ${conv.freshCount} fresh / ${conv.totalConfirming} confirming → ${convAdj >= 0 ? '+' : ''}${(convAdj * 100).toFixed(1)}% (total=${(cb.total * 100).toFixed(0)}%)`);
        }
      }
    }

    // ── Cross-ticker consensus: divergence detection only ──
    // Positive boost removed (inflated stale entries, dropped direction 72%→68%).
    // Value is in detecting when other indices DISAGREE — genuine warning signal.
    {
      const consensus = getCrossTickerBus().computeConsensus(signal.ticker, signal.direction);
      if (consensus.adjustment < 0 && consensus.total > 0) {
        cb = { ...cb, total: Math.max(0, cb.total + consensus.adjustment) };
        const tickers = consensus.details.map(d => `${d.ticker}:${d.agrees ? '✓' : '✗'}`).join(' ');
        console.log(`[AnalysisAgent] ${signal.ticker} cross-ticker divergence: ${consensus.disagreeing}/${consensus.total} disagree → ${(consensus.adjustment * 100).toFixed(1)}% [${tickers}] (total=${(cb.total * 100).toFixed(0)}%)`);
      }
    }

    // ── Build per-symbol entry context (shared by adjustConfidence + shouldAllowEntry) ──
    // Uses shared computeEntryMetrics() — single source of truth for dvel/rExh/choppiness.
    let displacementVelocity: number | undefined;
    let rangeExhaustion: number | undefined;
    let choppiness: number | undefined;
    {
      const ltfBars = signal.timeframes[0]?.bars;
      const htfAtr = (signal.timeframes[2] ?? signal.timeframes[0])?.atr.atr ?? 0;
      if (ltfBars && ltfBars.length >= 10) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayBars = ltfBars.filter(b => b.timestamp.startsWith(todayStr));
        const metrics = computeEntryMetrics(todayBars, htfAtr);
        if (metrics) {
          displacementVelocity = metrics.displacementVelocity;
          rangeExhaustion = metrics.rangeExhaustion;
          choppiness = metrics.choppiness;
        }
      }
    }

    const entryCtx = {
      signalMode: signal.signalMode ?? 'none',
      direction: signal.direction,
      alignment: signal.alignment,
      confidence: cb.total,
      breakdown: cb,
      strengthScore: signal.strengthScore,
      currentPrice: signal.currentPrice,
      atr: signal.atr,
      displacementVelocity,
      rangeExhaustion,
      choppiness,
    };

    // Per-symbol confidence adjustment hook
    if (tickerCfg?.strategy?.adjustConfidence) {
      cb = tickerCfg.strategy.adjustConfidence(cb, entryCtx);
      entryCtx.confidence = cb.total;
      entryCtx.breakdown = cb;
    }

    // ── Trend persistence bonus: reward consecutive same-direction aligned signals ──
    // Instead of tuning individual penalties (day-specific whack-a-mole), this is a
    // meta-signal: when the market keeps confirming the same direction across multiple
    // pipeline runs, the penalties for "chasing" (pos, mex) are less relevant because
    // the trend is genuinely persisting.  +0.03 per consecutive aligned bar, capped +0.12.
    // Only counts signals with alignment >= htf_mtf_aligned to avoid noise.
    // Only for trend/breakout modes — range/vwap_reversion are mean-reversion, not trend continuation.
    // Require structure support (structureBonus > 0) — persistence can overcome additive penalties
    // (pos, mex) but shouldn't override hard structural gates (no prior-day level backing).
    // Skipped when directEntry — confidence is the sole signal, no post-hoc adjustments.
    const persistenceMode = signal.signalMode ?? 'none';
    if (!tickerCfg?.directEntry && signal.direction !== 'neutral' && (persistenceMode === 'trend' || persistenceMode === 'breakout') && cb.structureBonus > 0) {
      try {
        const recentSignals = await getRecentSignals(signal.ticker, 10);
        let consecutiveCount = 0;
        for (const s of recentSignals) {
          if (s.direction === signal.direction &&
              (s.alignment === 'all_aligned' || s.alignment === 'htf_mtf_aligned')) {
            consecutiveCount++;
          } else {
            break;
          }
        }
        if (consecutiveCount >= 2) {
          const persistenceBonus = Math.min(0.12, (consecutiveCount - 1) * 0.03);
          let agingReduction = 0;
          // When persistence is strong (3+ consecutive aligned signals), halve negative
          // maturity/phase/accel penalties.  Persistent all-timeframe alignment directly
          // contradicts "trend is dying" — the trend keeps producing aligned signals.
          // Without this, maturity + phase + accel triple-count the same "aging" story
          // and block entries on genuinely persisting trends (QQQ/IWM/SPY 2026-03-30).
          if (persistenceBonus >= 0.06) {
            const matRed = cb.adxMaturityPenalty < 0 ? -cb.adxMaturityPenalty * 0.5 : 0;
            const phRed = cb.trendPhaseBonus < 0 ? -cb.trendPhaseBonus * 0.5 : 0;
            const accRed = cb.momentumAccelBonus < 0 ? -cb.momentumAccelBonus * 0.5 : 0;
            agingReduction = matRed + phRed + accRed;
            cb = { ...cb,
              adxMaturityPenalty: cb.adxMaturityPenalty < 0 ? cb.adxMaturityPenalty * 0.5 : cb.adxMaturityPenalty,
              trendPhaseBonus: cb.trendPhaseBonus < 0 ? cb.trendPhaseBonus * 0.5 : cb.trendPhaseBonus,
              momentumAccelBonus: cb.momentumAccelBonus < 0 ? cb.momentumAccelBonus * 0.5 : cb.momentumAccelBonus,
            };
          }
          cb = { ...cb, trendPersistenceBonus: persistenceBonus, total: Math.max(0, Math.min(1, cb.total + persistenceBonus + agingReduction)) };
          entryCtx.confidence = cb.total;
          entryCtx.breakdown = cb;
          if (persistenceBonus > 0) {
            console.log(`[AnalysisAgent] ${signal.ticker} trend persistence: ${consecutiveCount} consecutive ${signal.direction} aligned signals → +${(persistenceBonus * 100).toFixed(0)}% bonus${agingReduction > 0 ? ` (aging halved: +${(agingReduction * 100).toFixed(0)}%)` : ''}`);
          }
        }
      } catch {
        // DB query failure — proceed without persistence bonus
      }
    }

    // Dynamic entry threshold: when directEntry, use plain minConfidence with no overrides.
    // Otherwise, when leading indicators have already confirmed direction, lower threshold
    // from 0.65 to 0.60 for 5-15 bar earlier entry.
    const baseMinConf = tickerCfg?.minConfidence ?? config.MIN_CONFIDENCE;
    let minConf = baseMinConf;
    if (!tickerCfg?.directEntry) {
      const hasActiveLeadingSignals = (cb.candlePatternBonus > 0 || cb.priceVelocityBonus > 0 || cb.volumeSurgeBonus > 0);
      const leadingOverrideActive = signal.leadingSignalOverride && hasActiveLeadingSignals;
      if (leadingOverrideActive) {
        minConf = Math.max(baseMinConf - 0.05, 0.55);
        console.log(`[AnalysisAgent] ${signal.ticker} leading signal override: threshold ${(baseMinConf * 100).toFixed(0)}% → ${(minConf * 100).toFixed(0)}% (candle=${cb.candlePatternBonus.toFixed(3)} vel=${cb.priceVelocityBonus.toFixed(3)} vol=${cb.volumeSurgeBonus.toFixed(3)})`);
      }
    }
    let meetsEntryThreshold = cb.total >= minConf;
    let entryBlockReason: string | undefined;

    if (!meetsEntryThreshold) {
      entryBlockReason = `confidence ${(cb.total * 100).toFixed(0)}% < ${(minConf * 100).toFixed(0)}% threshold`;
    }

    // Per-symbol entry time window — block entries outside configured window
    if (meetsEntryThreshold && tickerCfg) {
      const now = new Date();
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(now);
      const etHour = parseInt(etParts.find(p => p.type === 'hour')!.value, 10);
      const etMin = parseInt(etParts.find(p => p.type === 'minute')!.value, 10);
      const minsSinceOpen = (etHour * 60 + etMin) - (9 * 60 + 30);
      if (minsSinceOpen < tickerCfg.entryWindowStartMin || minsSinceOpen > tickerCfg.entryWindowEndMin) {
        entryBlockReason = `entry window blocked: ${etHour}:${String(etMin).padStart(2, '0')} ET (${minsSinceOpen}m since open) outside [${tickerCfg.entryWindowStartMin}-${tickerCfg.entryWindowEndMin}]`;
        console.log(`[AnalysisAgent] ${signal.ticker} ${entryBlockReason}`);
        meetsEntryThreshold = false;
      }
    }

    // Per-symbol entry filter hook — can block entries even if confidence meets threshold
    if (meetsEntryThreshold && tickerCfg?.strategy?.shouldAllowEntry) {
      const filterResult = tickerCfg.strategy.shouldAllowEntry(entryCtx);
      if (filterResult !== true) {
        entryBlockReason = filterResult;
        console.log(`[AnalysisAgent] ${signal.ticker} entry filter blocked: ${filterResult} | mode=${entryCtx.signalMode} dir=${entryCtx.direction} conf=${(entryCtx.confidence * 100).toFixed(0)}% atrPct=${signal.currentPrice > 0 ? ((signal.atr / signal.currentPrice) * 100).toFixed(3) : '?'}% dvel=${entryCtx.displacementVelocity?.toFixed(4) ?? '?'} chop=${entryCtx.choppiness?.toFixed(2) ?? '?'} rExh=${entryCtx.rangeExhaustion?.toFixed(1) ?? '?'} trendPhase=${entryCtx.breakdown.trendPhaseBonus.toFixed(3)} struct=${entryCtx.breakdown.structureBonus.toFixed(3)} diSpread=${entryCtx.breakdown.diSpreadBonus.toFixed(3)}`);
        meetsEntryThreshold = false;
      }
    }
    const desiredRight = deriveDesiredRight(signal);

    // rangeExhaustion already computed above for entryCtx

    let aiExplanation = 'Market closed or confidence below threshold — AI explanation skipped.';
    let keyFactors: string[] = [];
    let risks: string[] = [];

    // Only generate AI explanation when confidence meets the entry threshold
    // AND the market is open — saves quota on pre/post-market ticks
    if (meetsEntryThreshold && timeGateOk) {
      const ai = await generateExplanation(signal, option, cb);
      aiExplanation = ai.aiExplanation;
      keyFactors = ai.keyFactors;
      risks = ai.risks;
    }

    return {
      signalId: signal.id,
      confidence: cb.total,
      confidenceBreakdown: cb,
      allModeConfidences,
      selectedMode: signal.signalMode ?? 'none',
      meetsEntryThreshold,
      entryBlockReason,
      aiExplanation,
      keyFactors,
      risks,
      desiredRight,
      rangeExhaustion,
      createdAt: new Date().toISOString(),
    };
  }
}
