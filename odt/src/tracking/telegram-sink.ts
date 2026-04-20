import { Telegraf } from "telegraf";
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

const log = logger("telegram-sink");

const PNL_BUCKETS = [-75, -50, -25, 25, 50, 75, 100, 150, 200] as const;

function pnlBucket(pctMove: number): number | null {
  const pct = pctMove * 100;
  let best: number | null = null;
  for (const b of PNL_BUCKETS) {
    if (b > 0 && pct >= b) best = best === null || b > best ? b : best;
    else if (b < 0 && pct <= b) best = best === null || b < best ? b : best;
  }
  return best;
}

function emojiForPnl(pnl: number): string {
  if (pnl >= 0) return "🟢";
  if (pnl > -50) return "🟡";
  return "🔴";
}

function fmtUsd(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export interface TelegramConfig {
  token: string;
  chatId: string;
  notifyOnMark?: boolean;
  notifyOnSignal?: boolean;
  notifyOnBlock?: boolean;
}

export class TelegramSink implements TrackingSink {
  runId?: string;
  private bot: Telegraf;
  private cfg: TelegramConfig;
  private lastBucket = new Map<string, number>();
  private openDetails = new Map<string, { filledDebit: number; symbol: string; side: string; qty: number }>();

  constructor(public meta: RunMeta, cfg: TelegramConfig) {
    this.cfg = {
      notifyOnMark: true,
      notifyOnSignal: false,
      notifyOnBlock: false,
      ...cfg,
    };
    this.bot = new Telegraf(cfg.token);
  }

  private async send(html: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.cfg.chatId, html, { parse_mode: "HTML" });
    } catch (e) {
      log.warn(`telegram send failed: ${(e as Error).message}`);
    }
  }

  async init(): Promise<void> {
    if (this.meta.mode !== "live") return;
    const fold = this.meta.foldWindow
      ? `  ${this.meta.foldWindow.start} → ${this.meta.foldWindow.end}`
      : "";
    await this.send(
      `🚀 <b>odt run started</b>\n` +
        `mode: <code>${this.meta.mode}</code>\n` +
        `strategy: <code>${this.meta.strategy}</code>\n` +
        `vehicle: <code>${this.meta.vehicle}</code>\n` +
        `symbol: <code>${this.meta.symbol}</code>${fold}`,
    );
  }

  async signal(ev: SignalEvent): Promise<void> {
    if (this.meta.mode !== "live") return;
    if (!this.cfg.notifyOnSignal) {
      if (!ev.accepted && this.cfg.notifyOnBlock) {
        await this.send(
          `⚠️ <b>signal blocked</b>\n` +
            `${ev.side} @ ${ev.entryPrice.toFixed(2)}\n` +
            `reason: <code>${ev.blockReason ?? "unknown"}</code>`,
        );
      }
      return;
    }
    const tag = ev.accepted ? "✅" : "⛔";
    const trailer = ev.accepted ? "" : `\nblocked: <code>${ev.blockReason}</code>`;
    await this.send(
      `${tag} <b>signal</b> ${ev.side} @ ${ev.entryPrice.toFixed(2)}\n` +
        `reason: ${ev.reason}${trailer}`,
    );
  }

  async open(ev: OpenEvent): Promise<void> {
    if (this.meta.mode !== "live") return;
    const primarySymbol = ev.symbols[0];
    this.openDetails.set(ev.positionId, {
      filledDebit: ev.filledDebit,
      symbol: primarySymbol,
      side: ev.side,
      qty: ev.qty,
    });
    this.lastBucket.set(ev.positionId, 0);
    await this.send(
      `🟢 <b>OPEN</b> ${ev.side} ${ev.orderKind}\n` +
        `${ev.qty}× <code>${primarySymbol}</code>\n` +
        `debit: <code>$${ev.filledDebit.toFixed(2)}</code>  underlying: ${ev.entryUnderlying.toFixed(2)}`,
    );
  }

  async mark(ev: MarkEvent): Promise<void> {
    if (this.meta.mode !== "live" || !this.cfg.notifyOnMark) return;
    const current = pnlBucket(ev.pnlPct);
    if (current === null) return;
    const last = this.lastBucket.get(ev.positionId);
    if (last !== undefined) {
      const crossed =
        (current > 0 && current > last) ||
        (current < 0 && current < last);
      if (!crossed) return;
    }
    this.lastBucket.set(ev.positionId, current);
    const deets = this.openDetails.get(ev.positionId);
    const sym = deets?.symbol ?? ev.positionId;
    const qty = deets?.qty ?? 1;
    await this.send(
      `${emojiForPnl(ev.pnlDollars)} <b>${current > 0 ? "+" : ""}${current}%</b> ` +
        `<code>${sym}</code> (${qty}×)\n` +
        `mark: <code>$${ev.markDebit.toFixed(2)}</code>  ` +
        `P&amp;L: <code>${fmtUsd(ev.pnlDollars)}</code>  ` +
        `SPY: ${ev.underlyingPx.toFixed(2)}`,
    );
  }

  async close(ev: CloseEvent): Promise<void> {
    if (this.meta.mode !== "live") return;
    this.lastBucket.delete(ev.positionId);
    const deets = this.openDetails.get(ev.positionId);
    this.openDetails.delete(ev.positionId);
    const sym = deets?.symbol ?? ev.positionId;
    const emoji = ev.pnlDollars >= 0 ? "✅" : "❌";
    await this.send(
      `${emoji} <b>CLOSE</b> <code>${sym}</code>\n` +
        `exit: <code>${ev.exitRule}</code>  held ${ev.holdMinutes}m\n` +
        `debit: <code>$${ev.exitDebit.toFixed(2)}</code>  ` +
        `P&amp;L: <b>${fmtUsd(ev.pnlDollars)}</b>`,
    );
  }

  async endOfDay(summary: DailySummary): Promise<void> {
    if (this.meta.mode !== "live") return;
    const emoji = summary.pnlRealized >= 0 ? "📈" : "📉";
    const kill = summary.killSwitchReason ? `\nkill: <code>${summary.killSwitchReason}</code>` : "";
    const wr = summary.entriesTotal > 0
      ? `${((summary.wins / summary.entriesTotal) * 100).toFixed(0)}%`
      : "—";
    await this.send(
      `${emoji} <b>EOD ${summary.day}</b> ${summary.symbol}\n` +
        `trades: ${summary.entriesTotal} (${summary.wins}W/${summary.losses}L, WR ${wr})\n` +
        `signals: ${summary.signalsAccepted}/${summary.signalsTotal} taken\n` +
        `P&amp;L: <b>${fmtUsd(summary.pnlRealized)}</b>  ` +
        `equity: <code>$${summary.equityEnd.toFixed(2)}</code>\n` +
        `max DD: <code>$${summary.maxDrawdown.toFixed(2)}</code>${kill}`,
    );
  }

  async shutdown(): Promise<void> {
    this.openDetails.clear();
    this.lastBucket.clear();
  }
}

export function makeTelegramSinkFromEnv(meta: RunMeta): TelegramSink | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log.warn("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — telegram notifications disabled");
    return null;
  }
  return new TelegramSink(meta, { token, chatId });
}
