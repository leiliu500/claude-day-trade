import { getPool } from '../client.js';
import type { SignalPayload } from '../../types/signal.js';
import type { OptionEvaluation } from '../../types/options.js';
import type { AnalysisResult } from '../../types/analysis.js';

export async function insertSignalSnapshot(
  signal: SignalPayload,
  option: OptionEvaluation,
  analysis: AnalysisResult,
  sessionId?: string
): Promise<string> {
  const pool = getPool();
  const winner = option.winnerCandidate;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trading.signal_snapshots (
      session_id, ticker, profile, trade_date, triggered_by,
      direction, alignment, confidence, confidence_meets_threshold,
      desired_right, selected_right, selected_symbol,
      entry_premium, stop_premium, tp_premium, risk_reward,
      option_liquidity_ok, spread_pct,
      signal_payload, option_payload, analysis_payload
    ) VALUES (
      $1,$2,$3,CURRENT_DATE,$4,
      $5,$6,$7,$8,
      $9,$10,$11,
      $12,$13,$14,$15,
      $16,$17,
      $18,$19,$20
    ) RETURNING id`,
    [
      sessionId ?? null,
      signal.ticker,
      signal.profile,
      signal.triggeredBy,
      signal.direction,
      signal.alignment,
      analysis.confidence,
      analysis.meetsEntryThreshold,
      analysis.desiredRight,
      option.winner,
      winner?.contract.symbol ?? null,
      winner?.entryPremium ?? null,
      winner?.stopPremium ?? null,
      winner?.tpPremium ?? null,
      winner?.rrRatio ?? null,
      option.liquidityOk,
      winner?.contract.spreadPct ?? null,
      JSON.stringify(signal),
      JSON.stringify(option),
      JSON.stringify(analysis),
    ]
  );

  return rows[0]!.id;
}

export async function getRecentSignals(ticker: string, limit = 10) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, ticker, profile, direction, alignment, confidence,
            confidence_meets_threshold, selected_right, selected_symbol,
            entry_premium, risk_reward, option_liquidity_ok, created_at
     FROM trading.signal_snapshots
     WHERE ticker = $1 AND trade_date = CURRENT_DATE
     ORDER BY created_at DESC
     LIMIT $2`,
    [ticker, limit]
  );
  return rows;
}
