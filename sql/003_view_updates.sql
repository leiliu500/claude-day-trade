-- ============================================================
-- View updates: add order_type to v_recent_executions
-- ============================================================

DROP VIEW IF EXISTS trading.v_recent_executions;
CREATE VIEW trading.v_recent_executions AS
SELECT
  oe.id,
  oe.ticker,
  oe.option_symbol,
  oe.order_side,
  oe.order_type,
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
