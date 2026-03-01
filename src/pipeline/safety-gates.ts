import { config } from '../config.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { OptionEvaluation } from '../types/options.js';
import type { DecisionResult } from '../types/decision.js';

export interface GateCheckResult {
  passed: boolean;
  failedGates: string[];
}

/**
 * Run all 8 pre-order safety gates.
 * Any failure means the order must NOT be submitted.
 */
export function checkSafetyGates(params: {
  timeGateOk: boolean;
  analysis: AnalysisResult;
  option: OptionEvaluation;
  decision: DecisionResult;
  accountBuyingPower: number;
  accountEquity: number;
  dailyRealizedPnl: number;
  proposedQty: number;
  proposedCost: number;
}): GateCheckResult {
  const { timeGateOk, analysis, option, decision, accountBuyingPower, accountEquity, dailyRealizedPnl, proposedQty, proposedCost } = params;
  const failed: string[] = [];

  // 1. Time gate — market must be open
  if (!timeGateOk) failed.push('TIME_GATE: market is closed');

  // 2. Liquidity gate — spread must be within limit
  if (!option.liquidityOk) {
    const pct = option.winnerCandidate?.contract.spreadPct?.toFixed(2) ?? '?';
    failed.push(`LIQUIDITY_GATE: spread ${pct}% exceeds ${(config.MAX_SPREAD_PCT * 100).toFixed(0)}%`);
  }

  // 3. Confidence gate — must meet minimum for entry
  if (analysis.confidence < config.MIN_CONFIDENCE) {
    failed.push(`CONFIDENCE_GATE: ${analysis.confidence.toFixed(2)} < ${config.MIN_CONFIDENCE}`);
  }

  // 4. R:R gate — minimum risk/reward
  const rr = option.winnerCandidate?.rrRatio ?? 0;
  if (rr < config.MIN_RR_RATIO) {
    failed.push(`RR_GATE: R:R ${rr.toFixed(2)} < ${config.MIN_RR_RATIO}`);
  }

  // 5. Side mismatch gate
  const desiredRight = analysis.desiredRight;
  const winnerRight = option.winner;
  if (desiredRight && winnerRight && desiredRight !== winnerRight) {
    failed.push(`SIDE_MISMATCH: desired ${desiredRight}, winner is ${winnerRight}`);
  }

  // 6. Candidate pass gate
  if (!option.candidatePass) failed.push('CANDIDATE_GATE: no valid option contract selected');

  // 7. Buying power gate
  if (proposedCost > accountBuyingPower) {
    failed.push(`BUYING_POWER_GATE: cost $${proposedCost.toFixed(0)} > buying power $${accountBuyingPower.toFixed(0)}`);
  }

  // 8. Quantity cap gate
  if (proposedQty > config.MAX_CONTRACTS) {
    failed.push(`QTY_CAP_GATE: qty ${proposedQty} > max ${config.MAX_CONTRACTS}`);
  }

  // 9. Daily loss limit gate — halt new entries once today's realized losses exceed threshold
  if (accountEquity > 0 && dailyRealizedPnl < 0) {
    const limitUsd = accountEquity * config.DAILY_LOSS_LIMIT_PCT;
    if (-dailyRealizedPnl > limitUsd) {
      failed.push(
        `DAILY_LOSS_GATE: today's realized P&L $${dailyRealizedPnl.toFixed(0)} exceeds ` +
        `-${(config.DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}% limit ($-${limitUsd.toFixed(0)})`,
      );
    }
  }

  return { passed: failed.length === 0, failedGates: failed };
}

/** Check if current market is open via Alpaca clock */
export async function checkMarketOpen(): Promise<boolean> {
  try {
    const res = await fetch(`${process.env['ALPACA_BASE_URL'] ?? 'https://paper-api.alpaca.markets'}/v2/clock`, {
      headers: {
        'APCA-API-KEY-ID': process.env['ALPACA_API_KEY'] ?? '',
        'APCA-API-SECRET-KEY': process.env['ALPACA_SECRET_KEY'] ?? '',
      },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { is_open?: boolean };
    return data.is_open ?? false;
  } catch {
    return false;
  }
}
