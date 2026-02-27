-- ============================================================
-- scheduler_runs — tracks every 3-min tick during trading hours
-- Allows post-hoc analysis of skipped/slow/errored intervals
-- ============================================================

CREATE TABLE IF NOT EXISTS trading.scheduler_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at            TIMESTAMPTZ NOT NULL,   -- UTC-aligned 3-min boundary
  trigger_type      TEXT NOT NULL DEFAULT 'AUTO'
                      CHECK (trigger_type IN ('AUTO', 'MANUAL')),
  status            TEXT NOT NULL DEFAULT 'RUNNING'
                      CHECK (status IN ('RUNNING', 'COMPLETED', 'TIMEOUT', 'SKIPPED')),
  skipped_reason    TEXT CHECK (skipped_reason IN ('PREV_RUN_ACTIVE')),
  -- Array of per-ticker results: [{ticker, profile, status, decision, duration_ms, error}]
  ticker_runs       JSONB NOT NULL DEFAULT '[]',
  total_duration_ms INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduler_runs_run_at
  ON trading.scheduler_runs (run_at DESC);
