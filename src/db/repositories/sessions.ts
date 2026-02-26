import { getPool } from '../client.js';
import type { TradingProfile } from '../../types/market.js';

export async function getOrCreateSession(
  ticker: string,
  profile: TradingProfile,
  intervals: string
): Promise<string> {
  const pool = getPool();

  // Try to find an existing ACTIVE session for today
  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM trading.trading_sessions
     WHERE ticker = $1 AND profile = $2 AND trade_date = CURRENT_DATE AND status = 'ACTIVE'
     LIMIT 1`,
    [ticker, profile]
  );

  if (existing.length > 0) return existing[0]!.id;

  // Create new session
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trading.trading_sessions (ticker, profile, intervals, status)
     VALUES ($1, $2, $3, 'ACTIVE')
     ON CONFLICT (ticker, profile, trade_date)
     DO UPDATE SET status = 'ACTIVE', intervals = EXCLUDED.intervals
     RETURNING id`,
    [ticker, profile, intervals]
  );

  return rows[0]!.id;
}

export async function closeSession(sessionId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE trading.trading_sessions SET status = 'CLOSED', closed_at = NOW() WHERE id = $1`,
    [sessionId]
  );
}
