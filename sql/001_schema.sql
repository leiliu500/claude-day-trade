-- ============================================================
-- Trading schema — Option Day Trade System
-- ============================================================

CREATE SCHEMA IF NOT EXISTS trading;

-- --------------------------------------------------------
-- trading_sessions
-- One row per ticker + profile + trading day
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.trading_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        TEXT NOT NULL,
  profile       TEXT NOT NULL CHECK (profile IN ('S', 'M', 'L')),
  trade_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'PAUSED')),
  intervals     TEXT NOT NULL,             -- e.g. '2m,3m,5m'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  notes         TEXT,
  UNIQUE (ticker, profile, trade_date)
);

-- --------------------------------------------------------
-- signal_snapshots
-- Every 5-min signal run result (full JSONB payload)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.signal_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID REFERENCES trading.trading_sessions(id),
  ticker                TEXT NOT NULL,
  profile               TEXT NOT NULL,
  trade_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  triggered_by          TEXT NOT NULL CHECK (triggered_by IN ('AUTO', 'MANUAL')),

  -- Synthesized signal
  direction             TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish', 'neutral')),
  alignment             TEXT NOT NULL CHECK (alignment IN ('all_aligned','htf_mtf_aligned','mtf_ltf_aligned','mixed')),
  confidence            NUMERIC(6,4) NOT NULL DEFAULT 0,
  confidence_meets_threshold BOOLEAN NOT NULL DEFAULT FALSE,

  -- Option selection result
  desired_right         TEXT CHECK (desired_right IN ('call','put')),
  selected_right        TEXT CHECK (selected_right IN ('call','put')),
  selected_symbol       TEXT,
  entry_premium         NUMERIC(10,4),
  stop_premium          NUMERIC(10,4),
  tp_premium            NUMERIC(10,4),
  risk_reward           NUMERIC(8,4),
  option_liquidity_ok   BOOLEAN DEFAULT FALSE,
  spread_pct            NUMERIC(8,4),

  -- Full payload for debugging
  signal_payload        JSONB,
  option_payload        JSONB,
  analysis_payload      JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------
-- trading_decisions
-- Every orchestrator decision (7 types)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.trading_decisions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              UUID REFERENCES trading.trading_sessions(id),
  signal_snapshot_id      UUID REFERENCES trading.signal_snapshots(id),
  ticker                  TEXT NOT NULL,
  profile                 TEXT NOT NULL,
  trade_date              DATE NOT NULL DEFAULT CURRENT_DATE,

  decision_type           TEXT NOT NULL CHECK (decision_type IN (
                            'NEW_ENTRY','CONFIRM_HOLD','ADD_POSITION',
                            'REDUCE_EXPOSURE','REVERSE','EXIT','WAIT'
                          )),
  direction               TEXT,
  confirmation_count      INT NOT NULL DEFAULT 0,
  orchestration_confidence NUMERIC(6,4),
  reasoning               TEXT,
  urgency                 TEXT CHECK (urgency IN ('immediate','standard','low')),
  should_execute          BOOLEAN NOT NULL DEFAULT FALSE,

  raw_claude_response     TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------
-- decision_confirmations
-- Confirm / contradict tracking per decision
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.decision_confirmations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id     UUID NOT NULL REFERENCES trading.trading_decisions(id),
  ticker          TEXT NOT NULL,
  trade_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  confirm_type    TEXT NOT NULL CHECK (confirm_type IN ('confirm','contradict','neutral')),
  signal_id       UUID REFERENCES trading.signal_snapshots(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------
-- position_journal
-- Virtual position lifecycle (open → closed)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.position_journal (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID REFERENCES trading.trading_sessions(id),
  decision_id         UUID REFERENCES trading.trading_decisions(id),
  ticker              TEXT NOT NULL,
  option_symbol       TEXT NOT NULL,
  option_right        TEXT NOT NULL CHECK (option_right IN ('call','put')),
  strike              NUMERIC(10,2),
  expiration          DATE,
  trade_date          DATE NOT NULL DEFAULT CURRENT_DATE,

  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','PARTIALLY_CLOSED')),
  qty                 INT NOT NULL,
  entry_price         NUMERIC(10,4) NOT NULL,
  current_stop        NUMERIC(10,4),
  current_tp          NUMERIC(10,4),
  exit_price          NUMERIC(10,4),
  realized_pnl        NUMERIC(12,4),

  conviction_score    INT,
  conviction_tier     TEXT CHECK (conviction_tier IN ('REGULAR','SIZABLE','MAX_CONVICTION')),
  close_reason        TEXT,

  opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  hold_duration_min   INT GENERATED ALWAYS AS (
                        CASE WHEN closed_at IS NOT NULL
                        THEN EXTRACT(EPOCH FROM (closed_at - opened_at))::INT / 60
                        ELSE NULL END
                      ) STORED
);

-- --------------------------------------------------------
-- order_executions
-- Every Alpaca API call result
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.order_executions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id         UUID REFERENCES trading.position_journal(id),
  decision_id         UUID REFERENCES trading.trading_decisions(id),
  ticker              TEXT NOT NULL,
  option_symbol       TEXT NOT NULL,

  alpaca_order_id     TEXT,
  alpaca_status       TEXT,
  order_side          TEXT NOT NULL CHECK (order_side IN ('buy','sell')),
  order_type          TEXT NOT NULL CHECK (order_type IN ('market','limit')),
  position_intent     TEXT,
  time_in_force       TEXT DEFAULT 'day',

  submitted_qty       INT NOT NULL,
  filled_qty          INT DEFAULT 0,
  submitted_price     NUMERIC(10,4),
  fill_price          NUMERIC(10,4),

  error_message       TEXT,
  raw_response        JSONB,

  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filled_at           TIMESTAMPTZ
);

-- --------------------------------------------------------
-- trade_evaluations
-- Post-trade AI critiques (A-F grading)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.trade_evaluations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id           UUID REFERENCES trading.position_journal(id),
  decision_id           UUID REFERENCES trading.trading_decisions(id),
  ticker                TEXT NOT NULL,
  option_symbol         TEXT NOT NULL,
  trade_date            DATE NOT NULL DEFAULT CURRENT_DATE,

  entry_price           NUMERIC(10,4),
  exit_price            NUMERIC(10,4),
  qty                   INT,
  pnl_total             NUMERIC(12,4),
  pnl_per_contract      NUMERIC(12,4),
  pnl_pct               NUMERIC(8,4),
  hold_duration_min     INT,
  outcome               TEXT CHECK (outcome IN ('WIN','LOSS','BREAKEVEN')),

  evaluation_grade      TEXT CHECK (evaluation_grade IN ('A','B','C','D','F')),
  evaluation_score      INT CHECK (evaluation_score BETWEEN 0 AND 100),
  signal_quality        TEXT,
  timing_quality        TEXT,
  risk_management_quality TEXT,
  lessons_learned       TEXT,
  what_went_right       JSONB DEFAULT '[]',
  what_went_wrong       JSONB DEFAULT '[]',

  raw_claude_evaluation TEXT,
  evaluated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------
-- broker_positions
-- Alpaca real positions snapshot (per sync)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.broker_positions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          TEXT,
  symbol          TEXT NOT NULL,
  qty             INT,
  avg_entry_price NUMERIC(10,4),
  market_value    NUMERIC(12,4),
  unrealized_pl   NUMERIC(12,4),
  unrealized_plpc NUMERIC(8,4),
  current_price   NUMERIC(10,4),
  asset_class     TEXT,
  raw_data        JSONB,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------
-- broker_open_orders
-- Alpaca pending orders snapshot (per sync)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.broker_open_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alpaca_order_id TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  order_type      TEXT,
  side            TEXT,
  qty             NUMERIC(10,2),
  filled_qty      NUMERIC(10,2),
  limit_price     NUMERIC(10,4),
  status          TEXT,
  created_at_broker TIMESTAMPTZ,
  raw_data        JSONB,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
