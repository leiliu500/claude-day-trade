import 'dotenv/config';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { getPool, closePool } from './db/client.js';
import { createTelegramBot } from './telegram/bot.js';
import { startScheduler } from './scheduler.js';
import { startPositionMonitor } from './pipeline/position-monitor.js';
import { notifyStartup } from './telegram/notifier.js';
import { startDashboard } from './dashboard/server.js';

async function main(): Promise<void> {
  console.log(`[Boot] claude-day-trade starting (${config.NODE_ENV})`);

  // ── Database ────────────────────────────────────────────────────────────
  console.log('[Boot] Running database migrations...');
  await runMigrations();
  console.log('[Boot] Database ready');

  // ── Dashboard (Express API + static) ───────────────────────────────────
  startDashboard(config.PORT);

  // ── Telegram Bot ────────────────────────────────────────────────────────
  // bot.launch() with long polling never resolves — fire-and-forget
  const bot = createTelegramBot();
  bot.launch().catch(err => console.error('[TelegramBot] Launch error:', err));
  console.log('[Boot] Telegram bot launched');

  // ── AUTO Scheduler ──────────────────────────────────────────────────────
  startScheduler();

  // ── Position Monitor (every 30 s: fill sync + stop/TP + expiry) ─────────
  startPositionMonitor();

  // ── Startup notification ────────────────────────────────────────────────
  await notifyStartup();

  console.log(`[Boot] All systems up. Dashboard: http://localhost:${config.PORT}`);

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[Boot] ${signal} received — shutting down`);
    bot.stop(signal);
    await closePool();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
