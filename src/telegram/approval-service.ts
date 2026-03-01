import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import {
  insertHumanApproval,
  updateHumanApprovalMessageId,
  updateHumanApprovalStatus,
} from '../db/repositories/human-approvals.js';
import type { DecisionResult } from '../types/decision.js';
import type { OptionCandidate } from '../types/options.js';
import type { SizeResult } from '../types/trade.js';

const TELEGRAM_BASE = 'https://api.telegram.org';
const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export type ApprovalOutcome = 'approved' | 'denied' | 'timeout';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalRequest {
  decision: DecisionResult;
  candidate: OptionCandidate;
  sizing: SizeResult;
  confidence: number;
}

/**
 * Singleton service that sends Telegram inline-keyboard approval requests
 * for NEW_ENTRY decisions and awaits human response before proceeding.
 *
 * The pipeline calls requestApproval() which blocks until the user
 * taps Approve/Deny (or the 2-minute timeout fires).
 *
 * The Telegram bot calls handleCallback() when it receives a callback_query.
 */
export class ApprovalService {
  private static _instance: ApprovalService;
  private pending = new Map<string, PendingApproval>();

  static getInstance(): ApprovalService {
    if (!ApprovalService._instance) {
      ApprovalService._instance = new ApprovalService();
    }
    return ApprovalService._instance;
  }

  /**
   * Send approval request to Telegram and wait for human response.
   * Resolves with 'approved' | 'denied' | 'timeout'.
   */
  async requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const approvalId = uuidv4();
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS);
    const { decision, candidate, sizing, confidence } = req;
    const c = candidate.contract;
    const side = c.side.toUpperCase();
    const confPct = (confidence * 100).toFixed(0);

    // Persist PENDING record
    await insertHumanApproval({
      id: approvalId,
      decisionId: decision.id,
      ticker: decision.ticker,
      profile: decision.profile,
      decisionType: decision.decisionType,
      optionSymbol: c.symbol,
      optionSide: c.side,
      qty: sizing.qty,
      limitPrice: sizing.limitPrice,
      confidence,
      reasoning: decision.reasoning.slice(0, 500),
      expiresAt,
    });

    // Build Telegram message
    const fmt2 = (n: number) => n.toFixed(2);
    const msg =
      `🔔 <b>Human Approval Required — NEW_ENTRY</b>\n\n` +
      `📌 <b>${decision.ticker}</b> · Profile: ${decision.profile} · Confidence: <b>${confPct}%</b>\n\n` +
      `🎯 <b>AI Reasoning:</b>\n${decision.reasoning.slice(0, 280)}\n\n` +
      `📋 <b>Trade Plan</b>\n` +
      `  Symbol: <code>${c.symbol}</code>  |  Side: <b>${side}</b>\n` +
      `  Entry: $${fmt2(candidate.entryPremium)} · Stop: $${fmt2(candidate.stopPremium)} · TP: $${fmt2(candidate.tpPremium)}\n` +
      `  R:R ${fmt2(candidate.rrRatio)} · Qty: <b>${sizing.qty}</b> contracts · Limit: $${fmt2(sizing.limitPrice)}\n\n` +
      `⏰ <i>Expires in 2 minutes. No response = DENIED.</i>`;

    const token = config.TELEGRAM_BOT_TOKEN;
    const chatId = config.TELEGRAM_CHAT_ID;
    let messageId: number | undefined;

    try {
      const res = await fetch(`${TELEGRAM_BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve', callback_data: `approve_${approvalId}` },
              { text: '❌ Deny',    callback_data: `deny_${approvalId}` },
            ]],
          },
        }),
      });

      if (res.ok) {
        const data = await res.json() as { ok: boolean; result?: { message_id: number } };
        messageId = data.result?.message_id;
        if (messageId) {
          await updateHumanApprovalMessageId(approvalId, messageId, chatId);
        }
      } else {
        console.error('[ApprovalService] Telegram send failed:', await res.text());
      }
    } catch (err) {
      console.error('[ApprovalService] Telegram send error:', err);
    }

    console.log(`[ApprovalService] Waiting for human approval: ${approvalId} (${decision.ticker} ${decision.decisionType})`);

    // Block pipeline until approved / denied / timeout
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(async () => {
        this.pending.delete(approvalId);
        await updateHumanApprovalStatus(approvalId, 'TIMEOUT').catch(() => {});

        // Edit message to remove buttons and mark expired
        if (messageId) {
          await this.editMessageRemoveButtons(
            chatId,
            messageId,
            msg + '\n\n⏰ <b>Timed out — trade cancelled.</b>',
          );
        }

        console.log(`[ApprovalService] Approval timed out: ${approvalId}`);
        resolve('timeout');
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(approvalId, { resolve, timer });
    });
  }

  /**
   * Called by the Telegram bot when the user taps Approve or Deny.
   * Returns true if the pending request was found and resolved,
   * false if it had already timed out (caller should notify the user).
   */
  async handleCallback(
    approvalId: string,
    action: 'approved' | 'denied',
    from: TelegramUser,
  ): Promise<boolean> {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      // Already timed out or unknown ID
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(approvalId);

    const respondedById   = String(from.id);
    const respondedByName = from.username
      ?? ([from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown');

    await updateHumanApprovalStatus(
      approvalId,
      action === 'approved' ? 'APPROVED' : 'DENIED',
      respondedById,
      respondedByName,
    ).catch(() => {});

    console.log(`[ApprovalService] ${action.toUpperCase()} by ${respondedByName} (${approvalId})`);
    pending.resolve(action);
    return true;
  }

  /** Edit a Telegram message text and remove inline keyboard */
  private async editMessageRemoveButtons(
    chatId: string,
    messageId: number,
    newText: string,
  ): Promise<void> {
    const token = config.TELEGRAM_BOT_TOKEN;
    try {
      await fetch(`${TELEGRAM_BASE}/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: newText.slice(0, 4096),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] },
        }),
      });
    } catch (err) {
      console.error('[ApprovalService] editMessage error:', err);
    }
  }
}
