import { getPool } from '../client.js';

export interface AgentDispatchRecord {
  positionId: string;
  ticker: string;
  optionSymbol: string;
  orchestratorDecision: string;
  confidence?: number;
  urgency: string;
  reason?: string;
}

export async function insertDispatch(record: AgentDispatchRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trading.order_agent_dispatches
       (position_id, ticker, option_symbol, orchestrator_decision, confidence, urgency, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      record.positionId,
      record.ticker,
      record.optionSymbol,
      record.orchestratorDecision,
      record.confidence ?? null,
      record.urgency,
      record.reason ?? null,
    ],
  );
}

export interface AgentDispatchRow {
  id: string;
  position_id: string;
  ticker: string;
  option_symbol: string;
  orchestrator_decision: string;
  confidence: string | null;
  urgency: string;
  reason: string | null;
  created_at: string;
}

/** Returns dispatches for today, newest first. */
export async function getTodayDispatches(ticker?: string): Promise<AgentDispatchRow[]> {
  const pool = getPool();
  if (ticker) {
    const { rows } = await pool.query<AgentDispatchRow>(
      `SELECT id, position_id, ticker, option_symbol, orchestrator_decision,
              confidence::text, urgency, reason, created_at::text
         FROM trading.order_agent_dispatches
        WHERE ticker = $1
          AND created_at >= CURRENT_DATE
        ORDER BY created_at DESC`,
      [ticker],
    );
    return rows;
  }
  const { rows } = await pool.query<AgentDispatchRow>(
    `SELECT id, position_id, ticker, option_symbol, orchestrator_decision,
            confidence::text, urgency, reason, created_at::text
       FROM trading.order_agent_dispatches
      WHERE created_at >= CURRENT_DATE
      ORDER BY created_at DESC`,
  );
  return rows;
}
