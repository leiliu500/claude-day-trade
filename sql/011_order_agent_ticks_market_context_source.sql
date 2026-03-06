-- Add market_context_source to order_agent_ticks so the dashboard can track
-- whether each AI decision used fresh orchestrator context, cached context,
-- or had no context available yet.
ALTER TABLE trading.order_agent_ticks
  ADD COLUMN IF NOT EXISTS market_context_source TEXT
    CHECK (market_context_source IN ('fresh', 'cached', 'none'));
