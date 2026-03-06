import 'dotenv/config';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { closePool } from './db/client.js';
import { createTelegramBot } from './telegram/bot.js';
import { startScheduler } from './scheduler.js';
import { OrderAgentRegistry } from './agents/order-agent-registry.js';
import { AlpacaStreamManager } from './lib/alpaca-stream.js';
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
  bot.launch({ dropPendingUpdates: true }).catch(err => console.error('[TelegramBot] Launch error:', err));
  console.log('[Boot] Telegram bot launched');

  // ── Alpaca WebSocket Streams ────────────────────────────────────────────
  // Opens two persistent connections:
  //   1. Data stream  — real-time 1-min bars for signal-agent bar cache
  //   2. Trading stream — real-time order fill notifications for order-agents
  // The 3-min scheduler and 30 s polling remain as fallbacks.
  const AUTO_TICKERS = ['SPY', 'MSFT'];
  AlpacaStreamManager.getInstance().connect(AUTO_TICKERS);
  console.log(`[Boot] Alpaca stream connecting — tickers: ${AUTO_TICKERS.join(',')}`);

  // Seed cache with 2 trading days of historical 1-min bars so indicators
  // have warmup data from boot (rather than waiting for stream to fill up).
  await AlpacaStreamManager.getInstance().seedHistoricalBars(AUTO_TICKERS);
  console.log('[Boot] Historical bar seed complete');

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
    AlpacaStreamManager.getInstance().disconnect();
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
