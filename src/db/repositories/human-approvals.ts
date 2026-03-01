import { getPool } from '../client.js';

export async function insertHumanApproval(params: {
  id: string;
  decisionId: string;
  ticker: string;
  profile: string;
  decisionType: string;
  optionSymbol?: string | null;
  optionSide?: string | null;
  qty?: number | null;
  limitPrice?: number | null;
  confidence?: number | null;
  reasoning?: string | null;
  expiresAt: Date;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trading.human_approvals (
       id, decision_id, ticker, profile, decision_type,
       option_symbol, option_side, qty, limit_price, confidence, reasoning,
       expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      params.id,
      params.decisionId,
      params.ticker,
      params.profile,
      params.decisionType,
      params.optionSymbol ?? null,
      params.optionSide ?? null,
      params.qty ?? null,
      params.limitPrice ?? null,
      params.confidence ?? null,
      params.reasoning ?? null,
      params.expiresAt.toISOString(),
    ]
  );
}

export async function updateHumanApprovalMessageId(
  id: string,
  telegramMessageId: number,
  telegramChatId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE trading.human_approvals
     SET telegram_message_id = $2, telegram_chat_id = $3
     WHERE id = $1`,
    [id, telegramMessageId, telegramChatId]
  );
}

export async function updateHumanApprovalStatus(
  id: string,
  status: 'APPROVED' | 'DENIED' | 'TIMEOUT',
  respondedById?: string,
  respondedByName?: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE trading.human_approvals
     SET status = $2,
         responded_by_id   = $3,
         responded_by_name = $4,
         responded_at      = NOW()
     WHERE id = $1`,
    [id, status, respondedById ?? null, respondedByName ?? null]
  );
}

export async function getRecentHumanApprovals(limit = 20) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, ticker, profile, decision_type, option_symbol, option_side,
            qty, limit_price, confidence, status,
            responded_by_name, responded_at, created_at, expires_at
     FROM trading.human_approvals
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}
