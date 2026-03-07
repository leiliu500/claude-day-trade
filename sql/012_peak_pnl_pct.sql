-- Add peak_pnl_pct to position_journal so the highest unrealized P&L %
-- ever seen is persisted across app restarts. Without this, OrderAgent
-- must approximate the peak from current_stop (lower bound), causing
-- profit-lock and peak-erosion rules to under-fire after a restart.
ALTER TABLE trading.position_journal
  ADD COLUMN IF NOT EXISTS peak_pnl_pct NUMERIC(8,2);
