-- ============================================================
-- odt subsystem — parallel options day-trade system tracking.
-- All tables prefixed with `odt_` within the existing `trading`
-- schema to avoid conflict with the main system's tables.
-- ============================================================

CREATE TABLE IF NOT EXISTS trading.odt_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode            TEXT NOT NULL CHECK (mode IN ('backtest', 'live')),
  strategy        TEXT NOT NULL,
  vehicle         TEXT NOT NULL CHECK (vehicle IN ('debit_vertical', 'long_option')),
  symbol          TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fold_start      DATE,
  fold_end        DATE,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_odt_runs_started_at ON trading.odt_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_odt_runs_mode_symbol ON trading.odt_runs (mode, symbol);

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trading.odt_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES trading.odt_runs(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL,
  day             DATE NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT', 'FLAT')),
  reason          TEXT,
  atr             NUMERIC(10,4),
  entry_price     NUMERIC(10,2),
  accepted        BOOLEAN NOT NULL,
  block_reason    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_odt_signals_run_day ON trading.odt_signals (run_id, day);
CREATE INDEX IF NOT EXISTS idx_odt_signals_ts ON trading.odt_signals (ts DESC);

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trading.odt_positions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES trading.odt_runs(id) ON DELETE CASCADE,
  position_id       TEXT NOT NULL,
  opened_ts         TIMESTAMPTZ NOT NULL,
  day               DATE NOT NULL,
  order_kind        TEXT NOT NULL CHECK (order_kind IN ('debit_vertical', 'long_option')),
  side              TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  symbols           TEXT[] NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty > 0),
  filled_debit      NUMERIC(10,2) NOT NULL,
  fees              NUMERIC(10,2) NOT NULL,
  entry_underlying  NUMERIC(10,2) NOT NULL,
  signal_ts         TIMESTAMPTZ NOT NULL,

  closed_ts         TIMESTAMPTZ,
  exit_rule         TEXT,
  exit_debit        NUMERIC(10,2),
  pnl_dollars       NUMERIC(10,2),
  hold_minutes      INTEGER,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (run_id, position_id)
);

CREATE INDEX IF NOT EXISTS idx_odt_positions_run_day ON trading.odt_positions (run_id, day);
CREATE INDEX IF NOT EXISTS idx_odt_positions_opened_ts ON trading.odt_positions (opened_ts DESC);
CREATE INDEX IF NOT EXISTS idx_odt_positions_closed_ts ON trading.odt_positions (closed_ts DESC);

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trading.odt_position_marks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES trading.odt_runs(id) ON DELETE CASCADE,
  position_id     TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  mark_debit      NUMERIC(10,2) NOT NULL,
  pnl_pct         NUMERIC(8,4) NOT NULL,
  pnl_dollars     NUMERIC(10,2) NOT NULL,
  underlying_px   NUMERIC(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_odt_marks_run_pos_ts ON trading.odt_position_marks (run_id, position_id, ts);

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trading.odt_daily_summaries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES trading.odt_runs(id) ON DELETE CASCADE,
  day                 DATE NOT NULL,
  equity_start        NUMERIC(12,2) NOT NULL,
  equity_end          NUMERIC(12,2) NOT NULL,
  pnl_realized        NUMERIC(10,2) NOT NULL,
  signals_total       INTEGER NOT NULL DEFAULT 0,
  signals_accepted    INTEGER NOT NULL DEFAULT 0,
  signals_blocked     INTEGER NOT NULL DEFAULT 0,
  entries_total       INTEGER NOT NULL DEFAULT 0,
  wins                INTEGER NOT NULL DEFAULT 0,
  losses              INTEGER NOT NULL DEFAULT 0,
  max_drawdown        NUMERIC(10,2) NOT NULL DEFAULT 0,
  kill_switch_reason  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (run_id, day)
);

CREATE INDEX IF NOT EXISTS idx_odt_daily_day ON trading.odt_daily_summaries (day DESC);

-- ------------------------------------------------------------
-- Convenience view: latest run per (mode, symbol)
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW trading.odt_latest_runs AS
SELECT DISTINCT ON (mode, symbol)
  id, mode, strategy, vehicle, symbol, started_at, ended_at, fold_start, fold_end
FROM trading.odt_runs
ORDER BY mode, symbol, started_at DESC;
