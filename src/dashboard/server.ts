import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/client.js';
import { OrderAgentRegistry } from '../agents/order-agent-registry.js';
import { cleanupSignalHistory, cleanupAllData } from '../db/repositories/cleanup.js';
import { AlpacaStreamManager } from '../lib/alpaca-stream.js';
import { config } from '../config.js';

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
                  signal_quality, timing_quality, risk_management_quality, evaluated_at,
                  entry_price, exit_price
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

  // Today's closed/partial positions — for position history section
  app.get('/api/positions/history', async (_req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(`
        SELECT
          pj.id,
          pj.ticker,
          pj.option_symbol,
          pj.option_right,
          pj.strike,
          pj.expiration,
          pj.status,
          pj.qty,
          pj.entry_price,
          pj.exit_price,
          pj.realized_pnl,
          pj.conviction_score,
          pj.conviction_tier,
          pj.close_reason,
          pj.opened_at,
          pj.closed_at,
          pj.hold_duration_min,
          td.decision_type,
          td.direction,
          td.confirmation_count,
          td.reasoning AS entry_reasoning,
          te.evaluation_grade,
          te.evaluation_score,
          te.outcome,
          te.pnl_pct
        FROM trading.position_journal pj
        LEFT JOIN trading.trading_decisions td ON pj.decision_id = td.id
        LEFT JOIN trading.trade_evaluations te ON te.position_id = pj.id
        WHERE pj.trade_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
          AND pj.status IN ('CLOSED', 'PARTIALLY_CLOSED')
        ORDER BY pj.closed_at DESC NULLS LAST
      `);
      res.json({ positions: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Today's agent history — all positions opened today (DB) with full tick history
  app.get('/api/agents/history', async (_req, res) => {
    try {
      const pool = getPool();
      const { rows: positions } = await pool.query(`
        SELECT
          pj.id,
          pj.ticker,
          pj.option_symbol,
          pj.option_right,
          pj.strike::text,
          pj.expiration,
          pj.status,
          pj.qty,
          pj.entry_price::text,
          pj.current_stop::text,
          pj.current_tp::text,
          pj.exit_price::text,
          pj.realized_pnl::text,
          pj.conviction_score,
          pj.conviction_tier,
          pj.close_reason,
          pj.opened_at,
          pj.closed_at,
          pj.hold_duration_min,
          td.direction,
          td.profile,
          td.decision_type,
          td.reasoning AS entry_reasoning,
          td.orchestration_confidence::text AS confidence,
          te.evaluation_grade,
          te.evaluation_score,
          te.outcome,
          te.signal_quality,
          te.timing_quality,
          te.risk_management_quality,
          te.lessons_learned
        FROM trading.position_journal pj
        LEFT JOIN trading.trading_decisions td ON td.id = pj.decision_id
        LEFT JOIN trading.trade_evaluations te ON te.position_id = pj.id
        WHERE pj.trade_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
        ORDER BY pj.opened_at DESC
      `);

      if (positions.length === 0) {
        return void res.json({ positions: [] });
      }

      const positionIds = positions.map(p => p.id);
      const [{ rows: ticks }, { rows: dispatches }] = await Promise.all([
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
        pool.query<{
          position_id: string;
          orchestrator_decision: string;
          confidence: string | null;
          urgency: string;
          reason: string | null;
          created_at: string;
        }>(
          `SELECT position_id, orchestrator_decision, confidence::text, urgency, reason, created_at::text
             FROM trading.order_agent_dispatches
            WHERE position_id = ANY($1::uuid[])
            ORDER BY position_id, created_at DESC`,
          [positionIds],
        ),
      ]);

      const tickMap = new Map<string, typeof ticks>();
      for (const tick of ticks) {
        if (!tickMap.has(tick.position_id)) tickMap.set(tick.position_id, []);
        tickMap.get(tick.position_id)!.push(tick);
      }

      const dispatchMap = new Map<string, typeof dispatches>();
      for (const d of dispatches) {
        if (!dispatchMap.has(d.position_id)) dispatchMap.set(d.position_id, []);
        dispatchMap.get(d.position_id)!.push(d);
      }

      const enriched = positions.map(p => ({
        ...p,
        ticks:      tickMap.get(p.id)      ?? [],
        dispatches: dispatchMap.get(p.id)  ?? [],
      }));
      res.json({ positions: enriched });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Today's dispatches — proves orchestrator always reaches active agents (even low-confidence)
  app.get('/api/dispatches', async (req, res) => {
    try {
      const pool = getPool();
      const limit  = Math.min(parseInt(String(req.query['limit'] ?? '100')), 500);
      const page   = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT d.id, d.position_id, d.ticker, d.option_symbol,
                  d.orchestrator_decision, d.confidence::text, d.urgency,
                  d.reason, d.created_at::text,
                  oat.action AS agent_action, oat.pnl_pct::text AS agent_pnl_pct,
                  oat.overriding_orchestrator, oat.reasoning AS agent_reasoning
             FROM trading.order_agent_dispatches d
             LEFT JOIN LATERAL (
               SELECT action, pnl_pct, overriding_orchestrator, reasoning
                 FROM trading.order_agent_ticks t
                WHERE t.position_id = d.position_id
                  AND t.created_at >= d.created_at
                ORDER BY t.created_at ASC
                LIMIT 1
             ) oat ON true
            WHERE d.created_at >= CURRENT_DATE
            ORDER BY d.created_at DESC
            LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        pool.query(`SELECT COUNT(*)::int AS total FROM trading.order_agent_dispatches WHERE created_at >= CURRENT_DATE`),
      ]);
      res.json({ dispatches: rows, total: countRows[0]?.total ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/closeall — close positions for a symbol or all ─────────────
  // Body (optional): { ticker: "SPY" }  — omit to close all symbols
  app.post('/api/closeall', async (req, res) => {
    try {
      const rawTicker = req.body?.ticker;
      const ticker: string | undefined =
        typeof rawTicker === 'string' && /^[A-Z]{1,5}$/.test(rawTicker.toUpperCase())
          ? rawTicker.toUpperCase()
          : undefined;

      const { closeAllPositions: alpacaCloseAll, cancelAllOpenOrders } = await import('../lib/alpaca-api.js');

      const registry = OrderAgentRegistry.getInstance();
      const [result, alpacaResult] = await Promise.all([
        registry.closeAllPositions(
          `User-initiated via dashboard /api/closeall${ticker ? ` ${ticker}` : ''}`,
          ticker,
        ),
        // Also liquidate directly on Alpaca to catch any positions not tracked in DB
        ticker ? Promise.resolve({ closed: 0, errors: [] }) : alpacaCloseAll(),
      ]);

      const totalErrors = [...result.errors, ...alpacaResult.errors];
      res.json({
        ok: true,
        ticker: ticker ?? 'ALL',
        agentsNotified: result.agentsNotified,
        dbFallbackClosed: result.dbFallbackClosed,
        ordersCancelled: result.ordersCancelled,
        alpacaClosed: alpacaResult.closed,
        errors: totalErrors,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // ── GET /api/alpaca — live positions + open orders from Alpaca REST ─────────
  app.get('/api/alpaca', async (_req, res) => {
    const headers = {
      'APCA-API-KEY-ID': config.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
    };
    try {
      const [posRes, ordRes] = await Promise.all([
        fetch(`${config.ALPACA_BASE_URL}/v2/positions`, { headers }),
        fetch(`${config.ALPACA_BASE_URL}/v2/orders?status=open&limit=100`, { headers }),
      ]);
      const [positions, orders] = await Promise.all([posRes.json(), ordRes.json()]);
      res.json({ positions, orders });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/purge-cache — clear the in-memory 1-min bar cache ──────────
  app.post('/api/purge-cache', (_req, res) => {
    try {
      const result = AlpacaStreamManager.getInstance().purgeCache();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // ── POST /api/cleanup — delete old data or full reset ────────────────────
  // Body: { scope: 'signals' | 'all' }
  app.post('/api/cleanup', async (req, res) => {
    try {
      const scope = req.body?.scope === 'all' ? 'all' : 'signals';
      const result = scope === 'all'
        ? await cleanupAllData()
        : await cleanupSignalHistory();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Human approval requests (paginated)
  app.get('/api/approvals', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 500);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }, { rows: pendingRows }] = await Promise.all([
        pool.query(
          `SELECT id, ticker, profile, decision_type, option_symbol, option_side,
                  qty, limit_price, confidence, status,
                  responded_by_name, responded_at, created_at, expires_at
           FROM trading.human_approvals
           WHERE created_at >= NOW() - INTERVAL '7 days'
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.human_approvals WHERE created_at >= NOW() - INTERVAL '7 days'`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS pending FROM trading.human_approvals WHERE status = 'PENDING' AND expires_at > NOW()`
        ),
      ]);
      res.json({ approvals: rows, total: countRows[0]?.total ?? 0, pending: pendingRows[0]?.pending ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Telegram interactions log (paginated)
  app.get('/api/interactions', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 500);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, command, raw_text, user_id, user_name, chat_id,
                  params, outcome, error_message, created_at
           FROM trading.telegram_interactions
           WHERE created_at >= NOW() - INTERVAL '7 days'
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.telegram_interactions WHERE created_at >= NOW() - INTERVAL '7 days'`
        ),
      ]);
      res.json({ interactions: rows, total: countRows[0]?.total ?? 0, page, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Analysis Agent output — signal snapshots with full analysis_payload + signal_payload
  app.get('/api/analysis', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '30')), 200);
      const page  = Math.max(parseInt(String(req.query['page']  ?? '1')), 1);
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, ticker, profile, direction, alignment, confidence,
                  confidence_meets_threshold, selected_right, selected_symbol,
                  entry_premium, stop_premium, tp_premium, risk_reward,
                  option_liquidity_ok, spread_pct, triggered_by, created_at,
                  analysis_payload, signal_payload
           FROM trading.signal_snapshots
           WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM trading.signal_snapshots WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'`
        ),
      ]);
      res.json({ signals: rows, total: countRows[0]?.total ?? 0, page, limit });
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
