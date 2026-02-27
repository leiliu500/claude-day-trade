/**
 * Daily Database Cleanup
 *
 * Runs at 07:00 UTC Mon-Fri (before US market open at 14:30 UTC).
 * Truncates all trading tables so each day starts with an empty slate.
 *
 * Deletion order respects FK constraints:
 *   trade_evaluations → order_executions → decision_confirmations
 *   → position_journal → trading_decisions → signal_snapshots
 *   → trading_sessions → broker_open_orders → broker_positions
 *
 * Before truncating the DB the registry is told to hard-stop any lingering
 * agents (should be zero at 07:00 UTC, but handled defensively).
 */

import { getPool } from '../db/client.js';
import { OrderAgentRegistry } from '../agents/order-agent-registry.js';
import { notifyDailyCleanup } from '../telegram/notifier.js';

interface CleanupResult {
  success: boolean;
  deletedRows: Record<string, number>;
  error?: string;
}

const TABLES_IN_ORDER: Array<{ schema: string; name: string; label: string }> = [
  { schema: 'trading', name: 'trade_evaluations',     label: 'Evaluations' },
  { schema: 'trading', name: 'order_executions',      label: 'Orders' },
  { schema: 'trading', name: 'decision_confirmations', label: 'Confirmations' },
  { schema: 'trading', name: 'position_journal',      label: 'Positions' },
  { schema: 'trading', name: 'trading_decisions',     label: 'Decisions' },
  { schema: 'trading', name: 'signal_snapshots',      label: 'Signals' },
  { schema: 'trading', name: 'trading_sessions',      label: 'Sessions' },
  { schema: 'trading', name: 'broker_open_orders',    label: 'BrokerOrders' },
  { schema: 'trading', name: 'broker_positions',      label: 'BrokerPositions' },
];

async function truncateAll(pool: ReturnType<typeof getPool>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // Run inside a single transaction so either all tables are cleared or none
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const t of TABLES_IN_ORDER) {
      const res = await client.query<{ count: string }>(
        `DELETE FROM ${t.schema}.${t.name}`,
      );
      counts[t.label] = res.rowCount ?? 0;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return counts;
}

export async function runDailyCleanup(): Promise<void> {
  const utcNow = new Date().toUTCString();
  console.log(`[DailyCleanup] Starting at ${utcNow}`);

  const registry = OrderAgentRegistry.getInstance();
  const agentsBefore = registry.getCount();

  // 1. Hard-stop any lingering agents before touching the DB
  if (agentsBefore > 0) {
    console.warn(
      `[DailyCleanup] ${agentsBefore} agent(s) still active at cleanup time — shutting down`,
    );
    registry.shutdownAll();
  }

  // 2. Truncate all tables
  const pool = getPool();
  let result: CleanupResult;

  try {
    const deletedRows = await truncateAll(pool);
    result = { success: true, deletedRows };

    const summary = Object.entries(deletedRows)
      .map(([label, n]) => `${label}: ${n}`)
      .join(', ');
    console.log(`[DailyCleanup] Done — ${summary}`);
  } catch (err) {
    const error = (err as Error).message;
    result = { success: false, deletedRows: {}, error };
    console.error('[DailyCleanup] Failed:', error);
  }

  // 3. Telegram notification
  try {
    await notifyDailyCleanup(result.success, result.deletedRows, agentsBefore, result.error);
  } catch {
    // Telegram failure must not crash the cleanup
  }
}
