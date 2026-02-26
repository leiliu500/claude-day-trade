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
function computeConfidence(signal: SignalPayload, _option: OptionEvaluation): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) {
    return { base: 0.40, diSpreadBonus: 0, adxBonus: 0, alignmentBonus: 0, tdAdjustment: 0, total: 0.40 };
  }

  // Base: slight bullish bias
  const base = signal.direction === 'bullish' ? 0.45 : 0.40;

  // DI spread bonus — average of |DI+ - DI-| across all TFs, scaled 0..0.25
  const avgDISpread = tfs.reduce((sum, tf) => sum + Math.abs(tf.dmi.plusDI - tf.dmi.minusDI), 0) / tfs.length;
  const diSpreadBonus = Math.min((avgDISpread / 40) * 0.25, 0.25);

  // ADX bonus: HTF ADX > 25
  const adxBonus = htf.dmi.adx > 25 ? 0.05 : 0;

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
      if (setup.direction === opposingDir) tdAdjustment -= 0.05;
    }
    // Bonus if early confirming setup (count 1-4)
    if (setup.count >= 1 && setup.count <= 4 && !setup.completed) {
      const confirmDir = signal.direction === 'bullish' ? 'buy' : 'sell';
      if (setup.direction === confirmDir) tdAdjustment += 0.01;
    }
  }
  tdAdjustment = Math.max(-0.05, Math.min(0.03, tdAdjustment));

  const total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + alignmentBonus + tdAdjustment));

  return { base, diSpreadBonus, adxBonus, alignmentBonus, tdAdjustment, total };
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

  const payload = {
    ticker: signal.ticker,
    profile: signal.profile,
    direction: signal.direction,
    alignment: signal.alignment,
    confidence: cb.total.toFixed(2),
    timeframes: tfs.map(tf => ({
      tf: tf.timeframe,
      diPlus: tf.dmi.plusDI.toFixed(1),
      diMinus: tf.dmi.minusDI.toFixed(1),
      adx: tf.dmi.adx.toFixed(1),
      trend: tf.dmi.trend,
      td_setup: tf.td.setup,
      td_countdown: tf.td.countdown,
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
    })),
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
  async run(signal: SignalPayload, option: OptionEvaluation): Promise<AnalysisResult> {
    const cb = computeConfidence(signal, option);
    const meetsEntryThreshold = cb.total >= config.MIN_CONFIDENCE;
    const desiredRight = deriveDesiredRight(signal);

    let aiExplanation = 'Confidence below threshold — AI explanation skipped.';
    let keyFactors: string[] = [];
    let risks: string[] = [];

    // Only generate AI explanation when confidence meets the entry threshold —
    // below-threshold signals will be skipped by the orchestrator bypass anyway
    if (meetsEntryThreshold) {
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
