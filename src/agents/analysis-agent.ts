import OpenAI from 'openai';
import { config } from '../config.js';
import { loadSkillTemplate } from '../utils/skill-loader.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult, ConfidenceBreakdown } from '../types/analysis.js';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

/**
 * Compute deterministic confidence score from signal data.
 * Range: 0.00 – 1.00
 */
function computeConfidence(signal: SignalPayload, option: OptionEvaluation): ConfidenceBreakdown {
  // Range mode uses inverted confidence model
  if (signal.signalMode === 'range') {
    return computeRangeConfidence(signal);
  }
  // Breakout mode: squeeze breakout from consolidation
  if (signal.signalMode === 'breakout') {
    return computeBreakoutConfidence(signal);
  }

  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) {
    return { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, total: 0.38 };
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
    // Discount cross bonus when HTF ADX is low AND declining — a cross in a fading
    // low-ADX market is unreliable (loser #5: ADX=13, slope=-2.1).
    // Any positive ADX slope means trend is emerging — trust the cross.
    if (diCrossBonus > 0 && htf.dmi.adx < 20 && htf.dmi.adxSlope <= 0) {
      diCrossBonus *= 0.50; // half credit for crosses in low-ADX with declining momentum
    }
    // DI Cross without established trend is unreliable — cap at +0.05
    if (diCrossBonus > 0.05 && htf.dmi.adx < 25) diCrossBonus = 0.05;
    diCrossBonus = Math.max(-0.06, Math.min(0.10, diCrossBonus));
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
  // High ADX (>= 40) with fading momentum = exhaustion trap — amplify maturity penalty.
  if (adxMaturityPenalty < 0 && htf.dmi.adx >= 40 && htf.dmi.adxSlope < 0) {
    adxMaturityPenalty *= 1.5;
  } else if (adxMaturityPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) {
    const dirSpread = signal.direction === 'bullish'
      ? htf.dmi.plusDI - htf.dmi.minusDI
      : htf.dmi.minusDI - htf.dmi.plusDI;
    if (dirSpread > 0 && htf.dmi.diSpreadSlope > 0) {
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
        const atExtreme = (signal.direction === 'bullish' && rp >= 0.80) || (signal.direction === 'bearish' && rp <= 0.20);
        if (atExtreme) {
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
        // However, when ALL timeframes align + momentum still accelerating AND the
        // exhaustion is moderate (not severe 2.5+ ATR), the trend may be continuing.
        if (moveExhaustionPenalty > -0.15 && moveExhaustionPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20 && momentumAccelBonus > 0) {
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
      nearLevelPenalty *= 0.5;
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
  }

  // DI Spread cap for aged trends: in a mature trend the DI spread reflects sustained
  // momentum, not fresh signal. Cap to prevent inflated confidence on stale setups.
  if (adxMaturityPenalty <= -0.04) diSpreadBonus = Math.min(diSpreadBonus, 0.06);

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty));

  // Hard gate: no structure support — every backtest winner had Structure >= +0.06.
  // Losers often had 0 or negative structure (wrong side of prior-day levels).
  if (structureBonus <= 0) total = Math.min(total, 0.68);
  if (structureBonus < 0) total = Math.min(total, 0.62);

  // Hard gate: low ADX strength — weak trend, unreliable signal.
  // ADX < 15: no established trend to ride. ADX 15-20: marginal, cap below threshold.
  if (htf.dmi.adx < 15) total = Math.min(total, 0.55);
  else if (htf.dmi.adx < 20) total = Math.min(total, 0.64);

  // Hard gate: TR contraction (instant momentum fade) without price confirmation
  // is a dying trend — cap confidence below entry threshold (0.65).
  // Uses raw TR (instant, no smoothing lag) instead of lagging ADX-based isExhaustingTrend.
  // Skipped when recent price action confirms direction (recentPriceActionBonus > 0)
  // AND TR is only moderately contracted — genuine re-acceleration shows expanding bars.
  if (trContractionPenalty < 0 && recentPriceActionBonus <= 0) {
    total = Math.min(total, 0.60);
  }

  // Hard gate: extremely mature trend (20+ bars above ADX 25) without fresh price
  // action confirmation.  At this stage, lagging indicators peak while the underlying
  // trend is most likely to reverse.  Even with all bonuses stacking, entering this
  // late is a losing proposition — cap below entry threshold.
  // Relaxed to 0.64 (just below 0.65) when price action actively confirms, since
  // rare cases of genuine trend continuation do exist but should still require
  // elevated confidence from other factors to pass.
  // Exempt all_aligned — genuine trend continuation across all timeframes.
  if (adxMaturityPenalty <= -0.15 && signal.alignment !== 'all_aligned') {
    if (recentPriceActionBonus > 0) {
      total = Math.min(total, 0.64);
    } else {
      total = Math.min(total, 0.55);
    }
  }

  // Hard gate: direction change detected — the most recent bar flipped against the
  // signal while lagging indicators (DMI/ADX) still show a strong trend.  This is
  // the exact moment when confidence peaks but price has already reversed.
  // Cap confidence below entry threshold to prevent entries at reversal points.
  if (recentPriceActionBonus <= -0.15) {
    total = Math.min(total, 0.60);
  }

  // Hard gate: move already exhausted + consolidation.  When a large move has played out
  // AND price is now chopping sideways, the setup is spent — even strong indicators are
  // just reflecting the completed move, not predicting continuation.
  if (moveExhaustionPenalty <= -0.06 && consolidationPenalty < 0) {
    total = Math.min(total, 0.58);
  }

  // Hard gate: severe move exhaustion (2.5+ ATR).  At this magnitude, the move is almost
  // certainly done regardless of what other indicators say.  Cap below entry threshold.
  if (moveExhaustionPenalty <= -0.15) {
    total = Math.min(total, 0.60);
  }

  // Hard gate: mature trend + exhaustion.  When ADX has been above 25 for 10+ bars AND
  // the move is 1.0+ ATR extended, the trend is late-stage and stretched — entering now
  // is chasing the tail end.  PA still reads "confirming" but the edge is gone.
  if (adxMaturityPenalty <= -0.08 && moveExhaustionPenalty <= -0.06) {
    total = Math.min(total, 0.62);
  }

  // Hard gate: very severe ADX maturity (post-halving still >= 7%).  Trend ran 20+ bars
  // above ADX 25 — even with the all_aligned halving benefit, this much aging means the
  // easy money is gone and reversal risk is high.
  if (adxMaturityPenalty <= -0.07) {
    total = Math.min(total, 0.64);
  }

  // Hard gate: aged trend stalling without price confirmation.  Maturity 10+ bars above
  // ADX 25 + consolidation + no recent confirming bars = the trend is running out of
  // steam with no new directional conviction.
  if (adxMaturityPenalty <= -0.06 && consolidationPenalty <= -0.04 && recentPriceActionBonus <= 0) {
    total = Math.min(total, 0.64);
  }

  // Hard gate: range position extreme — entering at the edge of the HTF range.
  // Buying calls at >85% range position or puts at <15% is chasing the last move.
  // Loser #2 (93%), #4 (81% + nearLevel), #6 (9%) all failed from range extremes.
  // Exempt when strong active trend (ADX > 25 + rising) — genuine breakout/breakdown.
  {
    const rp = htf.priceStructure.rangePosition;
    const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0;
    const extremeGateApplies = !strongActiveTrend && htf.dmi.adx >= 15;
    const atExtreme = (signal.direction === 'bullish' && rp >= 0.85) || (signal.direction === 'bearish' && rp <= 0.15);
    // Also exempt all_aligned — genuine trend across all timeframes pushes price to range edge.
    if (atExtreme && extremeGateApplies && !(signal.alignment === 'all_aligned' && htf.dmi.adx >= 20)) {
      total = Math.min(total, 0.62);
    }
    // Softer gate: near extreme + DI spread narrowing = fading momentum at boundary
    const nearExtreme = (signal.direction === 'bullish' && rp >= 0.75) || (signal.direction === 'bearish' && rp <= 0.25);
    if (nearExtreme && htf.dmi.diSpreadSlope < -3 && htf.dmi.adx >= 15) {
      total = Math.min(total, 0.64);
    }
  }

  // Hard gate: narrow range + approaching range extreme.  On a tight-range day,
  // being near the ceiling (bullish) or floor (bearish) means price is at the edge
  // of a tiny box — mean-reversion is almost certain.  Cap below entry threshold.
  if (narrowRangePenalty <= -0.08 && pricePositionAdjustment <= -0.04) {
    total = Math.min(total, 0.60);
  }

  // Hard gate: 0DTE with extreme theta (≤ 30 min to close).
  // Even with strong signals, the theta burn is too aggressive for new entries.
  if (thetaDecayPenalty <= -0.10) {
    total = Math.min(total, 0.55);
  }

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, total };
}

/**
 * Compute range-bound (mean-reversion) confidence score.
 * Inverted logic: conditions penalized for trend trading (low ADX, consolidation,
 * near levels) are REWARDED for mean-reversion at range extremes.
 */
function computeRangeConfidence(signal: SignalPayload): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, , htf] = tfs;
  const empty: ConfidenceBreakdown = { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, total: 0.38 };
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

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty));

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

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, total };
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
  const empty: ConfidenceBreakdown = { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, total: 0.38 };
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

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty));

  // Hard gates
  if (htf.dmi.adx >= 25) total = Math.min(total, 0.60);  // not a squeeze, use trend mode
  if (recentPriceActionBonus <= -0.06) total = Math.min(total, 0.58);  // price opposing breakout
  if (beyondPct > 0.35) total = Math.min(total, 0.58);  // too far, chasing

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, total };
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
  async run(signal: SignalPayload, option: OptionEvaluation, timeGateOk = true): Promise<AnalysisResult> {
    const cb = computeConfidence(signal, option);
    const meetsEntryThreshold = cb.total >= config.MIN_CONFIDENCE;
    const desiredRight = deriveDesiredRight(signal);

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
      meetsEntryThreshold,
      aiExplanation,
      keyFactors,
      risks,
      desiredRight,
      createdAt: new Date().toISOString(),
    };
  }
}
