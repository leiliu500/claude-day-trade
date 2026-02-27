import 'dotenv/config';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { getPool, closePool } from './db/client.js';
import { createTelegramBot } from './telegram/bot.js';
import { startScheduler } from './scheduler.js';
import { OrderAgentRegistry } from './agents/order-agent-registry.js';
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

  // ── OrderAgent Registry — restore agents for any open positions ──────────
  // Each OrderAgent runs its own 30 s tick (fill sync + stop/TP + expiry).
  await OrderAgentRegistry.getInstance().restoreFromDB();
  console.log(`[Boot] OrderAgentRegistry ready (${OrderAgentRegistry.getInstance().getCount()} agent(s) restored)`);

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
