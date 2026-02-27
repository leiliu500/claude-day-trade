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

  // Recent signals (last 50 today)
  app.get('/api/signals', async (req, res) => {
    try {
      const pool = getPool();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 200);
      const { rows } = await pool.query(
        `SELECT id, ticker, profile, direction, alignment, confidence,
                confidence_meets_threshold, selected_right, selected_symbol,
                entry_premium, risk_reward, option_liquidity_ok, triggered_by, created_at
         FROM trading.signal_snapshots
         WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json({ signals: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Trading decisions (today)
  app.get('/api/decisions', async (_req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, ticker, profile, decision_type, confirmation_count,
                orchestration_confidence, should_execute, reasoning, created_at
         FROM trading.trading_decisions
         WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT 100`
      );
      res.json({ decisions: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Trade evaluations (last 30 days)
  app.get('/api/evaluations', async (_req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, ticker, option_symbol, outcome, evaluation_grade, evaluation_score,
                pnl_total, pnl_pct, hold_duration_min, lessons_learned,
                signal_quality, timing_quality, risk_management_quality, evaluated_at
         FROM trading.trade_evaluations
         WHERE evaluated_at > NOW() - INTERVAL '30 days'
         ORDER BY evaluated_at DESC
         LIMIT 100`
      );
      res.json({ evaluations: rows });
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

  // Order executions (today)
  app.get('/api/orders', async (_req, res) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT * FROM trading.v_recent_executions
         WHERE submitted_at >= NOW() - INTERVAL '7 days'
         LIMIT 50`
      );
      res.json({ orders: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Live agent team (in-memory registry snapshot)
  app.get('/api/agents', (_req, res) => {
    try {
      const agents = OrderAgentRegistry.getInstance().getAll().map(a => a.getStatus());
      res.json({ agents });
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
