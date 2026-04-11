/**
 * analyze-live-entries.ts — Post-hoc analysis of live trading entries using DB data.
 *
 * For every live entry, answers:
 *   1. Was deterministic confidence genuinely above threshold, or marginal?
 *   2. How long had the signal been above threshold before entry? (lag)
 *   3. Was confidence rising or fading at entry time?
 *   4. What happened to the signal after entry? (confirmation or collapse)
 *   5. What did the AI decide and why?
 *   6. Entry timing vs signal lifecycle (early/peak/late)
 *
 * Usage:
 *   npx tsx src/scripts/analyze-live-entries.ts [YYYY-MM-DD] [TICKER]
 *   npx tsx src/scripts/analyze-live-entries.ts all [TICKER]
 *   Defaults: all dates, SPY
 */

import 'dotenv/config';
import { getPool, closePool } from '../db/client.js';

const TARGET_DATE = process.argv[2] || 'all';
const TICKER = process.argv[3] || 'SPY';

function utcToET(ts: string | Date): string {
  const d = new Date(ts);
  d.setHours(d.getHours() - 4); // EDT
  return d.toISOString().slice(11, 16);
}

function fmtPnl(v: number): string {
  const s = v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`;
  return v >= 0 ? `\x1b[32m${s}\x1b[0m` : `\x1b[31m${s}\x1b[0m`;
}

function fmtPct(v: number): string {
  const s = `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  return v >= 0 ? `\x1b[32m${s}\x1b[0m` : `\x1b[31m${s}\x1b[0m`;
}

function fmtGrade(g: string): string {
  const colors: Record<string, string> = { A: '\x1b[32m', B: '\x1b[34m', C: '\x1b[33m', D: '\x1b[33m', F: '\x1b[31m' };
  return `${colors[g] ?? ''}${g}\x1b[0m`;
}

interface Entry {
  // position_journal
  pos_id: string;
  ticker: string;
  option_right: string;
  strike: number;
  option_symbol: string;
  entry_price: number;
  exit_price: number;
  realized_pnl: number;
  close_reason: string;
  conviction_score: number;
  hold_duration_min: number;
  peak_pnl_pct: number;
  opened_at: string;
  closed_at: string;
  trade_date: string;
  // trading_decisions
  decision_type: string;
  direction: string;
  orchestration_confidence: number;
  confirmation_count: number;
  reasoning: string;
  entry_strategy: any;
  // signal_snapshots
  signal_confidence: number;
  alignment: string;
  confidence_meets_threshold: boolean;
  risk_reward: number;
  spread_pct: number;
  analysis_payload: any;
  // trade_evaluations
  eval_grade: string | null;
  eval_score: number | null;
  signal_quality: string | null;
  timing_quality: string | null;
  risk_mgmt_quality: string | null;
  lessons_learned: string | null;
  what_went_wrong: any;
}

interface SignalTick {
  confidence: number;
  alignment: string;
  meets_threshold: boolean;
  created_at: string;
}

async function main() {
  const pool = getPool();

  const dateFilter = TARGET_DATE === 'all'
    ? ''
    : `AND pj.trade_date = '${TARGET_DATE}'`;

  // ── Fetch all closed entries with full context ──
  const { rows: entries } = await pool.query<Entry>(`
    SELECT
      pj.id as pos_id, pj.ticker, pj.option_right, pj.strike, pj.option_symbol,
      pj.entry_price, pj.exit_price, pj.realized_pnl, pj.close_reason,
      pj.conviction_score, pj.hold_duration_min, pj.peak_pnl_pct,
      pj.opened_at::text, pj.closed_at::text, pj.trade_date::text,
      td.decision_type, td.direction, td.orchestration_confidence, td.confirmation_count,
      td.reasoning, td.entry_strategy,
      ss.confidence as signal_confidence, ss.alignment, ss.confidence_meets_threshold,
      ss.risk_reward, ss.spread_pct, ss.analysis_payload,
      te.evaluation_grade as eval_grade, te.evaluation_score as eval_score,
      te.signal_quality, te.timing_quality, te.risk_management_quality as risk_mgmt_quality,
      te.lessons_learned, te.what_went_wrong
    FROM trading.position_journal pj
    JOIN trading.trading_decisions td ON td.id = pj.decision_id
    JOIN trading.signal_snapshots ss ON ss.id = td.signal_snapshot_id
    LEFT JOIN trading.trade_evaluations te ON te.position_id = pj.id
    WHERE pj.status = 'CLOSED' AND pj.ticker = $1 ${dateFilter}
    ORDER BY pj.opened_at
  `, [TICKER]);

  if (entries.length === 0) {
    console.log(`No closed entries found for ${TICKER}${TARGET_DATE !== 'all' ? ` on ${TARGET_DATE}` : ''}`);
    await closePool();
    return;
  }

  // ── Header ──
  const dates = [...new Set(entries.map(e => e.trade_date))];
  console.log('='.repeat(100));
  console.log(`  LIVE ENTRY ANALYSIS: ${TICKER} | ${entries.length} entries across ${dates.length} day(s)`);
  console.log('='.repeat(100));

  // ── Per-day summary ──
  const byDate = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = byDate.get(e.trade_date) || [];
    arr.push(e);
    byDate.set(e.trade_date, arr);
  }

  // ── Aggregate stats ──
  let totalPnl = 0, wins = 0, losses = 0;
  let totalAiBoosted = 0, totalMarginal = 0, totalFading = 0, totalLate = 0;
  const gradeCount: Record<string, number> = {};

  for (const [date, dayEntries] of byDate) {
    const dayPnl = dayEntries.reduce((s, e) => s + Number(e.realized_pnl), 0);
    totalPnl += dayPnl;

    console.log(`\n${'─'.repeat(100)}`);
    console.log(`  ${date} | ${dayEntries.length} entries | Day P&L: ${fmtPnl(dayPnl)}`);
    console.log(`${'─'.repeat(100)}`);

    for (let i = 0; i < dayEntries.length; i++) {
      const e = dayEntries[i]!;
      const pnl = Number(e.realized_pnl);
      if (pnl > 0) wins++; else losses++;
      if (e.eval_grade) gradeCount[e.eval_grade] = (gradeCount[e.eval_grade] || 0) + 1;

      // ── Fetch signal history around entry (30 min before, 15 min after) ──
      const { rows: signalHistory } = await pool.query<SignalTick>(`
        SELECT confidence, alignment, confidence_meets_threshold as meets_threshold, created_at::text
        FROM trading.signal_snapshots
        WHERE ticker = $1 AND created_at BETWEEN $2::timestamptz - interval '30 minutes' AND $2::timestamptz + interval '15 minutes'
        ORDER BY created_at
      `, [TICKER, e.opened_at]);

      // ── Signal lifecycle analysis ──
      const entryTime = new Date(e.opened_at).getTime();
      const threshold = 0.65; // TODO: read from config

      // Find when signal first crossed threshold in this window
      let firstAbove: Date | null = null;
      let lastAbove: Date | null = null;
      let peakConf = 0;
      let peakTime: Date | null = null;
      let confAtEntry = e.signal_confidence;

      // Pre-entry ticks
      const preTicks: SignalTick[] = [];
      const postTicks: SignalTick[] = [];

      for (const t of signalHistory) {
        const tTime = new Date(t.created_at).getTime();
        if (tTime <= entryTime) preTicks.push(t);
        else postTicks.push(t);
        if (t.confidence >= threshold) {
          if (!firstAbove) firstAbove = new Date(t.created_at);
          lastAbove = new Date(t.created_at);
        }
        if (t.confidence > peakConf) {
          peakConf = t.confidence;
          peakTime = new Date(t.created_at);
        }
      }

      // Confidence trend at entry (last 5 pre-entry ticks)
      const recentPre = preTicks.slice(-5);
      let confTrend = 'STABLE';
      if (recentPre.length >= 3) {
        const first3 = recentPre.slice(0, 3).reduce((s, t) => s + t.confidence, 0) / 3;
        const last3 = recentPre.slice(-3).reduce((s, t) => s + t.confidence, 0) / 3;
        if (last3 > first3 + 0.03) confTrend = 'RISING';
        else if (last3 < first3 - 0.03) confTrend = 'FADING';
      }

      // Time above threshold before entry
      const lagMin = firstAbove ? Math.round((entryTime - firstAbove.getTime()) / 60_000) : 0;

      // Post-entry signal collapse
      const postAbove = postTicks.filter(t => t.confidence >= threshold).length;
      const postBelow = postTicks.filter(t => t.confidence < threshold).length;
      const postCollapsed = postTicks.length > 0 && postBelow > postAbove;

      // Alignment change post-entry
      const postAlignChange = postTicks.length > 0 && postTicks.some(t => t.alignment !== e.alignment);

      // Confidence margin above threshold
      const confMargin = Number(e.signal_confidence) - threshold;
      const marginal = confMargin < 0.05;

      // AI boost
      const aiBoosted = Number(e.orchestration_confidence) > Number(e.signal_confidence) + 0.01;

      // Entry stage
      const stage = e.entry_strategy?.stage ?? 'unknown';
      const confirmCount = e.entry_strategy?.confirmationCount ?? 0;

      // Was entry at peak or past peak?
      const atPeak = peakTime && Math.abs(entryTime - peakTime.getTime()) < 2 * 60_000;
      const pastPeak = peakTime && peakTime.getTime() < entryTime - 2 * 60_000;

      // Confidence breakdown from analysis_payload
      const cb = e.analysis_payload?.confidenceBreakdown;

      // Track aggregates
      if (aiBoosted) totalAiBoosted++;
      if (marginal) totalMarginal++;
      if (confTrend === 'FADING') totalFading++;
      if (lagMin > 10) totalLate++;

      // ── Print entry analysis ──
      const pnlPct = Number(e.entry_price) > 0 ? (pnl / (Number(e.entry_price) * 100)) * 100 : 0;
      console.log(`\n  Entry #${i + 1}: ${e.option_right.toUpperCase()} $${Number(e.strike).toFixed(0)} @ ${utcToET(e.opened_at)} ET`);
      console.log(`    P&L: ${fmtPnl(pnl)} (${fmtPct(pnlPct)}) | Hold: ${e.hold_duration_min}m | Peak: ${fmtPct(Number(e.peak_pnl_pct))}`);
      if (e.eval_grade) {
        console.log(`    Grade: ${fmtGrade(e.eval_grade)} (${e.eval_score}) | Signal: ${e.signal_quality} | Timing: ${e.timing_quality} | Risk Mgmt: ${e.risk_mgmt_quality}`);
      }
      console.log(`    Exit: ${e.close_reason?.slice(0, 120)}`);

      console.log(`\n    ── Signal at Entry ──`);
      console.log(`    Deterministic confidence: ${(Number(e.signal_confidence) * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%, margin: ${marginal ? '\x1b[31m' : '\x1b[32m'}${(confMargin * 100).toFixed(1)}%\x1b[0m)`);
      console.log(`    AI orchestration conf:    ${(Number(e.orchestration_confidence) * 100).toFixed(1)}% ${aiBoosted ? '\x1b[33m(AI BOOSTED)\x1b[0m' : '(no boost)'}`);
      console.log(`    Alignment: ${e.alignment} | R:R: ${Number(e.risk_reward).toFixed(2)} | Spread: ${Number(e.spread_pct).toFixed(2)}%`);
      console.log(`    Stage: ${stage} | Confirmations: ${confirmCount}`);
      console.log(`    Mode: ${e.analysis_payload?.selectedMode ?? '?'}`);

      if (cb) {
        // Show top positive and negative factors
        const factors = Object.entries(cb)
          .filter(([k]) => !['base', 'total'].includes(k))
          .map(([k, v]) => ({ name: k, value: v as number }))
          .filter(f => Math.abs(f.value) > 0.005)
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
        const pos = factors.filter(f => f.value > 0).slice(0, 5);
        const neg = factors.filter(f => f.value < 0).slice(0, 5);
        console.log(`    Boosters:  ${pos.map(f => `${f.name.replace(/Bonus|Penalty/g, '')}=${(f.value * 100).toFixed(1)}%`).join(', ')}`);
        console.log(`    Drags:     ${neg.map(f => `${f.name.replace(/Bonus|Penalty/g, '')}=${(f.value * 100).toFixed(1)}%`).join(', ')}`);
      }

      console.log(`\n    ── Signal Lifecycle ──`);
      console.log(`    Confidence trend at entry: ${confTrend === 'RISING' ? '\x1b[32m' : confTrend === 'FADING' ? '\x1b[31m' : ''}${confTrend}\x1b[0m`);
      console.log(`    Signal above threshold for: ${lagMin}m before entry${lagMin > 10 ? ' \x1b[33m(LATE)\x1b[0m' : ''}`);
      console.log(`    Peak confidence in window: ${(peakConf * 100).toFixed(1)}% at ${peakTime ? utcToET(peakTime) : '?'} ET${atPeak ? ' (AT PEAK)' : pastPeak ? ' \x1b[33m(PAST PEAK)\x1b[0m' : ''}`);

      // Show pre-entry confidence trajectory
      const preDisplay = preTicks.slice(-8);
      if (preDisplay.length > 0) {
        const trajectory = preDisplay.map(t => {
          const conf = (t.confidence * 100).toFixed(0);
          const above = t.confidence >= threshold;
          return above ? `\x1b[32m${conf}\x1b[0m` : `${conf}`;
        }).join(' → ');
        console.log(`    Pre-entry:  ${trajectory} → [\x1b[1m${(confAtEntry * 100).toFixed(0)}\x1b[0m] (entry)`);
      }

      console.log(`\n    ── Post-Entry Signal ──`);
      if (postTicks.length > 0) {
        const postDisplay = postTicks.slice(0, 8);
        const trajectory = postDisplay.map(t => {
          const conf = (t.confidence * 100).toFixed(0);
          const above = t.confidence >= threshold;
          return above ? `\x1b[32m${conf}\x1b[0m` : `\x1b[31m${conf}\x1b[0m`;
        }).join(' → ');
        console.log(`    Post-entry: ${trajectory}`);
        console.log(`    Signal ${postCollapsed ? '\x1b[31mCOLLAPSED\x1b[0m' : '\x1b[32mHELD\x1b[0m'} after entry (${postAbove} above / ${postBelow} below threshold)`);
        if (postAlignChange) console.log(`    \x1b[33mAlignment changed post-entry\x1b[0m`);
      }

      // ── AI reasoning summary ──
      if (e.reasoning) {
        const shortReasoning = e.reasoning.length > 200 ? e.reasoning.slice(0, 200) + '...' : e.reasoning;
        console.log(`\n    ── AI Reasoning ──`);
        console.log(`    ${shortReasoning}`);
      }

      // ── Lessons ──
      if (e.what_went_wrong && Array.isArray(e.what_went_wrong) && e.what_went_wrong.length > 0) {
        console.log(`\n    ── What Went Wrong ──`);
        for (const w of e.what_went_wrong) console.log(`    • ${w}`);
      }
    }
  }

  // ── Aggregate Summary ──
  console.log(`\n${'='.repeat(100)}`);
  console.log(`  AGGREGATE SUMMARY: ${TICKER} | ${entries.length} entries`);
  console.log(`${'='.repeat(100)}`);
  console.log(`  W/L:           ${wins}W / ${losses}L (${entries.length > 0 ? ((wins / entries.length) * 100).toFixed(0) : 0}%)`);
  console.log(`  Total P&L:     ${fmtPnl(totalPnl)}`);
  console.log(`  Grades:        ${Object.entries(gradeCount).sort().map(([g, c]) => `${g}:${c}`).join('  ')}`);
  console.log();
  console.log(`  ── Entry Quality Flags ──`);
  console.log(`  AI boosted confidence:     ${totalAiBoosted}/${entries.length}`);
  console.log(`  Marginal (within 5%):      ${totalMarginal}/${entries.length}`);
  console.log(`  Fading confidence at entry: ${totalFading}/${entries.length}`);
  console.log(`  Late entry (>10m lag):     ${totalLate}/${entries.length}`);

  // ── Pattern Analysis ──
  console.log(`\n  ── Patterns ──`);

  // Win/loss by confidence trend
  const byTrend = { RISING: { w: 0, l: 0 }, FADING: { w: 0, l: 0 }, STABLE: { w: 0, l: 0 } };
  // Need to re-compute... let's do it from entries
  // Actually we'd need to store these per-entry. Let's just note the aggregates we have.

  // Close reason breakdown
  const closeReasons = new Map<string, { count: number, pnl: number }>();
  for (const e of entries) {
    const reason = e.close_reason?.split(':')[0]?.split('[')[0]?.trim() ?? 'unknown';
    const r = closeReasons.get(reason) || { count: 0, pnl: 0 };
    r.count++;
    r.pnl += Number(e.realized_pnl);
    closeReasons.set(reason, r);
  }
  console.log(`\n  Exit reason breakdown:`);
  for (const [reason, { count, pnl }] of [...closeReasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${reason.padEnd(35)} ${count}x  ${fmtPnl(pnl)}`);
  }

  // Stage breakdown
  const stages = new Map<string, { count: number, pnl: number }>();
  for (const e of entries) {
    const stage = e.entry_strategy?.stage ?? 'unknown';
    const s = stages.get(stage) || { count: 0, pnl: 0 };
    s.count++;
    s.pnl += Number(e.realized_pnl);
    stages.set(stage, s);
  }
  console.log(`\n  Entry stage breakdown:`);
  for (const [stage, { count, pnl }] of [...stages.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${stage.padEnd(25)} ${count}x  ${fmtPnl(pnl)}`);
  }

  // Alignment breakdown
  const alignments = new Map<string, { count: number, wins: number, pnl: number }>();
  for (const e of entries) {
    const a = alignments.get(e.alignment) || { count: 0, wins: 0, pnl: 0 };
    a.count++;
    if (Number(e.realized_pnl) > 0) a.wins++;
    a.pnl += Number(e.realized_pnl);
    alignments.set(e.alignment, a);
  }
  console.log(`\n  Alignment breakdown:`);
  for (const [align, { count, wins: w, pnl }] of [...alignments.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${align.padEnd(20)} ${count}x  ${w}W/${count - w}L  ${fmtPnl(pnl)}`);
  }

  console.log();
  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
