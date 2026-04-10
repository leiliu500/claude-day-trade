import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { loadSkill } from '../utils/skill-loader.js';
import { getPool } from '../db/client.js';
import type { EvaluationRecord, TradeLetter } from '../types/trade.js';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

interface TradeData {
  ticker: string;
  optionSymbol: string;
  side: 'call' | 'put';
  strike: number;
  expiration: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  openedAt: string;
  closedAt: string;
  closeReason: string;
  entryConfidence: number;
  entryAlignment: string;
  entryDirection: string;
  entryReasoning: string;
  decisionId?: string;
  positionId?: string;
  /** Risk-reward ratio at entry (tp-entry)/(entry-stop) */
  riskReward?: number;
  stopPremium?: number;
  tpPremium?: number;
}

const EVALUATOR_SYSTEM = loadSkill('evaluation-agent');

export class EvaluationAgent {
  async evaluate(trade: TradeData): Promise<EvaluationRecord> {
    const pnlPerContract = (trade.exitPrice - trade.entryPrice) * 100;
    const pnlTotal = pnlPerContract * trade.qty;
    const pnlPct = trade.entryPrice > 0 ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100 : 0;
    const outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' =
      pnlTotal > 5 ? 'WIN' : pnlTotal < -5 ? 'LOSS' : 'BREAKEVEN';

    const openedMs = new Date(trade.openedAt).getTime();
    const closedMs = new Date(trade.closedAt).getTime();
    const holdDurationMin = Math.round((closedMs - openedMs) / 60_000);

    // Fetch session premium context from earlier signal snapshots
    let sessionContext: {
      session_low: number | null;
      session_high: number | null;
      session_avg: number | null;
      signal_count: number;
      entry_percentile: number | null;
    } = { session_low: null, session_high: null, session_avg: null, signal_count: 0, entry_percentile: null };
    try {
      const pool = getPool();
      const { rows } = await pool.query<{
        low: string | null; high: string | null; avg: string | null; cnt: string;
      }>(
        `SELECT MIN(entry_premium) AS low, MAX(entry_premium) AS high,
                ROUND(AVG(entry_premium)::numeric, 4) AS avg, COUNT(*)::int AS cnt
         FROM trading.signal_snapshots
         WHERE ticker = $1
           AND trade_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
           AND direction = $2
           AND entry_premium IS NOT NULL
           AND created_at < $3`,
        [trade.ticker, trade.entryDirection, trade.openedAt],
      );
      const r = rows[0];
      if (r && Number(r.cnt) > 0) {
        const low = Number(r.low);
        const high = Number(r.high);
        const avg = Number(r.avg);
        const cnt = Number(r.cnt);
        const range = high - low;
        const pctile = range > 0 ? Math.round(((trade.entryPrice - low) / range) * 100) : 50;
        sessionContext = { session_low: low, session_high: high, session_avg: avg, signal_count: cnt, entry_percentile: pctile };
      }
    } catch (err) {
      console.warn('[EvaluationAgent] Session context query failed:', (err as Error).message);
    }

    const payload = {
      ticker: trade.ticker,
      option_symbol: trade.optionSymbol,
      side: trade.side,
      strike: trade.strike,
      expiration: trade.expiration,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      qty: trade.qty,
      pnl_total: pnlTotal,
      pnl_pct: pnlPct,
      outcome,
      hold_duration_min: holdDurationMin,
      close_reason: trade.closeReason,
      entry_confidence: trade.entryConfidence,
      entry_alignment: trade.entryAlignment,
      entry_direction: trade.entryDirection,
      entry_reasoning: trade.entryReasoning,
      // Enriched context for timing evaluation
      risk_reward_at_entry: trade.riskReward ?? null,
      stop_premium: trade.stopPremium ?? null,
      tp_premium: trade.tpPremium ?? null,
      session_premium_context: sessionContext,
    };

    let grade: TradeLetter = 'C';
    let score = 50;
    let outcomeSummary = '';
    let signalQuality = 'FAIR';
    let timingQuality = 'FAIR';
    let riskMgmtQuality = 'FAIR';
    let critique = '';
    let lessonsLearned = 'No lessons extracted';
    let whatWentRight: string[] = [];
    let whatWentWrong: string[] = [];
    let wouldTakeAgain: boolean | undefined;
    let improvementSuggestions: string[] = [];

    try {
      const msg = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: EVALUATOR_SYSTEM },
          { role: 'user', content: JSON.stringify(payload, null, 2) },
        ],
      });

      const text = msg.choices[0]?.message?.content ?? '{}';
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(clean) as {
        grade?: TradeLetter;
        score?: number;
        outcome_summary?: string;
        signal_quality?: string;
        timing_quality?: string;
        risk_management_quality?: string;
        critique?: string;
        what_went_well?: string[];
        what_went_wrong?: string[];
        lessons_learned?: string;
        would_take_again?: boolean;
        improvement_suggestions?: string[];
      };

      grade = parsed.grade ?? 'C';
      score = parsed.score ?? 50;
      outcomeSummary = parsed.outcome_summary ?? '';
      signalQuality = parsed.signal_quality ?? 'FAIR';
      timingQuality = parsed.timing_quality ?? 'FAIR';
      riskMgmtQuality = parsed.risk_management_quality ?? 'FAIR';
      critique = parsed.critique ?? '';
      lessonsLearned = parsed.lessons_learned ?? 'No lessons extracted';
      whatWentRight = parsed.what_went_well ?? [];
      whatWentWrong = parsed.what_went_wrong ?? [];
      wouldTakeAgain = parsed.would_take_again;
      improvementSuggestions = parsed.improvement_suggestions ?? [];
    } catch (err) {
      console.error('[EvaluationAgent] OpenAI error:', err);
      // Fallback: grade based on P&L
      if (outcome === 'WIN') { grade = 'B'; score = 75; }
      else if (outcome === 'LOSS') { grade = 'D'; score = 40; }
      lessonsLearned = 'AI evaluation unavailable.';
    }

    return {
      id: uuidv4(),
      positionId: trade.positionId,
      decisionId: trade.decisionId,
      ticker: trade.ticker,
      optionSymbol: trade.optionSymbol,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      qty: trade.qty,
      pnlTotal,
      pnlPerContract,
      pnlPct,
      holdDurationMin,
      outcome,
      grade,
      score,
      outcomeSummary,
      signalQuality,
      timingQuality,
      riskManagementQuality: riskMgmtQuality,
      critique,
      lessonsLearned,
      whatWentRight,
      whatWentWrong,
      wouldTakeAgain,
      improvementSuggestions,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
