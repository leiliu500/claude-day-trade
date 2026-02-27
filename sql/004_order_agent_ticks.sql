-- --------------------------------------------------------
-- order_agent_ticks
-- Persists every AI recommendation made by an OrderAgent
-- during a position's lifecycle. Used as history context
-- for subsequent AI calls to improve hold/exit decisions.
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.order_agent_ticks (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id             UUID NOT NULL REFERENCES trading.position_journal(id),
  tick_count              INT NOT NULL,
  action                  TEXT NOT NULL CHECK (action IN ('HOLD','EXIT','REDUCE','ADJUST_STOP')),
  new_stop                NUMERIC(10,4),
  reasoning               TEXT,
  pnl_pct                 NUMERIC(8,2),
  current_price           NUMERIC(10,4),
  overriding_orchestrator BOOLEAN NOT NULL DEFAULT FALSE,
  orchestrator_suggestion TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_agent_ticks_position
  ON trading.order_agent_ticks (position_id, created_at DESC);
