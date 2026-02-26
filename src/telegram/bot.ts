import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { runPipeline } from '../pipeline/trading-pipeline.js';
import { getActivePositions } from '../db/repositories/positions.js';
import { notifySignalAnalysis } from './notifier.js';
import type { TradingProfile } from '../types/market.js';

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
      `/help — this message`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.help(async (ctx) => {
    await ctx.reply(
      `Commands:\n` +
      `/status — system status\n` +
      `/positions — open positions\n\n` +
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
