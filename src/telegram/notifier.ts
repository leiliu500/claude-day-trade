import { config } from '../config.js';
import type { PipelineResult } from '../pipeline/trading-pipeline.js';
import type { EvaluationRecord } from '../types/trade.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation, OptionCandidate } from '../types/options.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { DecisionResult } from '../types/decision.js';
import type { SizeResult } from '../types/trade.js';

const TELEGRAM_BASE = 'https://api.telegram.org';

async function sendMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;

  try {
    const res = await fetch(`${TELEGRAM_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[Telegram] Send error:', err);
    }
  } catch (err) {
    console.error('[Telegram] Network error:', err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(dp);
}

function fmtDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return (n >= 0 ? '+' : '') + n.toFixed(3);
}

function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(dp)}%`;
}

// ── Header helpers ─────────────────────────────────────────────────────────────

function computeStrength(signal: SignalPayload): string {
  const score = signal.strengthScore;
  const htfAdx = signal.timeframes[2]?.dmi.adx ?? 0;
  if (htfAdx >= 30) return `strong (score ${score})`;
  if (htfAdx >= 20) return `moderate (score ${score})`;
  return `weak (score ${score})`;
}

function adxConfirmation(signal: SignalPayload): string {
  const htfDmi = signal.timeframes[2]?.dmi;
  if (!htfDmi) return 'n/a';
  return htfDmi.adx >= 25
    ? `ADX ${htfDmi.adx.toFixed(1)} (confirmed)`
    : `ADX ${htfDmi.adx.toFixed(1)} (weak)`;
}

function underlyingLevels(signal: SignalPayload): string {
  const ps = signal.timeframes[2]?.priceStructure ?? signal.timeframes[0]?.priceStructure;
  const trigger      = fmt(ps?.triggerPrice ?? signal.currentPrice);
  const invalidation = fmt(ps?.invalidationLevel);
  const target       = fmt(ps?.targetLevel);
  return `Trigger: ${trigger} | Invalidation: ${invalidation} | Target: ${target}`;
}

// ── Candle section — matches n8n "Output Telegram" candle format ──────────────

function buildCandleSection(signal: SignalPayload): string {
  const tfLabels = [signal.ltf, signal.mtf, signal.htf];
  const lines: string[] = [];
  lines.push(`🕯 <b>Candles (Hammer / BullEngulf / BearEngulf / ShootingStar)</b>`);

  for (let i = 0; i < signal.timeframes.length; i++) {
    const tf    = signal.timeframes[i]!;
    const label = tfLabels[i] ?? tf.timeframe;
    const p     = tf.allCandlePatterns;

    const hammer     = p.hammer.present          ? `bullish_hammer ✅`    : 'none';
    const bullEngulf = p.bullishEngulfing.present ? `bullish_engulfing ✅` : 'none';
    const bearEngulf = p.bearishEngulfing.present ? `bearish_engulfing ✅` : 'none';
    const shootStar  = p.shootingStar.present     ? `shooting_star ✅`     : 'none';

    lines.push(`<b>${label}</b>: Hammer=${hammer} | BullEngulf=${bullEngulf} | BearEngulf=${bearEngulf} | ShootingStar=${shootStar}`);
  }

  return lines.join('\n');
}

// ── Candidate Compare — ported from n8n Output Telegram ───────────────────────

interface ScoreParts {
  passOk:    number;        // 0 or 1
  liqOk:     number;        // 0 or 1
  sideMatch: number;        // 0 or 1
  rr:        number | null;
  sp:        number | null; // spreadPct
  oi:        number | null; // openInterest
  totalScore: number;
}

function extractScoreParts(cand: OptionCandidate, desiredSide: 'call' | 'put' | null): ScoreParts {
  return {
    passOk:    cand.score.passesFilter ? 1 : 0,
    liqOk:     cand.score.liquidityOk  ? 1 : 0,
    sideMatch: desiredSide != null && cand.contract.side === desiredSide ? 1 : 0,
    rr:        Number.isFinite(cand.rrRatio) ? cand.rrRatio : null,
    sp:        Number.isFinite(cand.contract.spreadPct) ? cand.contract.spreadPct : null,
    oi:        Number.isFinite(cand.contract.openInterest) ? cand.contract.openInterest : null,
    totalScore: cand.score.totalScore,
  };
}

function explainWinner(
  callP: ScoreParts,
  putP:  ScoreParts,
  desiredSide: string
): { key: string; why: string } {
  if (callP.passOk !== putP.passOk) {
    return { key: 'passOk', why: `pass: CALL=${callP.passOk} vs PUT=${putP.passOk} (higher wins)` };
  }
  if (callP.liqOk !== putP.liqOk) {
    return { key: 'liqOk', why: `liq: CALL=${callP.liqOk} vs PUT=${putP.liqOk} (higher wins)` };
  }
  if (callP.sideMatch !== putP.sideMatch) {
    const winner = desiredSide.toUpperCase();
    const loser  = winner === 'CALL' ? 'PUT' : 'CALL';
    return { key: 'sideMatch', why: `desired_side=${winner} → ${winner} sideMatch=1 beats ${loser}=0` };
  }
  if (callP.rr !== putP.rr) {
    if (callP.rr == null || putP.rr == null) {
      return {
        key: 'rrScore',
        why: `RR: ${callP.rr != null ? 'CALL has RR' : 'CALL RR=n/a'} vs ${putP.rr != null ? 'PUT has RR' : 'PUT RR=n/a'} (present wins)`,
      };
    }
    const win = callP.rr > putP.rr ? 'CALL' : 'PUT';
    return { key: 'rrScore', why: `RR: CALL=${callP.rr.toFixed(2)} vs PUT=${putP.rr.toFixed(2)} (higher wins → ${win})` };
  }
  if (callP.sp != null && putP.sp != null && callP.sp !== putP.sp) {
    const win = callP.sp < putP.sp ? 'CALL' : 'PUT';
    return { key: 'spScore', why: `spread: CALL=${(callP.sp * 100).toFixed(2)}% vs PUT=${(putP.sp * 100).toFixed(2)}% (lower wins → ${win})` };
  }
  if (callP.oi != null && putP.oi != null && callP.oi !== putP.oi) {
    const win = callP.oi > putP.oi ? 'CALL' : 'PUT';
    return { key: 'oiScore', why: `OI: CALL=${Math.round(callP.oi)} vs PUT=${Math.round(putP.oi)} (higher wins → ${win})` };
  }
  return { key: 'tie', why: 'all compare keys equal (tie)' };
}

function candLine(label: string, cand: OptionCandidate, isWinner: boolean): string {
  const c   = cand.contract;
  const sc  = cand.score;
  const rr  = fmt(cand.rrRatio);
  const d   = fmtDelta(c.delta);
  const qa  = c.quoteAgeSeconds != null ? `${Math.round(c.quoteAgeSeconds)}s` : 'n/a';
  const tag = isWinner ? ' ⭐' : '';
  return `${label}: ${label} | <code>${c.symbol}</code> | pass=${sc.passesFilter} | score=${sc.totalScore} | spread%=${fmtPct(c.spreadPct, 2)} | RR=${rr} | Δ ${d} | liq=${sc.liquidityOk} | quoteAge=${qa}${tag}`;
}

function scoreDetailLine(cand: OptionCandidate): string {
  const c  = cand.contract;
  const sc = cand.score;
  const pass   = sc.passesFilter ? 1 : 0;
  const liq    = sc.liquidityOk  ? 1 : 0;
  const sm     = sc.sideMatchOk  ? 1 : 0;
  const rr     = fmt(cand.rrRatio);
  const spread = fmtPct(c.spreadPct, 2);
  const oi     = c.openInterest != null ? String(Math.round(c.openInterest)) : 'n/a';
  return `   ↳ score_detail: pass=${pass}, liq=${liq}, sideMatch=${sm}, RR=${rr}, spread=${spread}, OI=${oi} => score=${sc.totalScore}`;
}

function buildCandidateSection(option: OptionEvaluation, signal: SignalPayload): string {
  const lines: string[] = [];
  lines.push(`\n🧭 <b>Candidate Compare</b>`);

  const desired    = option.desiredSide ? option.desiredSide.toUpperCase() : 'n/a';
  const direction  = signal.direction;
  const derivedRight = option.desiredSide ? option.desiredSide.toUpperCase() : 'n/a';
  lines.push(`Desired: ${desired} | compare_lexicographic`);
  lines.push(`Desired inputs: bias=${direction} | trend=${signal.alignment} | derived_right=${derivedRight}`);

  const call = option.callCandidate;
  const put  = option.putCandidate;

  // Winner line (matches n8n "Winner: {winnerSide}")
  lines.push(`Winner: ${option.winner ? option.winner.toUpperCase() : 'n/a'}`);

  if (call && put) {
    const callP = extractScoreParts(call, option.desiredSide);
    const putP  = extractScoreParts(put,  option.desiredSide);
    const exp   = explainWinner(callP, putP, desired);
    lines.push(`Why: ${exp.why}`);
    lines.push(`Tie-break: ${exp.key}`);
    lines.push(candLine('CALL', call, option.winner === 'call'));
    lines.push(scoreDetailLine(call));
    lines.push(candLine('PUT',  put,  option.winner === 'put'));
    lines.push(scoreDetailLine(put));
  } else {
    if (call) {
      lines.push(candLine('CALL', call, option.winner === 'call'));
      lines.push(scoreDetailLine(call));
    } else {
      lines.push('CALL: no candidate');
    }
    if (put) {
      lines.push(candLine('PUT', put, option.winner === 'put'));
      lines.push(scoreDetailLine(put));
    } else {
      lines.push('PUT: no candidate');
    }
  }

  return lines.join('\n');
}

// ── Option Trade Plan ──────────────────────────────────────────────────────────

function buildOptionTradePlan(option: OptionEvaluation): string {
  const cand = option.winnerCandidate;
  if (!cand) {
    return [
      `\n🧾 <b>Option Trade Plan</b>`,
      `Decision: 🟡 WAIT`,
      `No winner selected.`,
    ].join('\n');
  }

  const c        = cand.contract;
  const side     = c.side.toUpperCase();
  const sideIcon = side === 'PUT' ? '🔴' : '🟢';

  return [
    `\n🧾 <b>Option Trade Plan</b>`,
    `Decision: ${sideIcon} BUY_${side} @ <code>${c.symbol}</code>`,
    `Quote: Right: ${c.side} | Bid: ${fmt(c.bid)} | Ask: ${fmt(c.ask)} | Mid: ${fmt(c.mid, 3)} | Spread%: ${fmtPct(c.spreadPct, 2)}`,
    `Entry: ${fmt(cand.entryPremium)} | Stop: ${fmt(cand.stopPremium)} | TP: ${fmt(cand.tpPremium)} | R:R ${fmt(cand.rrRatio)}`,
  ].join('\n');
}

// ── Underlying Trade Plan — matches n8n (no Ticker/Price/ATR line) ─────────────

function buildUnderlyingTradePlan(signal: SignalPayload): string {
  const ps      = signal.timeframes[2]?.priceStructure ?? signal.timeframes[0]?.priceStructure;
  const trigger = fmt(ps?.triggerPrice ?? signal.currentPrice);
  const stop    = fmt(ps?.invalidationLevel);
  const tp      = fmt(ps?.targetLevel);
  const rr      = ps?.underlyingRR != null && ps.underlyingRR > 0 ? fmt(ps.underlyingRR) : 'n/a';

  return [
    `\n🧾 <b>Trade Plan (Underlying)</b>`,
    `Decision: 🟡 WAIT @ ${trigger}`,
    `Entry: ${trigger} | Stop: ${stop} | TP: ${tp} | R:R ${rr}`,
  ].join('\n');
}

// ── Key Factors — AI only (matches n8n — no deterministic TD injection) ────────

function buildKeyFactors(analysis: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`\nKey factors:`);

  if (analysis.keyFactors?.length) {
    for (const f of analysis.keyFactors.slice(0, 6)) {
      lines.push(`• ${f}`);
    }
  } else {
    lines.push('• (no key factors)');
  }

  return lines.join('\n');
}

// ── Orchestrator section — expanded to match n8n Orchestration Telegram ────────

function buildOrchestratorSection(decisionResult: DecisionResult): string {
  const decIcon = {
    NEW_ENTRY: '🟢', ADD_POSITION: '➕', CONFIRM_HOLD: '✅',
    REDUCE_EXPOSURE: '📉', REVERSE: '🔄', EXIT: '🚪', WAIT: '⏳',
  }[decisionResult.decisionType] ?? '⏳';

  const confPct = `${Math.round(decisionResult.orchestrationConfidence * 100)}%`;
  const lines: string[] = [];

  lines.push(`\n${decIcon} <b>AI Orchestrator: ${decisionResult.decisionType}</b>`);
  lines.push(`Ticker: ${decisionResult.ticker} | Profile: ${decisionResult.profile}`);
  lines.push(`Reasoning: ${decisionResult.reasoning.slice(0, 400)}`);
  lines.push(`AI Confidence: ${confPct}`);

  if (decisionResult.entryStrategy) {
    const es = decisionResult.entryStrategy;
    const needed = es.confirmationsNeeded;
    const count  = es.confirmationCount;
    const override = es.overrideTriggered ? ', OVERRIDE' : '';
    lines.push(`Entry Strategy: ${es.stage} (${count}/${needed} confirmations${override})`);
    if (es.notes) lines.push(`  ${es.notes.slice(0, 200)}`);
  }

  if (decisionResult.riskNotes) {
    lines.push(`Risk: ${decisionResult.riskNotes.slice(0, 300)}`);
  }

  if (decisionResult.streakContext) {
    lines.push(`Streak: ${decisionResult.streakContext.slice(0, 200)}`);
  }

  return lines.join('\n');
}

// ── Order section ─────────────────────────────────────────────────────────────

function buildOrderSection(result: PipelineResult, sizing: SizeResult | undefined): string {
  if (!result.orderSubmitted || !result.orderSymbol) return '';

  const lines: string[] = [`\n📋 <b>Order Submitted</b>`];
  lines.push(`Symbol: <code>${result.orderSymbol}</code>`);
  lines.push(`Qty: ${result.orderQty} contracts @ $${result.orderPrice?.toFixed(2)}`);
  if (sizing) {
    lines.push(`Tier: ${sizing.convictionTier} | Conviction: ${sizing.convictionScore}/10`);
  }

  return lines.join('\n');
}

// ── Main rich notifier ─────────────────────────────────────────────────────────

/** Send rich formatted alert matching the n8n multi-TF Options summary format */
export async function notifySignalAnalysis(result: PipelineResult): Promise<void> {
  const { signal, option, analysis, decisionResult, sizing } = result;

  if (!signal || !option || !analysis) {
    await notifySimple(result);
    return;
  }

  const confPct  = (result.confidence * 100).toFixed(0);
  const strength = computeStrength(signal);
  const adxConf  = adxConfirmation(signal);
  const levels   = underlyingLevels(signal);

  // Direction label: "uptrend" / "downtrend" / "neutral" (matches n8n)
  const directionLabel = result.direction === 'bullish' ? 'uptrend'
    : result.direction === 'bearish' ? 'downtrend'
    : 'neutral';

  // Technical bias (bullish/bearish/neutral — matches n8n "Bias:" field)
  const biasLabel = result.direction;

  // ── Header ─────────────────────────────────────────────────────────────────
  const tfStr = [signal.ltf, signal.mtf, signal.htf].join('_');
  let msg = `<b>Options Multi-TF Summary</b>\n`;
  msg += `Ticker: ${result.ticker}\n`;
  msg += `Timeframes: multi_${tfStr}\n`;
  msg += `Direction: ${directionLabel}\n`;
  msg += `Strength: ${strength}\n`;
  msg += `Alignment: ${result.alignment}\n`;
  msg += `ADX confirmation: ${adxConf}\n`;
  msg += `Bias: ${biasLabel}\n`;
  msg += `Confidence: ${confPct}%\n`;
  msg += `Underlying Levels: ${levels}\n`;

  // ── Candles ────────────────────────────────────────────────────────────────
  msg += '\n' + buildCandleSection(signal);

  // ── Candidate Compare ──────────────────────────────────────────────────────
  msg += buildCandidateSection(option, signal);

  // ── Option Trade Plan ──────────────────────────────────────────────────────
  msg += buildOptionTradePlan(option);

  // ── Underlying Trade Plan ──────────────────────────────────────────────────
  msg += buildUnderlyingTradePlan(signal);

  // ── Key Factors (AI only — matches n8n) ───────────────────────────────────
  msg += buildKeyFactors(analysis);

  // ── Explanation ────────────────────────────────────────────────────────────
  if (analysis.aiExplanation) {
    msg += `\n\nExplanation: ${analysis.aiExplanation.slice(0, 600)}`;
  }

  // ── Orchestrator decision ──────────────────────────────────────────────────
  if (decisionResult) {
    msg += buildOrchestratorSection(decisionResult);
  }

  // ── Order / gates / error ──────────────────────────────────────────────────
  msg += buildOrderSection(result, sizing);

  if (result.failedGates?.length) {
    msg += `\n\nNOTE: AI suggested ${option.winner ? `BUY_${option.winner.toUpperCase()}` : 'n/a'}, but overridden to WAIT: ${result.failedGates.join('; ')}.`;
  }

  if (result.error) {
    msg += `\n\n❌ Error: ${result.error}`;
  }

  await sendMessage(msg);
}

/** Fallback simple notification (when full context unavailable) */
async function notifySimple(result: PipelineResult): Promise<void> {
  const dirIcon = result.direction === 'bullish' ? '🟢' : result.direction === 'bearish' ? '🔴' : '⚪';
  const decIcon = {
    NEW_ENTRY: '🟢', ADD_POSITION: '➕', CONFIRM_HOLD: '✅',
    REDUCE_EXPOSURE: '📉', REVERSE: '🔄', EXIT: '🚪', WAIT: '⏳',
  }[result.decision] ?? '⏳';
  const confPct = (result.confidence * 100).toFixed(0);

  let msg = `<b>Options Signal — ${result.ticker} (${result.profile})</b>\n`;
  msg += `${dirIcon} Direction: <b>${result.direction}</b> | Alignment: ${result.alignment}\n`;
  msg += `📊 Confidence: <b>${confPct}%</b>\n`;
  msg += `${decIcon} Decision: <b>${result.decision}</b>\n\n`;

  if (result.orderSubmitted && result.orderSymbol) {
    msg += `📋 <b>Order Submitted</b>\n`;
    msg += `  Symbol: <code>${result.orderSymbol}</code>\n`;
    msg += `  Qty: ${result.orderQty} contracts @ $${result.orderPrice?.toFixed(2)}\n\n`;
  }

  if (result.failedGates?.length) {
    msg += `⚠️ <b>Gates Failed:</b> ${result.failedGates.join(', ')}\n\n`;
  }

  if (result.error) {
    msg += `❌ Error: ${result.error}\n`;
  }

  msg += result.reasoning.slice(0, 300);
  await sendMessage(msg);
}

/** Notify about a trade evaluation — matches n8n "AI Trade Evaluation" message format */
export async function notifyEvaluation(evaluation: EvaluationRecord): Promise<void> {
  const gradeEmoji  = { A: '⭐', B: '👍', C: '🤷', D: '👎', F: '💥' }[evaluation.grade] ?? '❓';
  const gradeIcon   = { A: '🏆', B: '✅', C: '🟡', D: '🟠', F: '❌' }[evaluation.grade] ?? '❓';
  const outcomeIcon = evaluation.outcome === 'WIN' ? '✅' : evaluation.outcome === 'LOSS' ? '❌' : '➖';

  let msg = `📊 <b>AI Trade Evaluation: ${evaluation.ticker}</b>\n`;
  msg += `${outcomeIcon} Outcome: ${evaluation.outcome}\n`;
  msg += `Grade: ${evaluation.grade} ${gradeEmoji} (Score: ${evaluation.score}/100)\n`;

  if (evaluation.outcomeSummary) {
    msg += `\n${evaluation.outcomeSummary}\n`;
  }

  msg += `\nEntry: $${evaluation.entryPrice.toFixed(2)} | Exit: $${evaluation.exitPrice.toFixed(2)}\n`;
  msg += `P&L/contract: $${evaluation.pnlPerContract.toFixed(2)} | Total: $${evaluation.pnlTotal.toFixed(2)}\n`;
  msg += `Change: ${evaluation.pnlPct.toFixed(1)}% | Hold: ${evaluation.holdDurationMin} min\n`;

  msg += `\nSignal: ${evaluation.signalQuality} | Timing: ${evaluation.timingQuality} | Risk Mgmt: ${evaluation.riskManagementQuality}\n`;

  if (evaluation.critique) {
    msg += `\nCritique: ${evaluation.critique.slice(0, 400)}\n`;
  }

  if (evaluation.whatWentRight.length > 0) {
    msg += `\n✅ Well: ${evaluation.whatWentRight.slice(0, 3).join('; ')}\n`;
  }

  if (evaluation.whatWentWrong.length > 0) {
    msg += `❌ Wrong: ${evaluation.whatWentWrong.slice(0, 3).join('; ')}\n`;
  }

  if (evaluation.lessonsLearned) {
    msg += `💡 Lessons: ${evaluation.lessonsLearned}\n`;
  }

  if (evaluation.wouldTakeAgain != null) {
    msg += `Would take again: ${evaluation.wouldTakeAgain ? 'Yes' : 'No'}\n`;
  }

  if (evaluation.improvementSuggestions?.length) {
    msg += `\nSuggestions:\n`;
    for (const s of evaluation.improvementSuggestions.slice(0, 3)) {
      msg += `  • ${s}\n`;
    }
  }

  await sendMessage(msg);
}

/** Simple text alert */
export async function notifyAlert(text: string): Promise<void> {
  await sendMessage(`⚠️ <b>Alert</b>\n${text}`);
}

/** Daily DB cleanup notification */
export async function notifyDailyCleanup(
  success: boolean,
  deletedRows: Record<string, number>,
  agentsStopped: number,
  error?: string,
): Promise<void> {
  if (success) {
    const total = Object.values(deletedRows).reduce((s, n) => s + n, 0);
    const lines = Object.entries(deletedRows)
      .map(([label, n]) => `  • ${label}: <b>${n}</b>`)
      .join('\n');
    const agentLine = agentsStopped > 0
      ? `\n⚠️ Force-stopped <b>${agentsStopped}</b> lingering agent(s)`
      : '';
    await sendMessage(
      `🗑 <b>Daily DB Cleanup Complete</b>\n` +
      `${new Date().toUTCString()}\n\n` +
      `${lines}\n\n` +
      `Total rows removed: <b>${total}</b>${agentLine}`,
    );
  } else {
    await sendMessage(
      `❌ <b>Daily DB Cleanup FAILED</b>\n` +
      `${new Date().toUTCString()}\n\n` +
      `Error: ${error ?? 'unknown'}`,
    );
  }
}

/** System startup notification */
export async function notifyStartup(): Promise<void> {
  await sendMessage(`🚀 <b>Day Trade System Started</b>\nAuto mode: every 3 min during market hours (12:00–21:00 UTC)\nCommands: <code>SPY S</code>, <code>QQQ S</code>, <code>/status</code>, <code>/positions</code>`);
}
