import { getPool } from '../client.js';
import type { DecisionResult } from '../../types/decision.js';

export async function insertDecision(decision: DecisionResult): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trading.trading_decisions (
      id, session_id, signal_snapshot_id, ticker, profile, trade_date,
      decision_type, direction, confirmation_count, orchestration_confidence,
      reasoning, urgency, should_execute
    ) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id`,
    [
      decision.id,
      decision.sessionId ?? null,
      decision.signalId,
      decision.ticker,
      decision.profile,
      decision.decisionType,
      null,
      decision.confirmationCount,
      decision.orchestrationConfidence,
      decision.reasoning,
      decision.urgency,
      decision.shouldExecute,
    ]
  );
  return rows[0]!.id;
}

export async function getRecentDecisions(ticker: string, limit = 10) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, decision_type, ticker, confirmation_count, orchestration_confidence,
            reasoning, should_execute, created_at
     FROM trading.trading_decisions
     WHERE ticker = $1 AND trade_date = CURRENT_DATE
     ORDER BY created_at DESC
     LIMIT $2`,
    [ticker, limit]
  );
  return rows;
}

export async function recordConfirmation(
  decisionId: string,
  ticker: string,
  confirmType: 'confirm' | 'contradict' | 'neutral',
  signalId?: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trading.decision_confirmations (decision_id, ticker, confirm_type, signal_id)
     VALUES ($1, $2, $3, $4)`,
    [decisionId, ticker, confirmType, signalId ?? null]
  );
}
