-- ============================================================
-- Human approval requests
-- Tracks every NEW_ENTRY approval request sent to Telegram
-- and the human response (approved / denied / timeout)
-- ============================================================

CREATE TABLE IF NOT EXISTS trading.human_approvals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id          UUID REFERENCES trading.trading_decisions(id),

  -- Trade summary (snapshot at request time)
  ticker               TEXT NOT NULL,
  profile              TEXT NOT NULL,
  decision_type        TEXT NOT NULL,
  option_symbol        TEXT,
  option_side          TEXT CHECK (option_side IN ('call','put')),
  qty                  INT,
  limit_price          NUMERIC(10,4),
  confidence           NUMERIC(6,4),
  reasoning            TEXT,

  -- Approval state
  status               TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','APPROVED','DENIED','TIMEOUT')),

  -- Telegram message tracking (to edit message after response)
  telegram_message_id  BIGINT,
  telegram_chat_id     TEXT,

  -- Responder info
  responded_by_id      TEXT,     -- Telegram user.id
  responded_by_name    TEXT,     -- first_name / username
  responded_at         TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_human_approvals_decision
  ON trading.human_approvals (decision_id);

CREATE INDEX IF NOT EXISTS idx_human_approvals_status
  ON trading.human_approvals (status, created_at);
