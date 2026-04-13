import OpenAI from 'openai';
import { config } from '../config.js';
import { loadSkillTemplate } from '../utils/skill-loader.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult, ConfidenceBreakdown } from '../types/analysis.js';
import { getRecentSignals } from '../db/repositories/signals.js';
import { computeEntryMetrics } from '../lib/entry-context.js';

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
    return computeRangeConfidence(signal);
  }

  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  const empty: ConfidenceBreakdown = { base: 0.40, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, candlePatternBonus: 0, priceVelocityBonus: 0, volumeSurgeBonus: 0, trendPersistenceBonus: 0, total: 0.40 };
  if (!ltf || !mtf || !htf) return empty;

  // ── SIMPLIFIED PRICE-ACTION CONFIDENCE MODEL ──────────────────────────────
  // 8 primary non-lagging factors + 4 protective filters.
  // Lagging DMI/ADX-derived factors set to 0 for backward compat.
  const base = 0.40;

  // ── Eliminated lagging factors (set to 0) ──
  const diSpreadBonus = 0;
  const adxBonus = 0;

  const diCrossBonus = 0;

  // Alignment bonus — from price-action based alignment (VWAP + velocity + structure)
  const alignmentBonusMap: Record<string, number> = {
    all_aligned: 0.08,
    htf_mtf_aligned: 0.04,
    mtf_ltf_aligned: 0.02,
    mixed: 0,
  };
  const alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;

  const tdAdjustment = 0;
  const obvBonus = 0;

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
    vwapBonus = Math.max(-0.12, Math.min(0.12, vwapBonus));
  }

  const oiVolumeBonus = 0;

  const adxMaturityPenalty = 0;
  {
  }

  const trendPhaseBonus = 0;
  const momentumAccelBonus = 0;

  // Price position adjustment — penalizes entering extended in range.
  let pricePositionAdjustment = 0;
  {
    const htfRangePosition = htf.priceStructure.rangePosition;
    // Strong velocity = genuine breakout, exempt from extreme penalty
    const strongVelocity = Math.abs(ltf.priceVelocity.directionalVelocity) > 0.06;
    if (signal.direction === 'bullish' && htfRangePosition > 0.5) {
      if (htfRangePosition >= 0.85 && !strongVelocity) {
        pricePositionAdjustment = signal.alignment === 'all_aligned' ? -0.06 : -0.10;
      } else {
        pricePositionAdjustment = Math.max(-0.08, -(htfRangePosition - 0.5) * 0.16);
      }
    } else if (signal.direction === 'bearish' && htfRangePosition < 0.5) {
      if (htfRangePosition <= 0.15 && !strongVelocity) {
        pricePositionAdjustment = signal.alignment === 'all_aligned' ? -0.06 : -0.10;
      } else {
        pricePositionAdjustment = Math.max(-0.08, -(0.5 - htfRangePosition) * 0.16);
      }
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
    structureBonus = Math.max(-0.08, Math.min(0.08, structureBonus));
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
        recentPriceActionBonus = signal.alignment === 'all_aligned' ? -0.08 : -0.15;
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
      // Suppress positive price action at range extreme + VWAP overextended
      if (recentPriceActionBonus > 0) {
        const rp = htf.priceStructure.rangePosition;
        const atExtreme = (signal.direction === 'bullish' && rp >= 0.80) || (signal.direction === 'bearish' && rp <= 0.20);
        const vwapOverextended = Math.abs(htf.vwap.priceVsVwap) > 0.30;
        if (atExtreme && vwapOverextended) {
          recentPriceActionBonus = 0;
        }
      }
    }
  }

  const trContractionPenalty = 0;

  const lowVolPenalty = 0;

  const moveExhaustionPenalty = 0;
  const consolidationPenalty = 0;

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
    // Exempt when strong velocity across TFs confirms genuine breakout through level
    if (nearLevelPenalty < 0) {
      const ltfVel = Math.abs(ltf.priceVelocity.directionalVelocity);
      const htfVel = Math.abs(htf.priceVelocity.directionalVelocity);
      if (ltfVel > 0.04 && htfVel > 0.04 && signal.alignment === 'all_aligned') {
        nearLevelPenalty = 0;
      }
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
    priceVelocityBonus = Math.max(-0.08, Math.min(0.10, priceVelocityBonus));
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
    volumeSurgeBonus = Math.max(-0.04, Math.min(0.08, volumeSurgeBonus));
  }

  // ── Total + simplified hard gates ──────────────────────────────────────────
  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty + candlePatternBonus + priceVelocityBonus + volumeSurgeBonus));

  // Hard gate: direction change — last bar reversed while prior bars confirmed
  if (recentPriceActionBonus <= -0.15) total = Math.min(total, 0.60);

  // Hard gate: extreme theta decay (≤ 30 min to close)
  if (thetaDecayPenalty <= -0.10) total = Math.min(total, 0.55);

  // Hard gate: narrow range + range extreme — stuck at edge of tiny box
  if (narrowRangePenalty <= -0.08 && pricePositionAdjustment <= -0.04) total = Math.min(total, 0.60);

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

  // Low velocity confirmation (reward low velocity in range mode)
  let lowVolPenalty = 0;
  const ltfAbsVel = Math.abs(ltf.priceVelocity.directionalVelocity);
  if (ltfAbsVel < 0.02) lowVolPenalty = 0.06;
  else if (ltfAbsVel < 0.04) lowVolPenalty = 0.03;

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

  const diSpreadBonus = 0;

  // Range width check
  let narrowRangePenalty = 0;
  const rangeWidthPct = rangeWidth / price * 100;
  if (rangeWidthPct < 0.20) narrowRangePenalty = -0.15;
  else if (rangeWidthPct < 0.30) narrowRangePenalty = -0.08;

  // PENALTIES: strong directional velocity invalidates range trading
  let adxBonus = 0;
  const htfAbsVel = Math.abs(htf.priceVelocity.directionalVelocity);
  if (htfAbsVel > 0.08) adxBonus = -0.15;
  else if (htfAbsVel > 0.06) adxBonus = -0.10;
  else if (htfAbsVel > 0.04) adxBonus = -0.06;

  let trendPhaseBonus = 0;
  if (ltf.priceVelocity.acceleration > 0.04) trendPhaseBonus = -0.10;
  else if (ltf.priceVelocity.acceleration > 0.02) trendPhaseBonus = -0.05;

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
  if (htfAbsVel > 0.08) total = Math.min(total, 0.50);
  if (rangeWidthPct < 0.20) total = Math.min(total, 0.45);
  if (recentPriceActionBonus < 0) total = Math.min(total, 0.58);
  if (trendPhaseBonus <= -0.05) total = Math.min(total, 0.55);
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

  // ── Velocity acceleration: price accelerating through the level ──
  let adxBonus = 0;
  if (ltf.priceVelocity.acceleration > 0.06) adxBonus = 0.06;
  else if (ltf.priceVelocity.acceleration > 0.04) adxBonus = 0.04;
  else if (ltf.priceVelocity.acceleration > 0.02) adxBonus = 0.02;

  const diCrossBonus = 0;
  const diSpreadBonus = 0;

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
  // Declining velocity = breakout losing steam
  let trendPhaseBonus = 0;
  if (ltf.priceVelocity.acceleration < -0.03) trendPhaseBonus = -0.08;
  else if (ltf.priceVelocity.acceleration < -0.01) trendPhaseBonus = -0.04;

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

    // Simple threshold check — no persistence bonus or dynamic threshold in price-action model
    const minConf = tickerCfg?.minConfidence ?? config.MIN_CONFIDENCE;
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
