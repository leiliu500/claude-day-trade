-- Add entry_strategy JSONB column to trading_decisions
-- Stores the structured EntryStrategy object (stage, override, confirmations, etc.)
ALTER TABLE trading.trading_decisions
  ADD COLUMN IF NOT EXISTS entry_strategy JSONB;
