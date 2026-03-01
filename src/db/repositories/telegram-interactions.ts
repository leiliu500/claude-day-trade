import { getPool } from '../client.js';

export interface TelegramInteractionParams {
  command: string;
  rawText?: string;
  userId: string;
  userName?: string;
  chatId: string;
  params?: Record<string, unknown>;
  outcome?: string;
  errorMessage?: string;
}

export async function insertTelegramInteraction(p: TelegramInteractionParams): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trading.telegram_interactions
       (command, raw_text, user_id, user_name, chat_id, params, outcome, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      p.command,
      p.rawText ?? null,
      p.userId,
      p.userName ?? null,
      p.chatId,
      p.params ? JSON.stringify(p.params) : null,
      p.outcome ?? null,
      p.errorMessage ?? null,
    ],
  );
}

export async function getRecentTelegramInteractions(limit = 50) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, command, raw_text, user_id, user_name, chat_id,
            params, outcome, error_message, created_at
     FROM trading.telegram_interactions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
