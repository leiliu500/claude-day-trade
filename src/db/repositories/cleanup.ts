import { getPool } from '../client.js';

export interface CleanupResult {
  scope: 'signals' | 'all';
  tablesAffected: string[];
  rowsDeleted: number; // -1 when unknown (TRUNCATE)
}

/**
 * Delete historical signal / decision data older than today.
 * Keeps position_journal, trade_evaluations, order_executions intact.
 */
export async function cleanupSignalHistory(): Promise<CleanupResult> {
  const pool = getPool();
  const tablesAffected: string[] = [];
  let rowsDeleted = 0;

  const steps: Array<{ sql: string; name: string }> = [
    {
      name: 'decision_confirmations',
      sql: `DELETE FROM trading.decision_confirmations WHERE trade_date < CURRENT_DATE`,
    },
    {
      name: 'trading_decisions',
      sql: `DELETE FROM trading.trading_decisions WHERE trade_date < CURRENT_DATE`,
    },
    {
      name: 'signal_snapshots',
      sql: `DELETE FROM trading.signal_snapshots WHERE trade_date < CURRENT_DATE`,
    },
    {
      name: 'trading_sessions',
      sql: `DELETE FROM trading.trading_sessions WHERE trade_date < CURRENT_DATE AND status = 'CLOSED'`,
    },
    {
      name: 'scheduler_runs',
      sql: `DELETE FROM trading.scheduler_runs WHERE run_at::date < CURRENT_DATE`,
    },
    {
      name: 'order_agent_ticks',
      sql: `DELETE FROM trading.order_agent_ticks WHERE created_at::date < CURRENT_DATE`,
    },
    {
      name: 'telegram_interactions',
      sql: `DELETE FROM trading.telegram_interactions WHERE created_at::date < CURRENT_DATE`,
    },
    {
      name: 'human_approvals',
      sql: `DELETE FROM trading.human_approvals WHERE created_at::date < CURRENT_DATE`,
    },
  ];

  for (const { sql, name } of steps) {
    const result = await pool.query(sql);
    const count = result.rowCount ?? 0;
    if (count > 0) {
      tablesAffected.push(`${name} (${count})`);
      rowsDeleted += count;
    }
  }

  return { scope: 'signals', tablesAffected, rowsDeleted };
}

/**
 * Full reset — truncates ALL trading tables.
 * Active OrderAgents must be stopped before calling this.
 */
export async function cleanupAllData(): Promise<CleanupResult> {
  const pool = getPool();

  await pool.query(`
    TRUNCATE TABLE
      trading.broker_open_orders,
      trading.broker_positions,
      trading.order_agent_ticks,
      trading.decision_confirmations,
      trading.trade_evaluations,
      trading.order_executions,
      trading.position_journal,
      trading.trading_decisions,
      trading.signal_snapshots,
      trading.trading_sessions,
      trading.scheduler_runs,
      trading.telegram_interactions,
      trading.human_approvals
    CASCADE
  `);

  return {
    scope: 'all',
    tablesAffected: ['all 11 tables'],
    rowsDeleted: -1,
  };
}
