import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/client.js';
import { OrderAgentRegistry } from '../agents/order-agent-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function startDashboard(port: number): void {
  const app = express();
  app.use(express.json());

  // ── Static files ─────────────────────────────────────────────────────────
  app.use(express.static(join(__dirname, 'public')));

  // ── API routes ────────────────────────────────────────────────────────────

  // Active positions
  app.get('/api/positions', async (_req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(`SELECT * FROM trading.v_active_positions ORDER BY opened_at DESC`);
      res.json({ positions: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Recent signals (paginated)
  app.get('/api/signals', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 500);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }, { rows: todayRows }] = await Promise.all([
        pool.query(
          `SELECT id, ticker, profile, direction, alignment, confidence,
                  confidence_meets_threshold, selected_right, selected_symbol,
                  entry_premium, stop_premium, tp_premium, risk_reward,
                  option_liquidity_ok, spread_pct, triggered_by, created_at
           FROM trading.signal_snapshots
           WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.signal_snapshots WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.signal_snapshots WHERE trade_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date`
        ),
      ]);
      res.json({ signals: rows, total: countRows[0]?.total ?? 0, total_today: todayRows[0]?.total ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Trading decisions (paginated)
  app.get('/api/decisions', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 500);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, ticker, profile, direction, decision_type, confirmation_count,
                  orchestration_confidence, urgency, should_execute, reasoning, created_at
           FROM trading.trading_decisions
           WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.trading_decisions WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'`
        ),
      ]);
      res.json({ decisions: rows, total: countRows[0]?.total ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Trade evaluations (paginated)
  app.get('/api/evaluations', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 500);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, ticker, option_symbol, outcome, evaluation_grade, evaluation_score,
                  pnl_total, pnl_pct, hold_duration_min, lessons_learned,
                  signal_quality, timing_quality, risk_management_quality, evaluated_at
           FROM trading.trade_evaluations
           WHERE evaluated_at > NOW() - INTERVAL '30 days'
           ORDER BY evaluated_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.trade_evaluations WHERE evaluated_at > NOW() - INTERVAL '30 days'`
        ),
      ]);
      res.json({ evaluations: rows, total: countRows[0]?.total ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Daily P&L summary
  app.get('/api/pnl/daily', async (_req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT
           trade_date,
           COUNT(*) FILTER (WHERE realized_pnl > 0) AS wins,
           COUNT(*) FILTER (WHERE realized_pnl < 0) AS losses,
           COUNT(*) FILTER (WHERE realized_pnl = 0 OR realized_pnl IS NULL) AS open_or_breakeven,
           SUM(realized_pnl) AS total_pnl,
           AVG(realized_pnl) FILTER (WHERE realized_pnl IS NOT NULL) AS avg_pnl
         FROM trading.position_journal
         WHERE trade_date >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY trade_date
         ORDER BY trade_date DESC`
      );
      res.json({ daily: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Order executions (paginated)
  app.get('/api/orders', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 500);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT * FROM trading.v_recent_executions
           WHERE submitted_at >= NOW() - INTERVAL '7 days'
           ORDER BY submitted_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.v_recent_executions WHERE submitted_at >= NOW() - INTERVAL '7 days'`
        ),
      ]);
      res.json({ orders: rows, total: countRows[0]?.total ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Scheduler runs (paginated)
  app.get('/api/scheduler-runs', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 500);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, run_at, trigger_type, status, skipped_reason,
                  ticker_runs, total_duration_ms, created_at
           FROM trading.scheduler_runs
           WHERE run_at >= NOW() - INTERVAL '7 days'
           ORDER BY run_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.scheduler_runs WHERE run_at >= NOW() - INTERVAL '7 days'`
        ),
      ]);
      res.json({ runs: rows, total: countRows[0]?.total ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Live agent team — in-memory registry snapshot enriched with DB stop/tp + recent AI ticks
  app.get('/api/agents', async (_req, res) => {
    try {
      const agents = OrderAgentRegistry.getInstance().getAll().map(a => a.getStatus());

      if (agents.length === 0) {
        return void res.json({ agents: [] });
      }

      const pool = getPool();
      const positionIds = agents.map(a => a.positionId).filter(Boolean);

      const [{ rows: positions }, { rows: ticks }] = await Promise.all([
        pool.query<{ id: string; current_stop: string | null; current_tp: string | null }>(
          `SELECT id, current_stop::text, current_tp::text
             FROM trading.position_journal
            WHERE id = ANY($1::uuid[])`,
          [positionIds],
        ),
        pool.query<{
          position_id: string;
          tick_count: number;
          action: string;
          pnl_pct: string | null;
          current_price: string | null;
          new_stop: string | null;
          reasoning: string | null;
          overriding_orchestrator: boolean;
          orchestrator_suggestion: string | null;
        }>(
          `SELECT position_id, tick_count, action, pnl_pct::text, current_price::text,
                  new_stop::text, reasoning, overriding_orchestrator, orchestrator_suggestion
             FROM trading.order_agent_ticks
            WHERE position_id = ANY($1::uuid[])
            ORDER BY position_id, tick_count DESC`,
          [positionIds],
        ),
      ]);

      const stopTpMap = new Map(
        positions.map(p => [p.id, { currentStop: p.current_stop, currentTp: p.current_tp }]),
      );

      // Keep the 3 most-recent ticks per position (already ordered DESC by tick_count)
      const tickMap = new Map<string, typeof ticks>();
      for (const tick of ticks) {
        if (!tickMap.has(tick.position_id)) tickMap.set(tick.position_id, []);
        const arr = tickMap.get(tick.position_id)!;
        if (arr.length < 3) arr.push(tick);
      }

      const enriched = agents.map(a => ({
        ...a,
        ...(stopTpMap.get(a.positionId) ?? { currentStop: null, currentTp: null }),
        recentTicks: tickMap.get(a.positionId) ?? [],
      }));

      res.json({ agents: enriched });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, 'public/index.html'));
  });

  app.listen(port, () => {
    console.log(`[Dashboard] Listening on http://localhost:${port}`);
  });
}
