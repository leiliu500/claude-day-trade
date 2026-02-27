import { getPool } from '../client.js';
import type { OptionCandidate } from '../../types/options.js';
import type { SizeResult } from '../../types/trade.js';

export async function insertPosition(params: {
  sessionId?: string;
  decisionId: string;
  ticker: string;
  candidate: OptionCandidate;
  sizing: SizeResult;
}): Promise<string> {
  const pool = getPool();
  const c = params.candidate.contract;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trading.position_journal (
      session_id, decision_id, ticker, option_symbol, option_right,
      strike, expiration, qty, entry_price, current_stop, current_tp,
      conviction_score, conviction_tier, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'OPEN')
    RETURNING id`,
    [
      params.sessionId ?? null,
      params.decisionId,
      params.ticker,
      c.symbol,
      c.side,
      c.strike,
      c.expiration,
      params.sizing.qty,
      params.candidate.entryPremium,
      params.candidate.stopPremium,
      params.candidate.tpPremium,
      params.sizing.convictionScore,
      params.sizing.convictionTier,
    ]
  );
  return rows[0]!.id;
}

export async function closePosition(params: {
  positionId: string;
  exitPrice: number;
  entryPrice: number;
  closeReason: string;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE trading.position_journal
     SET status = 'CLOSED', exit_price = $2, entry_price = $3,
         realized_pnl = (($2 - $3) * qty * 100),
         close_reason = $4, closed_at = NOW()
     WHERE id = $1`,
    [params.positionId, params.exitPrice, params.entryPrice, params.closeReason]
  );
}

export async function getActivePositions(ticker?: string) {
  const pool = getPool();
  const query = ticker
    ? `SELECT * FROM trading.v_active_positions WHERE ticker = $1 ORDER BY opened_at DESC`
    : `SELECT * FROM trading.v_active_positions ORDER BY opened_at DESC`;
  const { rows } = await pool.query(query, ticker ? [ticker] : []);
  return rows;
}
