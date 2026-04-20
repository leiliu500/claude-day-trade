import type { Pool } from "pg";
import { getPool } from "./db-pool.js";
import type {
  CloseEvent,
  DailySummary,
  MarkEvent,
  OpenEvent,
  RunMeta,
  SignalEvent,
} from "./types.js";
import type { TrackingSink } from "./sink.js";
import { logger } from "../util/logger.js";

const log = logger("db-sink");

export class DbSink implements TrackingSink {
  runId?: string;
  private pool: Pool;

  constructor(public meta: RunMeta) {
    this.pool = getPool();
  }

  async init(): Promise<void> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO trading.odt_runs (mode, strategy, vehicle, symbol, started_at, fold_start, fold_end, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        this.meta.mode,
        this.meta.strategy,
        this.meta.vehicle,
        this.meta.symbol,
        new Date(this.meta.startedAt),
        this.meta.foldWindow?.start ?? null,
        this.meta.foldWindow?.end ?? null,
        {},
      ],
    );
    this.runId = res.rows[0].id;
    log.info(`db run created id=${this.runId}`);
  }

  async signal(ev: SignalEvent): Promise<void> {
    if (!this.runId) return;
    await this.pool.query(
      `INSERT INTO trading.odt_signals (run_id, ts, day, side, reason, atr, entry_price, accepted, block_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        this.runId,
        new Date(ev.ts),
        ev.day,
        ev.side,
        ev.reason,
        ev.atr,
        ev.entryPrice,
        ev.accepted,
        ev.blockReason ?? null,
      ],
    );
  }

  async open(ev: OpenEvent): Promise<void> {
    if (!this.runId) return;
    await this.pool.query(
      `INSERT INTO trading.odt_positions
         (run_id, position_id, opened_ts, day, order_kind, side, symbols, qty,
          filled_debit, fees, entry_underlying, signal_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (run_id, position_id) DO NOTHING`,
      [
        this.runId,
        ev.positionId,
        new Date(ev.ts),
        ev.day,
        ev.orderKind,
        ev.side,
        ev.symbols,
        ev.qty,
        ev.filledDebit,
        ev.fees,
        ev.entryUnderlying,
        new Date(ev.signalTs),
      ],
    );
  }

  async mark(ev: MarkEvent): Promise<void> {
    if (!this.runId) return;
    await this.pool.query(
      `INSERT INTO trading.odt_position_marks
         (run_id, position_id, ts, mark_debit, pnl_pct, pnl_dollars, underlying_px)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.runId,
        ev.positionId,
        new Date(ev.ts),
        ev.markDebit,
        ev.pnlPct,
        ev.pnlDollars,
        ev.underlyingPx,
      ],
    );
  }

  async close(ev: CloseEvent): Promise<void> {
    if (!this.runId) return;
    await this.pool.query(
      `UPDATE trading.odt_positions
          SET closed_ts = $3,
              exit_rule = $4,
              exit_debit = $5,
              pnl_dollars = $6,
              hold_minutes = $7,
              updated_at = NOW()
        WHERE run_id = $1 AND position_id = $2`,
      [
        this.runId,
        ev.positionId,
        new Date(ev.ts),
        ev.exitRule,
        ev.exitDebit,
        ev.pnlDollars,
        ev.holdMinutes,
      ],
    );
  }

  async endOfDay(summary: DailySummary): Promise<void> {
    if (!this.runId) return;
    await this.pool.query(
      `INSERT INTO trading.odt_daily_summaries
         (run_id, day, equity_start, equity_end, pnl_realized,
          signals_total, signals_accepted, signals_blocked,
          entries_total, wins, losses, max_drawdown, kill_switch_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (run_id, day) DO UPDATE SET
          equity_end = EXCLUDED.equity_end,
          pnl_realized = EXCLUDED.pnl_realized,
          signals_total = EXCLUDED.signals_total,
          signals_accepted = EXCLUDED.signals_accepted,
          signals_blocked = EXCLUDED.signals_blocked,
          entries_total = EXCLUDED.entries_total,
          wins = EXCLUDED.wins,
          losses = EXCLUDED.losses,
          max_drawdown = EXCLUDED.max_drawdown,
          kill_switch_reason = EXCLUDED.kill_switch_reason`,
      [
        this.runId,
        summary.day,
        summary.equityStart,
        summary.equityEnd,
        summary.pnlRealized,
        summary.signalsTotal,
        summary.signalsAccepted,
        summary.signalsBlocked,
        summary.entriesTotal,
        summary.wins,
        summary.losses,
        summary.maxDrawdown,
        summary.killSwitchReason ?? null,
      ],
    );
  }

  async shutdown(): Promise<void> {
    if (!this.runId) return;
    await this.pool.query(
      `UPDATE trading.odt_runs SET ended_at = NOW() WHERE id = $1`,
      [this.runId],
    );
  }
}
