import { getPool } from '../client.js';

export interface AgentTickRecord {
  positionId: string;
  tickCount: number;
  action: 'HOLD' | 'EXIT' | 'REDUCE' | 'ADJUST_STOP';
  newStop?: number;
  reasoning: string;
  pnlPct: number;
  currentPrice: number;
  overridingOrchestrator: boolean;
  orchestratorSuggestion?: string;
}

export interface AgentTickRow {
  tick_count: number;
  action: string;
  new_stop: string | null;
  reasoning: string | null;
  pnl_pct: string | null;
  current_price: string | null;
  overriding_orchestrator: boolean;
  orchestrator_suggestion: string | null;
  created_at: string;
}

export async function insertAgentTick(record: AgentTickRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trading.order_agent_ticks
       (position_id, tick_count, action, new_stop, reasoning, pnl_pct,
        current_price, overriding_orchestrator, orchestrator_suggestion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      record.positionId,
      record.tickCount,
      record.action,
      record.newStop ?? null,
      record.reasoning,
      record.pnlPct,
      record.currentPrice,
      record.overridingOrchestrator,
      record.orchestratorSuggestion ?? null,
    ],
  );
}

/** Returns the last `limit` ticks in chronological order (oldest first). */
export async function getRecentAgentTicks(positionId: string, limit = 5): Promise<AgentTickRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<AgentTickRow>(
    `SELECT tick_count, action, new_stop::text, reasoning, pnl_pct::text,
            current_price::text, overriding_orchestrator,
            orchestrator_suggestion, created_at::text
       FROM trading.order_agent_ticks
      WHERE position_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [positionId, limit],
  );
  return rows.reverse(); // oldest → newest for AI context
}
