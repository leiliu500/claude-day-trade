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
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) {
    return { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, total: 0.38 };
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
  const diSpreadBonus = Math.max(-0.15, Math.min(0.15, (avgDISpread / 40) * 0.15));

  // ADX bonus: HTF ADX > 25
  const adxBonus = htf.dmi.adx > 25 ? 0.05 : 0;

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
    diCrossBonus = Math.max(-0.06, Math.min(0.10, diCrossBonus));
  }

  // Alignment bonus
  const alignmentBonusMap: Record<string, number> = {
    all_aligned: 0.06,
    htf_mtf_aligned: 0.03,
    mtf_ltf_aligned: 0.02,
    mixed: 0,
  };
  const alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;

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
  //   Bullish from upper half: price already extended up, limited upside → penalty up to -0.08
  //   Bearish from lower half: price already extended down, limited downside → penalty up to -0.08
  //   Bullish from lower half / bearish from upper half = following momentum with room to run (no penalty).
  // Mutually exclusive with adxMaturityPenalty: both measure the same "extended trend" condition.
  // When adxMaturityPenalty already applies, skip this to avoid double-penalizing valid trend entries.
  let pricePositionAdjustment = 0;
  if (adxMaturityPenalty === 0) {
    const htfRangePosition = htf.priceStructure.rangePosition;
    if (signal.direction === 'bullish' && htfRangePosition > 0.5) {
      // Bullish from upper half — price already extended, limited upside
      pricePositionAdjustment = Math.max(-0.08, -(htfRangePosition - 0.5) * 0.16);
    } else if (signal.direction === 'bearish' && htfRangePosition < 0.5) {
      // Bearish from lower half — price already extended down, limited downside
      pricePositionAdjustment = Math.max(-0.08, -(0.5 - htfRangePosition) * 0.16);
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
        recentPriceActionBonus = -0.15;
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
    const htfRecentCross = signal.direction === 'bullish' ? htf.dmi.recentCrossUp : htf.dmi.recentCrossDown;
    if (!htfRecentCross) {
      if (htf.dmi.adx < 15) {
        lowVolPenalty = -0.10;
      } else if (htf.dmi.adx < 20) {
        lowVolPenalty = -0.05;
      }
      // When price action confirms direction, ADX is lagging — halve the penalty.
      // The bars are clearly moving in the signal direction, just ADX hasn't caught up.
      if (lowVolPenalty < 0 && recentPriceActionBonus > 0) {
        lowVolPenalty = lowVolPenalty / 2;
      }
    }
  }

  // Move exhaustion penalty — detects when a large directional move has already played out.
  // Uses HTF bars to measure the recent move magnitude relative to ATR.
  // After a big move (e.g. $3 drop on SPY), lagging indicators still read "strong trend" but
  // entering is chasing — most of the edge is gone and a bounce/consolidation is likely.
  //   Move ≥ 3.0× ATR in signal direction: -0.12 (major move complete, extreme chasing risk)
  //   Move ≥ 2.0× ATR: -0.08 (large move, high chasing risk)
  //   Move ≥ 1.5× ATR: -0.04 (moderate move, some chasing risk)
  // Skipped when a fresh HTF DI cross is present (cross = new phase, not exhaustion).
  // Clamped -0.12..0
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
        if (moveATRs >= 3.0) {
          moveExhaustionPenalty = -0.12;
        } else if (moveATRs >= 2.0) {
          moveExhaustionPenalty = -0.08;
        } else if (moveATRs >= 1.5) {
          moveExhaustionPenalty = -0.04;
        }
        // When price action confirms direction (bars actively continuing the move),
        // halve the penalty — this is fresh momentum extending the move, not chasing.
        if (recentPriceActionBonus > 0 && moveExhaustionPenalty < 0) {
          moveExhaustionPenalty = moveExhaustionPenalty / 2;
        }
      }
    }
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
  if (signal.direction !== 'neutral' && ltf && ltf.bars.length >= 8 && recentPriceActionBonus < 0.04) {
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
    // When price action confirms the move (bars actively pushing through the level),
    // halve the penalty — this distinguishes a breakdown from a bounce approach.
    if (activeBreakdown && nearLevelPenalty < 0) {
      nearLevelPenalty = nearLevelPenalty / 2;
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

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty));

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
  if (adxMaturityPenalty <= -0.15) {
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
  if (moveExhaustionPenalty <= -0.08 && consolidationPenalty < 0) {
    total = Math.min(total, 0.58);
  }

  // Hard gate: 0DTE with extreme theta (≤ 30 min to close).
  // Even with strong signals, the theta burn is too aggressive for new entries.
  if (thetaDecayPenalty <= -0.10) {
    total = Math.min(total, 0.55);
  }

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, total };
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
