/**
 * ExecutionAgent — sizing computation + pre-order safety gate check.
 *
 * No longer submits orders or manages position lifecycle.
 * All Alpaca calls now live in src/lib/alpaca-api.ts.
 * Order submission and lifecycle are handled by OrderAgent.
 *
 * Single public method:
 *   prepareEntry() → { sizing, passed, failedGates }
 */

import { config } from '../config.js';
import { checkSafetyGates } from '../pipeline/safety-gates.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { OptionEvaluation } from '../types/options.js';
import type { DecisionResult } from '../types/decision.js';
import type { SizeResult, ConvictionTier } from '../types/trade.js';
import type { SignalPayload } from '../types/signal.js';

function computeConvictionScore(signal: SignalPayload, analysis: AnalysisResult, option: OptionEvaluation): number {
  let score = 0;

  if (signal.alignment === 'all_aligned')          score += 2;
  else if (signal.alignment === 'htf_mtf_aligned') score += 1;

  if (analysis.confidence >= 0.80) score += 2;
  else if (analysis.confidence >= 0.70) score += 1;

  const htf = signal.timeframes[signal.timeframes.length - 1];
  if (htf && htf.dmi.adx > 25)                 score += 1;
  if (htf && htf.dmi.adxStrength === 'strong')  score += 1;

  const rr = option.winnerCandidate?.rrRatio ?? 0;
  if (rr >= 2.0) score += 1;

  const sp = option.winnerCandidate?.contract.spreadPct ?? 999;
  if (sp < 0.5) score += 1;

  return Math.min(score, 10);
}

function computeSizing(
  convictionScore: number,
  entryPremium: number,
  stopPremium: number,
  accountEquity: number,
  accountBuyingPower: number,
): SizeResult {
  const tier: ConvictionTier =
    convictionScore >= 7 ? 'MAX_CONVICTION' :
    convictionScore >= 4 ? 'SIZABLE' :
    'REGULAR';

  const multiplier      = tier === 'MAX_CONVICTION' ? 1.5 : tier === 'SIZABLE' ? 1.25 : 1;
  const baseRisk        = accountEquity * config.MAX_RISK_PCT;
  const effectiveRisk   = baseRisk * multiplier;
  const riskPerContract = (entryPremium - stopPremium) * 100;

  let qty = riskPerContract > 0 ? Math.floor(effectiveRisk / riskPerContract) : 1;
  qty = Math.max(1, Math.min(qty, config.MAX_CONTRACTS));

  const totalCost = qty * entryPremium * 100;
  if (totalCost > accountBuyingPower) {
    qty = Math.max(1, Math.floor(accountBuyingPower / (entryPremium * 100)));
  }

  return {
    qty,
    convictionScore,
    convictionTier:   tier,
    baseRiskUsd:      baseRisk,
    effectiveRiskUsd: effectiveRisk,
    riskPerContract,
    limitPrice:       Math.round(entryPremium * 100) / 100,
  };
}

export class ExecutionAgent {
  /**
   * Compute conviction score + position sizing, then run all 8 safety gates.
   * Returns the sizing result and whether the entry is cleared to proceed.
   *
   * Does NOT submit any orders — that is delegated to OrderAgent.
   * Receives the orchestrator's DecisionResult as the primary input.
   */
  prepareEntry(params: {
    decision: DecisionResult;        // orchestrator AI output (primary input)
    signal: SignalPayload;
    option: OptionEvaluation;
    analysis: AnalysisResult;
    accountEquity: number;
    accountBuyingPower: number;
    dailyRealizedPnl: number;
    timeGateOk: boolean;
  }): { sizing: SizeResult | null; passed: boolean; failedGates: string[] } {
    const { decision, signal, option, analysis, accountEquity, accountBuyingPower, dailyRealizedPnl, timeGateOk } = params;
    const candidate = option.winnerCandidate;

    if (!candidate) {
      return { sizing: null, passed: false, failedGates: ['NO_CANDIDATE'] };
    }

    const convictionScore = computeConvictionScore(signal, analysis, option);
    const sizing = computeSizing(
      convictionScore,
      candidate.entryPremium,
      candidate.stopPremium,
      accountEquity,
      accountBuyingPower,
    );

    const gates = checkSafetyGates({
      timeGateOk,
      analysis,
      option,
      decision,
      accountBuyingPower,
      accountEquity,
      dailyRealizedPnl,
      proposedQty:  sizing.qty,
      proposedCost: sizing.qty * candidate.entryPremium * 100,
    });

    if (!gates.passed) {
      console.warn('[ExecutionAgent] Safety gates failed:', gates.failedGates);
      return { sizing, passed: false, failedGates: gates.failedGates };
    }

    return { sizing, passed: true, failedGates: [] };
  }
}
