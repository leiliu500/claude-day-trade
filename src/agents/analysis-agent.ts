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
    return { base: 0.40, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, total: 0.40 };
  }

  // Base: slight bullish bias
  const base = signal.direction === 'bullish' ? 0.45 : 0.40;

  // DI spread bonus — average of |DI+ - DI-| across all TFs, scaled 0..0.25
  const avgDISpread = tfs.reduce((sum, tf) => sum + Math.abs(tf.dmi.plusDI - tf.dmi.minusDI), 0) / tfs.length;
  const diSpreadBonus = Math.min((avgDISpread / 40) * 0.25, 0.25);

  // ADX bonus: HTF ADX > 25
  const adxBonus = htf.dmi.adx > 25 ? 0.05 : 0;

  // DI cross bonus — fresh DI crossover on the most recent bar is a strong timing signal.
  // HTF aligned cross: +0.05 | MTF aligned cross: +0.03  (cap +0.06 combined)
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
    diCrossBonus = Math.max(-0.06, Math.min(0.06, diCrossBonus));
  }

  // Alignment bonus
  const alignmentBonusMap: Record<string, number> = {
    all_aligned: 0.10,
    htf_mtf_aligned: 0.05,
    mtf_ltf_aligned: 0.02,
    mixed: 0,
  };
  const alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;

  // TD adjustment
  let tdAdjustment = 0;
  for (const tf of tfs) {
    const setup = tf.td.setup;
    // Penalize if opposing setup completed
    if (setup.completed) {
      const opposingDir = signal.direction === 'bullish' ? 'sell' : 'buy';
      if (setup.completedDirection === opposingDir) tdAdjustment -= 0.05;
    }
    // Bonus if early confirming setup (count 1-4)
    if (setup.count >= 1 && setup.count <= 4 && !setup.completed) {
      const confirmDir = signal.direction === 'bullish' ? 'buy' : 'sell';
      if (setup.direction === confirmDir) tdAdjustment += 0.01;
    }
  }
  tdAdjustment = Math.max(-0.05, Math.min(0.03, tdAdjustment));

  // OBV bonus — HTF and MTF only; LTF OBV is too noisy to score
  // +0.015 per TF whose OBV trend matches signal direction (max +0.03)
  // -0.03 if any HTF/MTF shows OBV divergence against signal direction
  let obvBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      if (tf.obv.trend === signal.direction) obvBonus += 0.015;
      const badDivergence =
        (signal.direction === 'bullish' && tf.obv.divergence === 'bearish') ||
        (signal.direction === 'bearish' && tf.obv.divergence === 'bullish');
      if (badDivergence) obvBonus -= 0.03;
    }
    obvBonus = Math.max(-0.03, Math.min(0.03, obvBonus));
  }

  // VWAP bonus — HTF and MTF direction alignment + HTF band extension penalty.
  // Direction alignment (HTF + MTF): +0.02 per TF where price is on the correct VWAP side;
  //   -0.02 per TF where price is significantly on the wrong side (|priceVsVwap| > 0.2%)
  // Band extension penalty (HTF only — most reliable anchor):
  //   Price beyond 2σ band in entry direction → -0.06 (overextended, mean-reversion risk)
  //   Price beyond 1σ band in entry direction → -0.02 (somewhat extended)
  // Clamped -0.08..+0.06
  let vwapBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      const pvv = tf.vwap.priceVsVwap;
      if (signal.direction === 'bullish') {
        if (pvv > 0) vwapBonus += 0.02;
        else if (pvv < -0.2) vwapBonus -= 0.02;
      } else {
        if (pvv < 0) vwapBonus += 0.02;
        else if (pvv > 0.2) vwapBonus -= 0.02;
      }
    }
    // Band extension check on HTF — entering when price is already beyond a VWAP band
    // risks catching a mean-reversion move rather than a trend continuation.
    const { vwap: htfVwap, upperBand: htfUpper, lowerBand: htfLower, deviation: htfDev } = htf.vwap;
    const htfPrice = htf.currentPrice;
    if (signal.direction === 'bullish') {
      if (htfPrice > htfUpper)                 vwapBonus -= 0.06; // beyond 2σ — very overextended
      else if (htfPrice > htfVwap + htfDev)    vwapBonus -= 0.02; // beyond 1σ — somewhat extended
    } else {
      if (htfPrice < htfLower)                 vwapBonus -= 0.06; // beyond 2σ below VWAP
      else if (htfPrice < htfVwap - htfDev)    vwapBonus -= 0.02; // beyond 1σ below VWAP
    }
    vwapBonus = Math.max(-0.08, Math.min(0.06, vwapBonus));
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

  // Price position adjustment — penalizes counter-range trades (higher risk).
  // Uses HTF rangePosition: 0.0 = at swing low, 1.0 = at swing high.
  //   Bullish/call in lower half: calls are higher risk → penalty up to -0.10
  //   Bearish/put in upper half: puts are higher risk → penalty up to -0.10
  //   Lower half prefers puts; upper half prefers calls.
  let pricePositionAdjustment = 0;
  const htfRangePosition = htf.priceStructure.rangePosition;
  if (signal.direction === 'bullish' && htfRangePosition < 0.5) {
    // Calling bullish from the lower half — fighting the range position
    pricePositionAdjustment = Math.max(-0.10, -(0.5 - htfRangePosition) * 0.20);
  } else if (signal.direction === 'bearish' && htfRangePosition > 0.5) {
    // Calling bearish from the upper half — fighting the range position
    pricePositionAdjustment = Math.max(-0.10, -(htfRangePosition - 0.5) * 0.20);
  }

  const total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment));

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, total };
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
        tf.dmi.crossedUp   ? 'bullish' :
        tf.dmi.crossedDown ? 'bearish' : 'none';
      return {
      tf: tf.timeframe,
      diPlus: tf.dmi.plusDI.toFixed(1),
      diMinus: tf.dmi.minusDI.toFixed(1),
      adx: tf.dmi.adx.toFixed(1),
      adxStrength: tf.dmi.adxStrength,
      trend: tf.dmi.trend,
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
