import { getPool } from '../client.js';

export interface TickerRunResult {
  ticker: string;
  profile: string;
  status: 'ok' | 'error';
  decision?: string;
  duration_ms: number;
  error?: string;
}

/** Insert a new scheduler run row. Returns the generated id. */
export async function insertSchedulerRun(
  runAt: Date,
  triggerType: 'AUTO' | 'MANUAL',
  status: 'RUNNING' | 'SKIPPED',
  skippedReason?: 'PREV_RUN_ACTIVE',
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trading.scheduler_runs (run_at, trigger_type, status, skipped_reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [runAt, triggerType, status, skippedReason ?? null],
  );
  return rows[0]!.id;
}

/** Finalize a RUNNING row with outcome, per-ticker results, and total duration. */
export async function completeSchedulerRun(
  id: string,
  status: 'COMPLETED' | 'TIMEOUT',
  tickerRuns: TickerRunResult[],
  totalDurationMs: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE trading.scheduler_runs
     SET status = $1, ticker_runs = $2::jsonb, total_duration_ms = $3
     WHERE id = $4`,
    [status, JSON.stringify(tickerRuns), totalDurationMs, id],
  );
}
