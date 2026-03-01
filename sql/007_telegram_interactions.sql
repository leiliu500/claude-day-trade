-- ============================================================
-- Telegram user interactions log
-- Tracks every command / message / callback from Telegram users
-- ============================================================

CREATE TABLE IF NOT EXISTS trading.telegram_interactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the user did
  command       TEXT NOT NULL,   -- '/start', '/help', '/status', '/positions',
                                 -- '/closeall', '/cleanup', 'trade_trigger',
                                 -- 'approve', 'deny'
  raw_text      TEXT,            -- raw message text or callback_data

  -- Who did it
  user_id       TEXT NOT NULL,   -- Telegram user.id (as string)
  user_name     TEXT,            -- first_name or username

  -- Where
  chat_id       TEXT NOT NULL,

  -- Parsed arguments for the command
  params        JSONB,           -- e.g. { ticker: "SPY", profile: "S" }

  -- Result
  outcome       TEXT,            -- 'ok' | 'confirm_requested' | 'executed' | 'error'
  error_message TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tg_interactions_created
  ON trading.telegram_interactions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tg_interactions_command
  ON trading.telegram_interactions (command, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tg_interactions_user
  ON trading.telegram_interactions (user_id, created_at DESC);
