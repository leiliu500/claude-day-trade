-- ============================================================
-- Add STREAM trigger_type and STREAM_ACTIVE skipped_reason
-- to support stream-driven pipeline triggering
-- ============================================================

ALTER TABLE trading.scheduler_runs
  DROP CONSTRAINT IF EXISTS scheduler_runs_trigger_type_check;
ALTER TABLE trading.scheduler_runs
  ADD CONSTRAINT scheduler_runs_trigger_type_check
  CHECK (trigger_type IN ('AUTO', 'MANUAL', 'STREAM'));

ALTER TABLE trading.scheduler_runs
  DROP CONSTRAINT IF EXISTS scheduler_runs_skipped_reason_check;
ALTER TABLE trading.scheduler_runs
  ADD CONSTRAINT scheduler_runs_skipped_reason_check
  CHECK (skipped_reason IN ('PREV_RUN_ACTIVE', 'STREAM_ACTIVE'));
