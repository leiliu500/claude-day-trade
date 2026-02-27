import { getPool } from '../client.js';
import type { EvaluationRecord } from '../../types/trade.js';

export async function insertEvaluation(eval_: EvaluationRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trading.trade_evaluations (
      id, position_id, decision_id, ticker, option_symbol, trade_date,
      entry_price, exit_price, qty, pnl_total, pnl_per_contract, pnl_pct,
      hold_duration_min, outcome,
      evaluation_grade, evaluation_score,
      signal_quality, timing_quality, risk_management_quality,
      lessons_learned, what_went_right, what_went_wrong
    ) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      eval_.id,
      eval_.positionId ?? null,
      eval_.decisionId ?? null,
      eval_.ticker,
      eval_.optionSymbol,
      eval_.entryPrice,
      eval_.exitPrice,
      eval_.qty,
      eval_.pnlTotal,
      eval_.pnlPerContract,
      eval_.pnlPct,
      eval_.holdDurationMin,
      eval_.outcome,
      eval_.grade,
      eval_.score,
      eval_.signalQuality,
      eval_.timingQuality,
      eval_.riskManagementQuality,
      eval_.lessonsLearned,
      JSON.stringify(eval_.whatWentRight),
      JSON.stringify(eval_.whatWentWrong),
    ]
  );
}

export async function getEvaluationFeedback(ticker: string, limit = 5) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ticker, outcome, evaluation_grade, evaluation_score,
            signal_quality, timing_quality, risk_management_quality,
            lessons_learned, pnl_total, hold_duration_min, evaluated_at
     FROM trading.v_evaluation_feedback
     WHERE ticker = $1
     LIMIT $2`,
    [ticker, limit]
  );
  return rows;
}

export interface TickerEvaluation {
  outcome: string;
  grade: string;
  score: number;
  pnlTotal: number | null;
  holdDurationMin: number | null;
  signalQuality: string | null;
  timingQuality: string | null;
  riskManagementQuality: string | null;
  lessonsLearned: string;
  evaluatedAt: string;
}

/**
 * Recent closed-trade evaluations for the same ticker + option side.
 * Used by OrderAgent to give its AI context about how similar past
 * positions on this ticker performed.
 */
export async function getTickerEvaluations(
  ticker: string,
  optionRight: 'call' | 'put',
  limit = 3,
): Promise<TickerEvaluation[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    outcome: string;
    evaluation_grade: string;
    evaluation_score: number;
    pnl_total: string | null;
    hold_duration_min: number | null;
    signal_quality: string | null;
    timing_quality: string | null;
    risk_management_quality: string | null;
    lessons_learned: string | null;
    evaluated_at: string;
  }>(
    `SELECT outcome, evaluation_grade, evaluation_score,
            pnl_total::text, hold_duration_min,
            signal_quality, timing_quality, risk_management_quality,
            lessons_learned, evaluated_at::text
     FROM trading.v_evaluation_feedback
     WHERE ticker = $1 AND option_right = $2
     LIMIT $3`,
    [ticker, optionRight, limit],
  );
  return rows.map(r => ({
    outcome:               r.outcome,
    grade:                 r.evaluation_grade,
    score:                 r.evaluation_score,
    pnlTotal:              r.pnl_total != null ? parseFloat(r.pnl_total) : null,
    holdDurationMin:       r.hold_duration_min ?? null,
    signalQuality:         r.signal_quality ?? null,
    timingQuality:         r.timing_quality ?? null,
    riskManagementQuality: r.risk_management_quality ?? null,
    lessonsLearned:        r.lessons_learned ?? '',
    evaluatedAt:           r.evaluated_at,
  }));
}
