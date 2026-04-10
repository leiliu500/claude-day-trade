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
import type { TickerConfig } from '../ticker-configs.js';
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
  spread: number,
  tickerCfg?: TickerConfig,
): SizeResult {
  const tier: ConvictionTier =
    convictionScore >= 7 ? 'MAX_CONVICTION' :
    convictionScore >= 4 ? 'SIZABLE' :
    'REGULAR';

  const multiplier      = tier === 'MAX_CONVICTION' ? 1.5 : tier === 'SIZABLE' ? 1.25 : 1;
  const maxRiskPct = tickerCfg?.maxRiskPct ?? config.MAX_RISK_PCT;
  const maxContracts = tickerCfg?.maxContracts ?? config.MAX_CONTRACTS;
  const baseRisk        = accountEquity * maxRiskPct;
  const effectiveRisk   = baseRisk * multiplier;
  const riskPerContract = (entryPremium - stopPremium) * 100;

  let qty = riskPerContract > 0 ? Math.floor(effectiveRisk / riskPerContract) : 1;
  qty = Math.max(1, Math.min(qty, maxContracts));

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
    limitPrice:       Math.round((entryPremium + 0.30 * spread) * 100) / 100,
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
    dailyPremiumDeployed: number;
    timeGateOk: boolean;
    tickerCfg?: TickerConfig;
  }): { sizing: SizeResult | null; passed: boolean; failedGates: string[] } {
    const { decision, signal, option, analysis, accountEquity, accountBuyingPower, dailyRealizedPnl, dailyPremiumDeployed, timeGateOk, tickerCfg } = params;
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
      candidate.contract.spread,
      tickerCfg,
    );

    // LTF ATR% for volatility spike gate — LTF is timeframes[0]
    const ltfAtrPct = signal.timeframes[0]?.atr.atrPct;

    const gates = checkSafetyGates({
      timeGateOk,
      analysis,
      option,
      decision,
      accountBuyingPower,
      accountEquity,
      dailyRealizedPnl,
      dailyPremiumDeployed,
      proposedQty:  sizing.qty,
      proposedCost: sizing.qty * candidate.entryPremium * 100,
      ltfAtrPct,
      tickerCfg,
    });

    if (!gates.passed) {
      console.warn('[ExecutionAgent] Safety gates failed:', gates.failedGates);
      return { sizing, passed: false, failedGates: gates.failedGates };
    }

    return { sizing, passed: true, failedGates: [] };
  }
}
