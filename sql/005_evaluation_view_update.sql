-- Add option_right from position_journal to v_evaluation_feedback
-- so both orchestrator and order agent can filter evaluations by option side.
-- Must drop+recreate because PostgreSQL only allows appending columns via
-- CREATE OR REPLACE VIEW, not inserting them in the middle.
DROP VIEW IF EXISTS trading.v_evaluation_feedback;
CREATE VIEW trading.v_evaluation_feedback AS
SELECT
  te.ticker,
  te.option_symbol,
  pj.option_right,
  te.trade_date,
  te.outcome,
  te.evaluation_grade,
  te.evaluation_score,
  te.signal_quality,
  te.timing_quality,
  te.risk_management_quality,
  te.lessons_learned,
  te.pnl_total,
  te.hold_duration_min,
  te.evaluated_at
FROM trading.trade_evaluations te
LEFT JOIN trading.position_journal pj ON te.position_id = pj.id
ORDER BY te.evaluated_at DESC;
