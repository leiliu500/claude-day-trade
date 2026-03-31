import { config } from '../config.js';
import type { TickerConfig } from '../ticker-configs.js';
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
  ltfAtrPct?: number;
  tickerCfg?: TickerConfig;
}): GateCheckResult {
  const { timeGateOk, analysis, option, decision, accountBuyingPower, accountEquity, dailyRealizedPnl, proposedQty, proposedCost, ltfAtrPct, tickerCfg } = params;
  // Per-symbol config with global fallback
  const minConfidence = tickerCfg?.minConfidence ?? config.MIN_CONFIDENCE;
  const maxSpreadPct = tickerCfg?.maxSpreadPct ?? config.MAX_SPREAD_PCT;
  const minRRRatio = tickerCfg?.minRRRatio ?? config.MIN_RR_RATIO;
  const maxContracts = tickerCfg?.maxContracts ?? config.MAX_CONTRACTS;
  const dailyLossLimitPct = tickerCfg?.dailyLossLimitPct ?? config.DAILY_LOSS_LIMIT_PCT;
  const maxLtfAtrPct = tickerCfg?.maxLtfAtrPct ?? config.MAX_LTF_ATR_PCT;
  const failed: string[] = [];

  // 1. Time gate — market must be open
  if (!timeGateOk) failed.push('TIME_GATE: market is closed');

  // 2. Liquidity gate — spread must be within limit
  if (!option.liquidityOk) {
    const pct = option.winnerCandidate?.contract.spreadPct?.toFixed(2) ?? '?';
    failed.push(`LIQUIDITY_GATE: spread ${pct}% exceeds ${(maxSpreadPct * 100).toFixed(0)}%`);
  }

  // 3. Confidence gate removed — structural triggers are the entry gate, not confidence numbers.
  //    Kept as comment for audit trail.

  // 4. R:R gate — minimum risk/reward
  const rr = option.winnerCandidate?.rrRatio ?? 0;
  if (rr < minRRRatio) {
    failed.push(`RR_GATE: R:R ${rr.toFixed(2)} < ${minRRRatio}`);
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
  if (proposedQty > maxContracts) {
    failed.push(`QTY_CAP_GATE: qty ${proposedQty} > max ${maxContracts}`);
  }

  // 9. Daily loss limit gate — halt new entries once today's realized losses exceed threshold
  if (accountEquity > 0 && dailyRealizedPnl < 0) {
    const limitUsd = accountEquity * dailyLossLimitPct;
    if (-dailyRealizedPnl > limitUsd) {
      failed.push(
        `DAILY_LOSS_GATE: today's realized P&L $${dailyRealizedPnl.toFixed(0)} exceeds ` +
        `-${(dailyLossLimitPct * 100).toFixed(0)}% limit ($-${limitUsd.toFixed(0)})`,
      );
    }
  }

  // 10. Open-volatility gate — no new entries in first 30 min of session (9:30–10:00 AM ET)
  {
    const now = new Date();
    // DST detection: 2nd Sunday March → 1st Sunday November (US Eastern)
    const year = now.getUTCFullYear();
    const dstStart = new Date(Date.UTC(year, 2, 1));
    dstStart.setUTCDate(1 + ((7 - dstStart.getUTCDay()) % 7) + 7); // 2nd Sunday March
    const dstEnd = new Date(Date.UTC(year, 10, 1));
    dstEnd.setUTCDate(1 + ((7 - dstEnd.getUTCDay()) % 7)); // 1st Sunday November
    const isDst = now >= dstStart && now < dstEnd;
    const etOffsetMin = isDst ? -4 * 60 : -5 * 60;
    const totalUtcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const etMin = ((totalUtcMin + etOffsetMin) + 24 * 60) % (24 * 60);
    const marketOpenMin = 9 * 60 + 30; // 9:30 AM ET
    const minutesSinceOpen = etMin - marketOpenMin;
    if (minutesSinceOpen >= 0 && minutesSinceOpen < 30) {
      const minsLeft = 30 - minutesSinceOpen;
      failed.push(`OPEN_VOLATILITY_GATE: first 30 min of session — ${minsLeft} min until 10:00 AM ET`);
    }
  }

  // 11. Volatility spike gate — skip entries when LTF ATR% indicates choppy/event-driven conditions
  if (ltfAtrPct !== undefined && ltfAtrPct > maxLtfAtrPct) {
    failed.push(
      `VOLATILITY_SPIKE_GATE: LTF ATR ${(ltfAtrPct * 100).toFixed(2)}% > ${(maxLtfAtrPct * 100).toFixed(0)}% — conditions too volatile for entry`,
    );
  }

  return { passed: failed.length === 0, failedGates: failed };
}

/** Check if current market is open via Alpaca clock */
export async function checkMarketOpen(): Promise<boolean> {
  try {
    const res = await fetch(`${config.ALPACA_BASE_URL}/v2/clock`, {
      headers: {
        'APCA-API-KEY-ID': config.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
      },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { is_open?: boolean };
    return data.is_open ?? false;
  } catch {
    return false;
  }
}
