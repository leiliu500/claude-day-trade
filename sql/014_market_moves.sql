-- ============================================================
-- Market moves — persists detected intraday moves for backtest analysis
-- ============================================================

CREATE TABLE IF NOT EXISTS trading.market_moves (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker            TEXT NOT NULL,
  trade_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  direction         TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),

  -- Move boundaries
  start_time        TIMESTAMPTZ NOT NULL,
  peak_time         TIMESTAMPTZ NOT NULL,
  start_price       NUMERIC(10,2) NOT NULL,
  peak_price        NUMERIC(10,2) NOT NULL,

  -- Quality metrics
  mfe_pct           NUMERIC(8,4) NOT NULL,   -- max favorable excursion %
  mae_pct           NUMERIC(8,4) NOT NULL,   -- max adverse excursion %
  duration_minutes  INT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,

  -- Signal matching
  signal_status     TEXT CHECK (signal_status IN ('DETECTED', 'WRONG_DIR', 'LOW_CONF', 'NO_SIGNAL', 'FILTER_BLOCKED')),
  delay_minutes     INT,
  entry_cost_pct    NUMERIC(8,4),
  remaining_mfe_pct NUMERIC(8,4),
  capture_ratio     NUMERIC(8,4),

  -- Classification
  classification    TEXT,
  priority          TEXT CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
  action_hint       TEXT,

  -- Matching signal context
  signal_direction  TEXT,
  signal_confidence NUMERIC(6,4),
  signal_mode       TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Deduplicate: one row per ticker + direction + start_time
  UNIQUE (ticker, direction, start_time)
);

CREATE INDEX IF NOT EXISTS idx_market_moves_ticker_date
  ON trading.market_moves (ticker, trade_date);

CREATE INDEX IF NOT EXISTS idx_market_moves_classification
  ON trading.market_moves (classification, priority);
