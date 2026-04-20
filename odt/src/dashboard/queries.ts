import { getPool } from "../tracking/db-pool.js";

export interface RunRow {
  id: string;
  mode: string;
  strategy: string;
  vehicle: string;
  symbol: string;
  started_at: string;
  ended_at: string | null;
  fold_start: string | null;
  fold_end: string | null;
}

export interface PositionRow {
  position_id: string;
  opened_ts: string;
  closed_ts: string | null;
  day: string;
  order_kind: string;
  side: string;
  symbols: string[];
  qty: number;
  filled_debit: number;
  exit_rule: string | null;
  exit_debit: number | null;
  pnl_dollars: number | null;
  hold_minutes: number | null;
  entry_underlying: number;
  signal_ts: string;
  run_id: string;
  run_mode: string;
}

export interface MarkRow {
  ts: string;
  mark_debit: number;
  pnl_pct: number;
  pnl_dollars: number;
  underlying_px: number | null;
}

export interface DailyRow {
  day: string;
  run_id: string;
  mode: string;
  equity_start: number;
  equity_end: number;
  pnl_realized: number;
  signals_total: number;
  signals_accepted: number;
  signals_blocked: number;
  entries_total: number;
  wins: number;
  losses: number;
  max_drawdown: number;
  kill_switch_reason: string | null;
}

export interface SignalRow {
  ts: string;
  side: string;
  reason: string | null;
  atr: number | null;
  entry_price: number | null;
  accepted: boolean;
  block_reason: string | null;
}

function etDay(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

export async function listRecentRuns(limit = 20): Promise<RunRow[]> {
  const res = await getPool().query<RunRow>(
    `SELECT id, mode, strategy, vehicle, symbol, started_at, ended_at, fold_start, fold_end
     FROM trading.odt_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}

export async function todayLive(symbol: string): Promise<{
  run: RunRow | null;
  positions: (PositionRow & { latest_mark?: MarkRow })[];
  signals: SignalRow[];
  daily: DailyRow | null;
}> {
  const pool = getPool();
  const day = etDay();

  const runRes = await pool.query<RunRow>(
    `SELECT id, mode, strategy, vehicle, symbol, started_at, ended_at, fold_start, fold_end
     FROM trading.odt_runs
     WHERE mode = 'live' AND symbol = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [symbol],
  );
  const run = runRes.rows[0] ?? null;
  if (!run) return { run: null, positions: [], signals: [], daily: null };

  const posRes = await pool.query<PositionRow>(
    `SELECT
        p.position_id, p.opened_ts, p.closed_ts, p.day, p.order_kind, p.side,
        p.symbols, p.qty, p.filled_debit, p.exit_rule, p.exit_debit,
        p.pnl_dollars, p.hold_minutes, p.entry_underlying, p.signal_ts,
        p.run_id, r.mode AS run_mode
     FROM trading.odt_positions p
     JOIN trading.odt_runs r ON r.id = p.run_id
     WHERE p.run_id = $1 AND p.day = $2
     ORDER BY p.opened_ts DESC`,
    [run.id, day],
  );

  const positions: (PositionRow & { latest_mark?: MarkRow })[] = [];
  for (const row of posRes.rows) {
    const m = await pool.query<MarkRow>(
      `SELECT ts, mark_debit, pnl_pct, pnl_dollars, underlying_px
       FROM trading.odt_position_marks
       WHERE run_id = $1 AND position_id = $2
       ORDER BY ts DESC LIMIT 1`,
      [run.id, row.position_id],
    );
    positions.push({ ...row, latest_mark: m.rows[0] });
  }

  const sigRes = await pool.query<SignalRow>(
    `SELECT ts, side, reason, atr, entry_price, accepted, block_reason
     FROM trading.odt_signals
     WHERE run_id = $1 AND day = $2
     ORDER BY ts DESC
     LIMIT 50`,
    [run.id, day],
  );

  const dailyRes = await pool.query<DailyRow>(
    `SELECT d.day, d.run_id, r.mode, d.equity_start, d.equity_end, d.pnl_realized,
            d.signals_total, d.signals_accepted, d.signals_blocked,
            d.entries_total, d.wins, d.losses, d.max_drawdown, d.kill_switch_reason
     FROM trading.odt_daily_summaries d
     JOIN trading.odt_runs r ON r.id = d.run_id
     WHERE d.run_id = $1 AND d.day = $2`,
    [run.id, day],
  );

  return { run, positions, signals: sigRes.rows, daily: dailyRes.rows[0] ?? null };
}

export async function compareDay(
  day: string,
  symbol: string,
): Promise<{
  live: { daily: DailyRow | null; positions: PositionRow[] };
  backtest: { daily: DailyRow | null; positions: PositionRow[] };
}> {
  const pool = getPool();
  const fetchMode = async (mode: "live" | "backtest") => {
    const dailyRes = await pool.query<DailyRow>(
      `SELECT d.day, d.run_id, r.mode, d.equity_start, d.equity_end, d.pnl_realized,
              d.signals_total, d.signals_accepted, d.signals_blocked,
              d.entries_total, d.wins, d.losses, d.max_drawdown, d.kill_switch_reason
       FROM trading.odt_daily_summaries d
       JOIN trading.odt_runs r ON r.id = d.run_id
       WHERE r.mode = $1 AND r.symbol = $2 AND d.day = $3
       ORDER BY r.started_at DESC
       LIMIT 1`,
      [mode, symbol, day],
    );
    const daily = dailyRes.rows[0] ?? null;
    if (!daily) return { daily: null, positions: [] };

    const posRes = await pool.query<PositionRow>(
      `SELECT
          p.position_id, p.opened_ts, p.closed_ts, p.day, p.order_kind, p.side,
          p.symbols, p.qty, p.filled_debit, p.exit_rule, p.exit_debit,
          p.pnl_dollars, p.hold_minutes, p.entry_underlying, p.signal_ts,
          p.run_id, r.mode AS run_mode
       FROM trading.odt_positions p
       JOIN trading.odt_runs r ON r.id = p.run_id
       WHERE r.id = $1 AND p.day = $2
       ORDER BY p.opened_ts ASC`,
      [daily.run_id, day],
    );
    return { daily, positions: posRes.rows };
  };
  const [live, backtest] = await Promise.all([fetchMode("live"), fetchMode("backtest")]);
  return { live, backtest };
}

export async function positionMarks(runId: string, positionId: string): Promise<MarkRow[]> {
  const res = await getPool().query<MarkRow>(
    `SELECT ts, mark_debit, pnl_pct, pnl_dollars, underlying_px
     FROM trading.odt_position_marks
     WHERE run_id = $1 AND position_id = $2
     ORDER BY ts ASC`,
    [runId, positionId],
  );
  return res.rows;
}
