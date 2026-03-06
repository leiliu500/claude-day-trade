-- ============================================================
-- Stale-entry tracking in human_approvals
-- Adds STALE_QUOTE_ABORT status (approved by human but aborted
-- because the option price moved >15% before the order was placed)
-- and columns for recording price deviation details.
-- ============================================================

-- Extend the status check constraint to allow the new state
ALTER TABLE trading.human_approvals
  DROP CONSTRAINT IF EXISTS human_approvals_status_check;

ALTER TABLE trading.human_approvals
  ADD CONSTRAINT human_approvals_status_check
  CHECK (status IN ('PENDING','APPROVED','DENIED','TIMEOUT','STALE_QUOTE_ABORT'));

-- Store original limit price, fresh mid at abort time, and deviation %
ALTER TABLE trading.human_approvals
  ADD COLUMN IF NOT EXISTS abort_original_price NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS abort_fresh_price    NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS abort_dev_pct        NUMERIC(8,4);
