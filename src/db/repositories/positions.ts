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
  // Prefer confirmed fill data from order_executions over passed exitPrice (which may be 0
  // when paper-trading fills arrive asynchronously after the 15s polling window).
  await pool.query(
    `UPDATE trading.position_journal
     SET status      = 'CLOSED',
         entry_price = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE entry_price END,
         exit_price  = COALESCE(
                         NULLIF($2::numeric, 0),
                         (SELECT SUM(oe.fill_price * oe.filled_qty) / NULLIF(SUM(oe.filled_qty), 0)
                          FROM trading.order_executions oe
                          WHERE oe.position_id = $1 AND oe.order_side = 'sell'
                            AND oe.filled_qty > 0 AND oe.fill_price > 0)
                       ),
         realized_pnl = (
                         COALESCE(
                           NULLIF($2::numeric, 0),
                           (SELECT SUM(oe.fill_price * oe.filled_qty) / NULLIF(SUM(oe.filled_qty), 0)
                            FROM trading.order_executions oe
                            WHERE oe.position_id = $1 AND oe.order_side = 'sell'
                              AND oe.filled_qty > 0 AND oe.fill_price > 0)
                         ) -
                         CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE entry_price END
                       ) * qty * 100,
         close_reason = $4,
         closed_at    = NOW()
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
