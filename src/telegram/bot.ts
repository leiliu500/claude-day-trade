import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { runPipeline } from '../pipeline/trading-pipeline.js';
import { getActivePositions } from '../db/repositories/positions.js';
import { notifySignalAnalysis } from './notifier.js';
import { OrderAgentRegistry } from '../agents/order-agent-registry.js';
import { cleanupSignalHistory, cleanupAllData } from '../db/repositories/cleanup.js';
import type { TradingProfile } from '../types/market.js';

// Pending close-all confirmations: chatId → expiry timestamp
const pendingCloseAll = new Map<number, number>();
// Pending cleanup confirmations: `${chatId}:${scope}` → expiry timestamp
const pendingCleanup = new Map<string, number>();
const CONFIRM_TTL_MS = 30_000; // 30 seconds to confirm

const VALID_PROFILES = ['S', 'M', 'L'] as const;

/** Parse a Telegram message like "SPY S" or "QQQ" → { ticker, profile } */
function parseTradeRequest(text: string): { ticker: string; profile: TradingProfile } | null {
  const parts = text.trim().toUpperCase().split(/\s+/);
  if (parts.length === 0) return null;

  const ticker = parts[0];
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) return null;

  const rawProfile = parts[1] as TradingProfile | undefined;
  const profile: TradingProfile = rawProfile && VALID_PROFILES.includes(rawProfile)
    ? rawProfile
    : 'S'; // default to Scalp

  return { ticker, profile };
}

export function createTelegramBot(): Telegraf {
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    await ctx.reply(
      `🤖 Day Trade Bot\n\n` +
      `Send <TICKER> <PROFILE> to analyze:\n` +
      `  <code>SPY S</code> — Scalp (2m/3m/5m)\n` +
      `  <code>QQQ M</code> — Medium (1m/5m/15m)\n` +
      `  <code>AAPL L</code> — Long (5m/1h/1d)\n\n` +
      `Commands:\n` +
      `/status — system status\n` +
      `/positions — open positions\n` +
      `/closeall [TICKER] — close positions (e.g. /closeall SPY)\n` +
      `/cleanup [all] — delete old DB data (add "all" for full reset)\n` +
      `/help — this message`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.help(async (ctx) => {
    await ctx.reply(
      `Commands:\n` +
      `/status — system status\n` +
      `/positions — open positions\n` +
      `/closeall [TICKER] — close positions (e.g. /closeall SPY)\n` +
      `/cleanup — delete signal/decision history older than today\n` +
      `/cleanup all — ⚠️ full reset (truncates ALL tables)\n\n` +
      `Trade trigger: <code>SPY S</code>`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const positions = await getActivePositions();
    const msg = `✅ System running\n📍 Open positions: ${positions.length}\n🕐 ${new Date().toUTCString()}`;
    await ctx.reply(msg);
  });

  // ── /positions ────────────────────────────────────────────────────────────
  bot.command('positions', async (ctx) => {
    const positions = await getActivePositions();
    if (positions.length === 0) {
      await ctx.reply('No open positions.');
      return;
    }

    let msg = `<b>Open Positions (${positions.length})</b>\n\n`;
    for (const p of positions) {
      msg += `📋 <code>${p.option_symbol}</code>\n`;
      msg += `  ${p.option_right?.toUpperCase()} @ $${parseFloat(p.entry_price).toFixed(2)}\n`;
      msg += `  Qty: ${p.qty} | Stop: $${p.current_stop ? parseFloat(p.current_stop).toFixed(2) : 'N/A'}\n`;
      msg += `  TP: $${p.current_tp ? parseFloat(p.current_tp).toFixed(2) : 'N/A'}\n\n`;
    }
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── /closeall [TICKER] ────────────────────────────────────────────────────
  // Examples:  /closeall SPY   → close all SPY positions
  //            /closeall       → close ALL positions across every symbol
  bot.command('closeall', async (ctx) => {
    const chatId = ctx.chat.id;
    const now = Date.now();

    // Parse optional ticker argument from "/closeall SPY"
    const parts = ctx.message.text.trim().split(/\s+/);
    const rawTicker = parts[1]?.toUpperCase();
    const ticker = rawTicker && /^[A-Z]{1,5}$/.test(rawTicker) ? rawTicker : undefined;

    // Confirmation key includes the ticker so "/closeall SPY" and "/closeall" are separate flows
    const confirmKey = ticker ? `${chatId}:${ticker}` : `${chatId}:ALL`;
    const pending = pendingCloseAll.get(chatId);

    if (!pending || now > pending) {
      // First call — request confirmation
      const allPositions = await getActivePositions();
      const positions = ticker
        ? allPositions.filter(p => p.ticker === ticker)
        : allPositions;

      pendingCloseAll.set(chatId, now + CONFIRM_TTL_MS);
      const scope = ticker ? `<b>${ticker}</b>` : '<b>ALL symbols</b>';
      await ctx.reply(
        `⚠️ <b>Close Positions: ${ticker ?? 'ALL'}</b>\n\n` +
        `This will immediately exit <b>${positions.length}</b> open position(s) for ${scope} ` +
        `and cancel their pending orders.\n\n` +
        `Send <code>/closeall${ticker ? ` ${ticker}` : ''}</code> again within 30 seconds to confirm.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Confirmed — execute
    pendingCloseAll.delete(chatId);
    const scopeLabel = ticker ?? 'ALL';
    await ctx.reply(`🔴 Closing positions for ${scopeLabel}...`);

    try {
      const registry = OrderAgentRegistry.getInstance();
      const result = await registry.closeAllPositions(
        `User-initiated via Telegram /closeall${ticker ? ` ${ticker}` : ''}`,
        ticker,
      );

      const lines: string[] = [`✅ <b>Close Complete (${scopeLabel})</b>\n`];
      if (result.agentsNotified > 0)   lines.push(`• ${result.agentsNotified} position agent(s) notified`);
      if (result.dbFallbackClosed > 0) lines.push(`• ${result.dbFallbackClosed} DB position(s) force-closed`);
      if (result.ordersCancelled > 0)  lines.push(`• ${result.ordersCancelled} pending order(s) cancelled`);
      if (result.errors.length > 0)    lines.push(`\n⚠️ Errors (${result.errors.length}):\n${result.errors.join('\n')}`);
      if (result.agentsNotified === 0 && result.dbFallbackClosed === 0 && result.ordersCancelled === 0) {
        lines.push('• No open positions or orders found.');
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ Close failed: ${(err as Error).message}`);
    }
  });

  // ── /cleanup [all] ────────────────────────────────────────────────────────
  // /cleanup       → delete signal/decision history older than today
  // /cleanup all   → TRUNCATE all trading tables (full reset)
  bot.command('cleanup', async (ctx) => {
    const chatId = ctx.chat.id;
    const now = Date.now();

    const parts = ctx.message.text.trim().split(/\s+/);
    const scope = parts[1]?.toLowerCase() === 'all' ? 'all' : 'signals';
    const confirmKey = `${chatId}:${scope}`;
    const expiry = pendingCleanup.get(confirmKey);

    if (!expiry || now > expiry) {
      // First call — request confirmation
      pendingCleanup.set(confirmKey, now + CONFIRM_TTL_MS);

      if (scope === 'all') {
        await ctx.reply(
          `⚠️ <b>FULL DATABASE RESET</b>\n\n` +
          `This will <b>TRUNCATE all 11 tables</b> in the trading schema:\n` +
          `• signal_snapshots, trading_decisions, decision_confirmations\n` +
          `• position_journal, order_executions, trade_evaluations\n` +
          `• trading_sessions, order_agent_ticks, scheduler_runs\n` +
          `• broker_positions, broker_open_orders\n\n` +
          `All history will be permanently deleted.\n\n` +
          `Send <code>/cleanup all</code> again within 30 seconds to confirm.`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.reply(
          `⚠️ <b>Cleanup: Signal History</b>\n\n` +
          `This will delete rows older than today from:\n` +
          `• signal_snapshots, trading_decisions, decision_confirmations\n` +
          `• trading_sessions (CLOSED only), scheduler_runs, order_agent_ticks\n\n` +
          `Position journal and trade evaluations are <b>not</b> affected.\n\n` +
          `Send <code>/cleanup</code> again within 30 seconds to confirm.`,
          { parse_mode: 'HTML' },
        );
      }
      return;
    }

    // Confirmed — execute
    pendingCleanup.delete(confirmKey);
    await ctx.reply(`🗑️ Running ${scope === 'all' ? 'full reset' : 'signal history cleanup'}...`);

    try {
      const result = scope === 'all'
        ? await cleanupAllData()
        : await cleanupSignalHistory();

      if (scope === 'all') {
        await ctx.reply(
          `✅ <b>Full Reset Complete</b>\n\n` +
          `All trading tables have been truncated.`,
          { parse_mode: 'HTML' },
        );
      } else {
        const lines = [`✅ <b>Cleanup Complete</b>\n`];
        if (result.tablesAffected.length === 0) {
          lines.push('• Nothing to clean — no data older than today.');
        } else {
          lines.push(`• Deleted ${result.rowsDeleted} row(s) from:`);
          for (const t of result.tablesAffected) lines.push(`  – ${t}`);
        }
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
      }
    } catch (err) {
      await ctx.reply(`❌ Cleanup failed: ${(err as Error).message}`);
    }
  });

  // ── Trade trigger: "SPY S", "QQQ M", etc. ────────────────────────────────
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    // Ignore commands (already handled above)
    if (text.startsWith('/')) return;

    const parsed = parseTradeRequest(text);
    if (!parsed) {
      await ctx.reply('Format: <code>SPY S</code> (ticker + profile S/M/L)', { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(`🔍 Analyzing ${parsed.ticker} (${parsed.profile} profile)...`);

    try {
      const result = await runPipeline(parsed.ticker, parsed.profile, 'MANUAL');
      await notifySignalAnalysis(result);
    } catch (err) {
      await ctx.reply(`❌ Pipeline error: ${(err as Error).message}`);
    }
  });

  // Error handler
  bot.catch((err, ctx) => {
    console.error('[TelegramBot] Error:', err, 'for update:', ctx.updateType);
  });

  return bot;
}
