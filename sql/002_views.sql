-- ============================================================
-- Views for the trading system
-- ============================================================

-- Active open positions
CREATE OR REPLACE VIEW trading.v_active_positions AS
SELECT
  pj.id,
  pj.session_id,
  pj.ticker,
  pj.option_symbol,
  pj.option_right,
  pj.strike,
  pj.expiration,
  pj.qty,
  pj.entry_price,
  pj.current_stop,
  pj.current_tp,
  pj.conviction_score,
  pj.conviction_tier,
  pj.opened_at,
  pj.trade_date,
  td.decision_type,
  td.direction,
  td.confirmation_count,
  td.reasoning AS entry_reasoning
FROM trading.position_journal pj
LEFT JOIN trading.trading_decisions td ON pj.decision_id = td.id
WHERE pj.status = 'OPEN';

-- Confirmation streaks (running count of confirms/contradicts per open position)
CREATE OR REPLACE VIEW trading.v_confirmation_streaks AS
WITH ranked AS (
  SELECT
    dc.decision_id,
    dc.ticker,
    dc.trade_date,
    dc.confirm_type,
    dc.created_at,
    ROW_NUMBER() OVER (PARTITION BY dc.decision_id ORDER BY dc.created_at DESC) AS rn
  FROM trading.decision_confirmations dc
)
SELECT
  decision_id,
  ticker,
  trade_date,
  COUNT(*) FILTER (WHERE confirm_type = 'confirm') AS confirm_count,
  COUNT(*) FILTER (WHERE confirm_type = 'contradict') AS contradict_count,
  COUNT(*) AS total_count,
  MAX(created_at) AS last_updated
FROM ranked
GROUP BY decision_id, ticker, trade_date;

-- Latest broker positions (most recent sync per symbol)
CREATE OR REPLACE VIEW trading.v_broker_positions_latest AS
SELECT DISTINCT ON (symbol)
  id, ticker, symbol, qty, avg_entry_price, market_value,
  unrealized_pl, unrealized_plpc, current_price, asset_class, synced_at
FROM trading.broker_positions
ORDER BY symbol, synced_at DESC;

-- Latest broker open orders (most recent sync per alpaca_order_id)
CREATE OR REPLACE VIEW trading.v_broker_open_orders_latest AS
SELECT DISTINCT ON (alpaca_order_id)
  id, alpaca_order_id, symbol, order_type, side, qty,
  filled_qty, limit_price, status, created_at_broker, synced_at
FROM trading.broker_open_orders
ORDER BY alpaca_order_id, synced_at DESC;

-- Evaluation feedback for orchestrator learning
CREATE OR REPLACE VIEW trading.v_evaluation_feedback AS
SELECT
  te.ticker,
  te.option_symbol,
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
ORDER BY te.evaluated_at DESC;

-- Recent order executions
CREATE OR REPLACE VIEW trading.v_recent_executions AS
SELECT
  oe.id,
  oe.ticker,
  oe.option_symbol,
  oe.order_side,
  oe.submitted_qty,
  oe.filled_qty,
  oe.submitted_price,
  oe.fill_price,
  oe.alpaca_status,
  oe.error_message,
  oe.submitted_at,
  oe.filled_at
FROM trading.order_executions oe
ORDER BY oe.submitted_at DESC;
