-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_signal_snapshots_ticker_date
  ON trading.signal_snapshots (ticker, trade_date, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trading_decisions_ticker_date
  ON trading.trading_decisions (ticker, trade_date, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_journal_status_ticker
  ON trading.position_journal (status, ticker, trade_date);

CREATE INDEX IF NOT EXISTS idx_order_executions_ticker_date
  ON trading.order_executions (ticker, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_evaluations_ticker_date
  ON trading.trade_evaluations (ticker, trade_date, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_broker_positions_synced
  ON trading.broker_positions (symbol, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_broker_orders_synced
  ON trading.broker_open_orders (alpaca_order_id, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_confirmations_decision
  ON trading.decision_confirmations (decision_id, created_at DESC);
