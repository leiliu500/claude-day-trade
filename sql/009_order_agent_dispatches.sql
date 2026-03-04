-- -----------------------------------------------------------------------
-- order_agent_dispatches
-- Records every orchestrator decision dispatched to an order agent.
-- Proves that low-confidence inputs (WAIT/EXIT/CONFIRM_HOLD) are always
-- forwarded to active agents — even when confidence < entry threshold.
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading.order_agent_dispatches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id           UUID NOT NULL REFERENCES trading.position_journal(id),
  ticker                TEXT NOT NULL,
  option_symbol         TEXT NOT NULL,
  orchestrator_decision TEXT NOT NULL,
  confidence            NUMERIC(5,4),
  urgency               TEXT NOT NULL,
  reason                TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_agent_dispatches_position
  ON trading.order_agent_dispatches (position_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_agent_dispatches_created
  ON trading.order_agent_dispatches (created_at DESC);
