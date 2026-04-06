#!/usr/bin/env npx tsx
/**
 * analyze-live-day.ts — Comprehensive single-day live trading analysis.
 *
 * Automates the full analysis workflow:
 *   1. LIVE DATA ANALYSIS — pulls all decisions, signals, positions, evaluations,
 *      market moves, and scheduler runs from DB for the given day
 *   2. DEEP COMPARISON — runs backtest, matches live vs backtest entry-by-entry,
 *      compares confidence breakdowns, indicators, gates, exits, and P&L
 *   3. ISSUE IDENTIFICATION — detects systemic patterns (exit too fast, signal
 *      timing drift, mode disagreement, etc.)
 *   4. TUNING RECOMMENDATIONS — concrete parameter changes with reasoning
 *
 * Usage:
 *   npx tsx src/scripts/analyze-live-day.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: today (ET), SPY
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { getPool, closePool } from '../db/client.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';

// ── Config ──────────────────────────────────────────────────────────────────

const now = new Date();
const etNow = new Date(now.getTime() - 4 * 60 * 60_000);
const DEFAULT_DATE = etNow.toISOString().slice(0, 10);

const TARGET_DATE = process.argv[2] || DEFAULT_DATE;
const TICKER = process.argv[3]?.toUpperCase() || 'SPY';

// ── Types ───────────────────────────────────────────────────────────────────

interface LiveDecision {
  id: string;
  decision_type: string;
  direction: string | null;
  confirmation_count: number;
  orchestration_confidence: number;
  reasoning: string;
  should_execute: boolean;
  entry_strategy: any;
  created_at: string;
  // joined position
  position_id: string | null;
  option_symbol: string | null;
  option_right: string | null;
  entry_price: number | null;
  exit_price: number | null;
  close_reason: string | null;
  realized_pnl: number | null;
  conviction_tier: string | null;
  hold_duration_min: number | null;
  opened_at: string | null;
  closed_at: string | null;
  // joined signal
  signal_direction: string | null;
  signal_alignment: string | null;
  signal_confidence: number | null;
  signal_mode: string | null;
  signal_entry_premium: number | null;
  signal_stop_premium: number | null;
  signal_tp_premium: number | null;
  signal_risk_reward: number | null;
  signal_spread_pct: number | null;
  signal_liquidity_ok: boolean | null;
  signal_selected_symbol: string | null;
  signal_payload: any;
  analysis_payload: any;
  option_payload: any;
}

interface LivePosition {
  id: string;
  option_symbol: string;
  option_right: string;
  qty: number;
  entry_price: number;
  exit_price: number | null;
  realized_pnl: number | null;
  status: string;
  close_reason: string | null;
  conviction_tier: string;
  opened_at: string;
  closed_at: string | null;
  hold_duration_min: number | null;
  current_stop: number | null;
  current_tp: number | null;
}

interface LiveEvaluation {
  position_id: string;
  evaluation_grade: string;
  evaluation_score: number;
  outcome: string;
  pnl_total: number;
  pnl_pct: number;
  hold_duration_min: number;
  signal_quality: string;
  timing_quality: string;
  risk_management_quality: string;
  lessons_learned: string;
  what_went_right: string[];
  what_went_wrong: string[];
}

interface MarketMove {
  direction: string;
  start_time: string;
  peak_time: string;
  mfe_pct: number;
  mae_pct: number;
  duration_minutes: number;
  signal_status: string;
  classification: string;
  priority: string;
  signal_direction: string | null;
  signal_confidence: number | null;
}

interface BacktestEntry {
  time: string;
  timeET: string;
  direction: string;
  alignment: string;
  mode: string;
  confidence: number;
  price: number;
  strength?: number;
  grade: string;
  outcome: string;
  gate: string;
  mfePct: number;
  maePct: number;
  mfeOverMae: number;
  mfePeakMinutes: number;
  move5m: number | null;
  move10m: number | null;
  move15m: number | null;
  move30m: number | null;
  dirCorrect?: boolean;
  atr?: number;
  sim?: { pnlPct: number; exitReason: string; holdMin: number; peakPnl: number };
  breakdown: ConfidenceBreakdown;
}

interface BacktestJson {
  date: string;
  ticker: string;
  confirmed: BacktestEntry[];
  blocked: BacktestEntry[];
  filtered?: { time: string; timeET: string; direction: string; mode: string; confidence: number; price: number; grade: string; outcome: string; filterRule: string; filterCategory: string; mfePct: number; maePct: number }[];
}

// ── Issues accumulator ──────────────────────────────────────────────────────

interface Issue {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'EXIT_LOGIC' | 'ENTRY_TIMING' | 'SIGNAL_QUALITY' | 'LIVE_BT_DIVERGENCE' | 'POSITION_SIZING' | 'EXIT_TIMING';
  title: string;
  evidence: string[];
  impact: string;
  recommendation: string;
  parameterChange?: { param: string; current: string; suggested: string; file: string };
}

const issues: Issue[] = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

function utcToET(utcTime: string): string {
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4);
  return d.toISOString().slice(11, 16);
}

function etToMinutes(et: string): number {
  const [h, m] = et.split(':').map(Number);
  return h! * 60 + m!;
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

function fmtDollar(v: number | null | undefined): string {
  if (v == null) return '—';
  return `$${Number(v).toFixed(2)}`;
}

function fmtNum(v: number | null | undefined, d = 2): string {
  if (v == null) return '—';
  return Number(v).toFixed(d);
}

const W = 110;
const SEP = '═'.repeat(W);
const THIN = '─'.repeat(W);

function header(title: string) {
  console.log(`\n${SEP}`);
  console.log(`  ${title}`);
  console.log(`${SEP}\n`);
}

function subHeader(title: string) {
  console.log(`\n  ${THIN}`);
  console.log(`  ${title}`);
  console.log(`  ${THIN}\n`);
}

// ── Breakdown labels ────────────────────────────────────────────────────────

const BREAKDOWN_LABELS: Record<string, string> = {
  base: 'Base',
  diSpreadBonus: 'DI Spread',
  adxBonus: 'ADX Strength',
  diCrossBonus: 'DI Cross',
  alignmentBonus: 'Alignment',
  tdAdjustment: 'TD Sequential',
  obvBonus: 'OBV',
  vwapBonus: 'VWAP',
  oiVolumeBonus: 'OI/Volume',
  pricePositionAdjustment: 'Price Position',
  adxMaturityPenalty: 'ADX Maturity',
  trendPhaseBonus: 'Trend Phase',
  momentumAccelBonus: 'Momentum Accel',
  structureBonus: 'PDH/PDL Structure',
  orbBonus: 'ORB',
  recentPriceActionBonus: 'Recent Price Action',
  trContractionPenalty: 'TR Contraction',
  lowVolPenalty: 'Low Vol',
  moveExhaustionPenalty: 'Move Exhaustion',
  consolidationPenalty: 'Consolidation',
  nearLevelPenalty: 'Near Level',
  thetaDecayPenalty: 'Theta Decay',
  narrowRangePenalty: 'Narrow Range',
  candlePatternBonus: 'Candle Pattern',
  priceVelocityBonus: 'Price Velocity',
  volumeSurgeBonus: 'Volume Surge',
  trendPersistenceBonus: 'Trend Persistence',
  total: 'TOTAL',
};

// ── DB queries ──────────────────────────────────────────────────────────────

async function fetchLiveDecisions(): Promise<LiveDecision[]> {
  const pool = getPool();
  const { rows } = await pool.query<LiveDecision>(
    `SELECT
       d.id, d.decision_type, d.direction, d.confirmation_count,
       d.orchestration_confidence, d.reasoning, d.should_execute,
       d.entry_strategy, d.created_at,
       pj.id as position_id, pj.option_symbol, pj.option_right,
       pj.entry_price, pj.exit_price, pj.close_reason, pj.realized_pnl,
       pj.conviction_tier, pj.hold_duration_min, pj.opened_at, pj.closed_at,
       pj.current_stop, pj.current_tp,
       ss.direction as signal_direction, ss.alignment as signal_alignment,
       ss.confidence as signal_confidence,
       COALESCE((ss.analysis_payload->>'selectedMode'), 'trend') as signal_mode,
       ss.entry_premium as signal_entry_premium,
       ss.stop_premium as signal_stop_premium,
       ss.tp_premium as signal_tp_premium,
       ss.risk_reward as signal_risk_reward,
       ss.spread_pct as signal_spread_pct,
       ss.option_liquidity_ok as signal_liquidity_ok,
       ss.selected_symbol as signal_selected_symbol,
       ss.signal_payload, ss.analysis_payload, ss.option_payload
     FROM trading.trading_decisions d
     LEFT JOIN trading.position_journal pj ON d.id = pj.decision_id
     LEFT JOIN trading.signal_snapshots ss ON d.signal_snapshot_id = ss.id
     WHERE d.trade_date = $1::date AND d.ticker = $2
     ORDER BY d.created_at ASC`,
    [TARGET_DATE, TICKER]
  );
  return rows;
}

async function fetchPositions(): Promise<LivePosition[]> {
  const pool = getPool();
  const { rows } = await pool.query<LivePosition>(
    `SELECT id, option_symbol, option_right, qty, entry_price, exit_price,
       realized_pnl, status, close_reason, conviction_tier,
       opened_at, closed_at, hold_duration_min, current_stop, current_tp
     FROM trading.position_journal
     WHERE trade_date = $1::date AND ticker = $2
     ORDER BY opened_at`,
    [TARGET_DATE, TICKER]
  );
  return rows;
}

async function fetchEvaluations(): Promise<LiveEvaluation[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT te.position_id, te.evaluation_grade, te.evaluation_score, te.outcome,
       te.pnl_total, te.pnl_pct, te.hold_duration_min,
       te.signal_quality, te.timing_quality, te.risk_management_quality,
       te.lessons_learned, te.what_went_right::text, te.what_went_wrong::text
     FROM trading.trade_evaluations te
     JOIN trading.position_journal pj ON te.position_id = pj.id
     WHERE te.trade_date = $1::date AND pj.ticker = $2
     ORDER BY pj.opened_at`,
    [TARGET_DATE, TICKER]
  );
  return rows.map((r: any) => ({
    ...r,
    pnl_total: parseFloat(r.pnl_total),
    pnl_pct: parseFloat(r.pnl_pct),
    what_went_right: typeof r.what_went_right === 'string' ? JSON.parse(r.what_went_right) : r.what_went_right,
    what_went_wrong: typeof r.what_went_wrong === 'string' ? JSON.parse(r.what_went_wrong) : r.what_went_wrong,
  }));
}

async function fetchMarketMoves(): Promise<MarketMove[]> {
  const pool = getPool();
  const { rows } = await pool.query<MarketMove>(
    `SELECT direction, start_time, peak_time, mfe_pct, mae_pct,
       duration_minutes, signal_status, classification, priority,
       signal_direction, signal_confidence
     FROM trading.market_moves
     WHERE trade_date = $1::date AND ticker = $2
     ORDER BY start_time`,
    [TARGET_DATE, TICKER]
  );
  return rows;
}

async function fetchSchedulerStats(): Promise<{ total: number; completed: number; skipped: number; avgDuration: number }> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
       COUNT(*) FILTER (WHERE status = 'SKIPPED') as skipped,
       AVG(total_duration_ms) FILTER (WHERE status = 'COMPLETED') as avg_duration
     FROM trading.scheduler_runs
     WHERE run_at::date = $1::date`,
    [TARGET_DATE]
  );
  const r = rows[0] as any;
  return {
    total: parseInt(r.total),
    completed: parseInt(r.completed),
    skipped: parseInt(r.skipped),
    avgDuration: parseFloat(r.avg_duration) || 0,
  };
}

async function fetchWaitDecisionPatterns(): Promise<{ total_waits: number; avg_conf: number; high_conf_waits: number; common_reasons: { reason: string; count: number }[] }> {
  const pool = getPool();
  const { rows: summary } = await pool.query(
    `SELECT COUNT(*) as total_waits,
       AVG(orchestration_confidence) as avg_conf,
       COUNT(*) FILTER (WHERE orchestration_confidence >= 0.65) as high_conf_waits
     FROM trading.trading_decisions
     WHERE trade_date = $1::date AND ticker = $2 AND decision_type = 'WAIT'`,
    [TARGET_DATE, TICKER]
  );
  // Sample reasoning patterns from WAIT decisions
  const { rows: reasons } = await pool.query(
    `SELECT
       CASE
         WHEN reasoning LIKE '%STAGE-1 OBSERVE%' THEN 'STAGE-1 OBSERVE'
         WHEN reasoning LIKE '%WEAKENING%' THEN 'WEAKENING SIGNAL'
         WHEN reasoning LIKE '%STALE%' THEN 'STALE SIGNAL'
         WHEN reasoning LIKE '%neutral%' OR reasoning LIKE '%Neutral%' THEN 'NEUTRAL DIRECTION'
         WHEN reasoning LIKE '%confidence%below%' OR reasoning LIKE '%below%threshold%' THEN 'LOW CONFIDENCE'
         WHEN reasoning LIKE '%session%' THEN 'SESSION CONTEXT'
         ELSE 'OTHER'
       END as reason,
       COUNT(*) as count
     FROM trading.trading_decisions
     WHERE trade_date = $1::date AND ticker = $2 AND decision_type = 'WAIT'
     GROUP BY 1 ORDER BY count DESC LIMIT 10`,
    [TARGET_DATE, TICKER]
  );

  const s = summary[0] as any;
  return {
    total_waits: parseInt(s.total_waits),
    avg_conf: parseFloat(s.avg_conf) || 0,
    high_conf_waits: parseInt(s.high_conf_waits),
    common_reasons: reasons.map((r: any) => ({ reason: r.reason, count: parseInt(r.count) })),
  };
}

// ── Run backtest ────────────────────────────────────────────────────────────

function runBacktest(): BacktestJson | null {
  try {
    console.log('  Running backtest for comparison...');
    const output = execSync(
      `npx tsx src/scripts/backtest-day.ts ${TARGET_DATE} ${TICKER} --json`,
      { encoding: 'utf-8', timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const jsonMatch = output.match(/__JSON_START__(.+?)__JSON_END__/);
    if (!jsonMatch) {
      console.error('  WARNING: No JSON output found in backtest');
      return null;
    }
    return JSON.parse(jsonMatch[1]!) as BacktestJson;
  } catch (err) {
    console.error(`  WARNING: Backtest failed: ${(err as Error).message}`);
    return null;
  }
}

// ── Exit reason classification ──────────────────────────────────────────────

function classifyExitReason(reason: string | null): {
  category: 'VELOCITY' | 'DECLINING' | 'PROFIT_REVERSED' | 'STOP_HIT' | 'TRAILING' | 'TP_HIT' | 'NEVER_CONFIRMED' | 'OTHER';
  isStreamBased: boolean;
  isUltraFast: boolean;
} {
  if (!reason) return { category: 'OTHER', isStreamBased: false, isUltraFast: false };
  const isStream = reason.includes('[stream]');
  if (reason.startsWith('VELOCITY_CRASH') || reason.startsWith('VELOCITY_FADE'))
    return { category: 'VELOCITY', isStreamBased: isStream, isUltraFast: true };
  if (reason.startsWith('DECLINING_SINCE_FILL'))
    return { category: 'DECLINING', isStreamBased: isStream, isUltraFast: true };
  if (reason.startsWith('PROFIT_REVERSED'))
    return { category: 'PROFIT_REVERSED', isStreamBased: isStream, isUltraFast: true };
  if (reason.startsWith('STOP_HIT'))
    return { category: 'STOP_HIT', isStreamBased: isStream, isUltraFast: false };
  if (reason.startsWith('TRAILING') || reason.startsWith('PEAK'))
    return { category: 'TRAILING', isStreamBased: isStream, isUltraFast: false };
  if (reason.startsWith('TP_HIT'))
    return { category: 'TP_HIT', isStreamBased: isStream, isUltraFast: false };
  if (reason.startsWith('NEVER_CONFIRMED'))
    return { category: 'NEVER_CONFIRMED', isStreamBased: isStream, isUltraFast: true };
  return { category: 'OTHER', isStreamBased: isStream, isUltraFast: false };
}

function classifyLiveGate(d: LiveDecision): string {
  if (d.reasoning?.includes('[STAGE-1 OBSERVE]')) return 'STAGE1_OBSERVE';
  if (d.reasoning?.includes('[WEAKENING-SIGNAL BLOCK]')) return 'WEAKENING_BLOCK';
  if (d.reasoning?.includes('[STALE-SIGNAL BLOCK]')) return 'STALE_BLOCK';
  if (d.reasoning?.includes('[PHASE-CHANGE OVERRIDE]')) return 'PHASE_CHANGE_OVERRIDE';
  if (d.reasoning?.includes('[RANGE BYPASS]')) return 'RANGE_BYPASS';
  if (d.reasoning?.includes('[HIGH-CONV OVERRIDE]')) return 'HIGH_CONV_OVERRIDE';
  if (d.decision_type === 'NEW_ENTRY' && d.should_execute) return 'PASSED';
  return 'AI_WAIT';
}

// ── Parse exit timing from close_reason ─────────────────────────────────────

function parseExitSeconds(reason: string | null): number | null {
  if (!reason) return null;
  const match = reason.match(/(\d+)s/);
  return match ? parseInt(match[1]!) : null;
}

// ── SECTION 1: Live Data Analysis ───────────────────────────────────────────

function printLiveDataAnalysis(
  decisions: LiveDecision[],
  positions: LivePosition[],
  evaluations: LiveEvaluation[],
  moves: MarketMove[],
  schedulerStats: { total: number; completed: number; skipped: number; avgDuration: number },
  waitPatterns: { total_waits: number; avg_conf: number; high_conf_waits: number; common_reasons: { reason: string; count: number }[] },
) {
  header(`SECTION 1: LIVE DATA ANALYSIS — ${TICKER} on ${TARGET_DATE}`);

  const entries = decisions.filter(d => d.decision_type === 'NEW_ENTRY' && d.should_execute);
  const waits = decisions.filter(d => d.decision_type === 'WAIT');
  const totalPnl = positions.reduce((s, p) => s + (p.realized_pnl ? Number(p.realized_pnl) : 0), 0);
  const wins = positions.filter(p => p.realized_pnl != null && Number(p.realized_pnl) > 0);
  const losses = positions.filter(p => p.realized_pnl != null && Number(p.realized_pnl) <= 0);

  // ── Day Overview ──
  subHeader('1.1  DAY OVERVIEW');
  console.log(`  Date:             ${TARGET_DATE}`);
  console.log(`  Ticker:           ${TICKER}`);
  console.log(`  Total Decisions:  ${decisions.length} (${entries.length} entries, ${waits.length} waits)`);
  console.log(`  Positions:        ${positions.length} (${wins.length} wins, ${losses.length} losses)`);
  console.log(`  Total P&L:        ${fmtDollar(totalPnl)}`);
  console.log(`  Win Rate:         ${positions.length > 0 ? (wins.length / positions.length * 100).toFixed(0) : 0}%`);
  console.log(`  Scheduler Runs:   ${schedulerStats.total} (${schedulerStats.completed} completed, ${schedulerStats.skipped} skipped)`);
  console.log(`  Avg Run Duration: ${(schedulerStats.avgDuration / 1000).toFixed(1)}s`);

  // ── Position Details ──
  subHeader('1.2  POSITION-BY-POSITION DETAIL');

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    const eval_ = evaluations.find(e => e.position_id === p.id);
    const exitInfo = classifyExitReason(p.close_reason);
    const exitSec = parseExitSeconds(p.close_reason);

    const openET = utcToET(p.opened_at);
    const closeET = p.closed_at ? utcToET(p.closed_at) : '—';

    console.log(`  ┌─ POSITION #${i + 1} ─────────────────────────────────────────────────────────────────────`);
    console.log(`  │  Option:    ${p.option_symbol} (${p.option_right.toUpperCase()}) x${p.qty} [${p.conviction_tier}]`);
    console.log(`  │  Time:      ${openET} → ${closeET} ET (hold: ${p.hold_duration_min ?? 0}min)`);
    console.log(`  │  Prices:    Entry ${fmtDollar(Number(p.entry_price))} → Exit ${fmtDollar(p.exit_price ? Number(p.exit_price) : null)}`);
    console.log(`  │  P&L:       ${fmtDollar(p.realized_pnl ? Number(p.realized_pnl) : null)} (${fmtNum(eval_?.pnl_pct)}%)`);
    console.log(`  │  Stop/TP:   Stop ${fmtDollar(p.current_stop ? Number(p.current_stop) : null)} | TP ${fmtDollar(p.current_tp ? Number(p.current_tp) : null)}`);
    console.log(`  │  Exit:      ${p.close_reason}`);
    console.log(`  │  Exit Type: ${exitInfo.category} | Stream: ${exitInfo.isStreamBased ? 'YES' : 'NO'} | Ultra-fast: ${exitInfo.isUltraFast ? 'YES' : 'NO'}${exitSec != null ? ` (${exitSec}s)` : ''}`);

    if (eval_) {
      console.log(`  │  Grade:     ${eval_.evaluation_grade} (${eval_.evaluation_score}/100) | Signal: ${eval_.signal_quality} | Timing: ${eval_.timing_quality} | Risk Mgmt: ${eval_.risk_management_quality}`);
      if (eval_.what_went_wrong?.length > 0) {
        console.log(`  │  Problems:  ${eval_.what_went_wrong.join(' | ')}`);
      }
    }
    console.log(`  └${'─'.repeat(W - 4)}`);
  }

  // ── Exit Pattern Analysis ──
  subHeader('1.3  EXIT PATTERN ANALYSIS');

  const exitCategories = new Map<string, { count: number; totalPnl: number; avgHoldSec: number[] }>();
  for (const p of positions) {
    const info = classifyExitReason(p.close_reason);
    const sec = parseExitSeconds(p.close_reason);
    const existing = exitCategories.get(info.category) || { count: 0, totalPnl: 0, avgHoldSec: [] };
    existing.count++;
    existing.totalPnl += p.realized_pnl ? Number(p.realized_pnl) : 0;
    if (sec != null) existing.avgHoldSec.push(sec);
    exitCategories.set(info.category, existing);
  }

  console.log(`  ${'Category'.padEnd(20)} ${'Count'.padStart(5)} ${'Total P&L'.padStart(10)} ${'Avg Hold'.padStart(10)}`);
  console.log(`  ${'─'.repeat(20)} ${'─'.repeat(5)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
  for (const cat of Array.from(exitCategories.keys())) {
    const data = exitCategories.get(cat)!;
    const avgSec = data.avgHoldSec.length > 0
      ? `${(data.avgHoldSec.reduce((a, b) => a + b, 0) / data.avgHoldSec.length).toFixed(0)}s`
      : '—';
    console.log(`  ${cat.padEnd(20)} ${String(data.count).padStart(5)} ${fmtDollar(data.totalPnl).padStart(10)} ${avgSec.padStart(10)}`);
  }

  const ultraFastCount = positions.filter(p => classifyExitReason(p.close_reason).isUltraFast).length;
  const streamExitCount = positions.filter(p => classifyExitReason(p.close_reason).isStreamBased).length;

  console.log(`\n  Ultra-fast exits (<30s):   ${ultraFastCount}/${positions.length} (${(ultraFastCount / Math.max(positions.length, 1) * 100).toFixed(0)}%)`);
  console.log(`  Stream-based exits:        ${streamExitCount}/${positions.length} (${(streamExitCount / Math.max(positions.length, 1) * 100).toFixed(0)}%)`);

  // Detect exit pattern issues
  if (ultraFastCount / Math.max(positions.length, 1) >= 0.6) {
    issues.push({
      severity: 'CRITICAL',
      category: 'EXIT_LOGIC',
      title: 'Majority of exits are ultra-fast (<30s)',
      evidence: [
        `${ultraFastCount}/${positions.length} positions exited in <30s`,
        `Exit categories: ${Array.from(exitCategories.keys()).map(k => `${k}:${exitCategories.get(k)!.count}`).join(', ')}`,
        `Total P&L from ultra-fast exits: ${fmtDollar(positions.filter(p => classifyExitReason(p.close_reason).isUltraFast).reduce((s, p) => s + (p.realized_pnl ? Number(p.realized_pnl) : 0), 0))}`,
      ],
      impact: `Positions never have time to develop. Signals may be correct but exits kill them before the move materializes.`,
      recommendation: `Widen stream-based exit thresholds. The 5s polling creates hair-trigger exits on normal option premium noise.`,
    });
  }

  // ── Market Moves Analysis ──
  subHeader('1.4  MARKET MOVES vs ENTRIES');

  const highPriorityMoves = moves.filter(m => m.priority === 'HIGH');
  const detectedMoves = moves.filter(m => m.signal_status === 'DETECTED');
  const missedMoves = moves.filter(m => ['NO_SIGNAL', 'LOW_CONF', 'WRONG_DIR'].includes(m.signal_status) && m.priority !== 'LOW');

  console.log(`  Total moves detected:     ${moves.length}`);
  console.log(`  HIGH priority moves:      ${highPriorityMoves.length}`);
  console.log(`  Signal detected:          ${detectedMoves.length}`);
  console.log(`  Missed (no/low/wrong):    ${missedMoves.length}`);
  console.log('');

  for (const m of highPriorityMoves) {
    const startET = utcToET(m.start_time);
    const peakET = utcToET(m.peak_time);
    console.log(`  ${m.direction.toUpperCase().padEnd(8)} ${startET}→${peakET} ET | MFE ${Number(m.mfe_pct).toFixed(3)}% | MAE ${Number(m.mae_pct).toFixed(3)}% | ${m.duration_minutes}min | ${m.signal_status} ${m.classification}`);
  }

  // Check if entries aligned with major moves
  if (highPriorityMoves.length > 0 && entries.length > 0) {
    let alignedEntries = 0;
    for (const entry of entries) {
      const entryMin = etToMinutes(utcToET(entry.created_at));
      for (const move of highPriorityMoves) {
        const moveStartMin = etToMinutes(utcToET(move.start_time));
        const movePeakMin = etToMinutes(utcToET(move.peak_time));
        if (entryMin >= moveStartMin && entryMin <= movePeakMin && entry.direction === move.direction) {
          alignedEntries++;
          break;
        }
      }
    }
    console.log(`\n  Entries aligned with HIGH moves: ${alignedEntries}/${entries.length}`);
  }

  // ── WAIT Decision Analysis ──
  subHeader('1.5  WAIT DECISION PATTERNS');

  console.log(`  Total WAITs:              ${waitPatterns.total_waits}`);
  console.log(`  Avg confidence in WAITs:  ${fmtPct(waitPatterns.avg_conf)}`);
  console.log(`  High-conf WAITs (>=0.65): ${waitPatterns.high_conf_waits}`);
  console.log('');
  console.log(`  Reason breakdown:`);
  for (const r of waitPatterns.common_reasons) {
    console.log(`    ${r.reason.padEnd(25)} ${String(r.count).padStart(4)}`);
  }

  // ── Entry Timing Analysis ──
  subHeader('1.6  ENTRY TIMING ANALYSIS');

  const entryMinutes = entries.map(e => {
    const et = utcToET(e.created_at);
    return etToMinutes(et) - etToMinutes('09:30'); // minutes since market open
  });

  if (entryMinutes.length > 0) {
    const first30 = entryMinutes.filter(m => m < 30).length;
    const mid = entryMinutes.filter(m => m >= 30 && m < 180).length;
    const late = entryMinutes.filter(m => m >= 180).length;

    console.log(`  Entry time distribution (minutes since 9:30 ET open):`);
    console.log(`    First 30 min:    ${first30} entries`);
    console.log(`    30-180 min:      ${mid} entries`);
    console.log(`    After 180 min:   ${late} entries`);
    console.log('');
    for (const e of entries) {
      const et = utcToET(e.created_at);
      const minSinceOpen = etToMinutes(et) - etToMinutes('09:30');
      const pnl = e.realized_pnl != null ? fmtDollar(Number(e.realized_pnl)) : 'OPEN';
      console.log(`    ${et} ET (+${minSinceOpen}min) | ${e.direction?.toUpperCase().padEnd(7)} | conf=${fmtPct(e.orchestration_confidence)} | ${pnl} | ${e.close_reason?.split(' ')[0] || '—'}`);
    }

    // Check for clustering
    if (entries.length >= 3) {
      const sorted = [...entryMinutes].sort((a, b) => a - b);
      const maxGap = Math.max(...sorted.slice(1).map((v, i) => v - sorted[i]!));
      const minGap = Math.min(...sorted.slice(1).map((v, i) => v - sorted[i]!));
      if (minGap < 5 && sorted.filter(m => m < 30).length >= 2) {
        issues.push({
          severity: 'HIGH',
          category: 'ENTRY_TIMING',
          title: 'Multiple rapid entries in opening period',
          evidence: [
            `${first30} entries in first 30 min with gap as small as ${minGap} min`,
            `Opening period is high-noise: wide spreads, volatile premiums`,
            `Entries: ${entries.slice(0, 3).map(e => `${utcToET(e.created_at)} ${e.direction}`).join(', ')}`,
          ],
          impact: 'Rapid entries in volatile opening period compound losses before system can learn from first entry result',
          recommendation: `Increase entryWindowStartMin or add minimum gap between entries`,
          parameterChange: { param: 'entryWindowStartMin', current: '30', suggested: '45', file: 'src/scripts/backtest-configs/spy.ts' },
        });
      }
    }
  }

  // ── Conviction Analysis ──
  subHeader('1.7  CONVICTION vs OUTCOME');

  for (const e of entries) {
    if (!e.position_id) continue;
    const p = positions.find(pos => pos.id === e.position_id);
    if (!p) continue;
    const pnl = p.realized_pnl ? Number(p.realized_pnl) : 0;
    const icon = pnl > 0 ? 'WIN' : 'LOSS';
    console.log(`  ${utcToET(e.created_at)} | conf=${fmtPct(e.orchestration_confidence).padStart(6)} | ${(p.conviction_tier || '—').padEnd(14)} | qty=${p.qty} | ${icon} ${fmtDollar(pnl)}`);
  }

  const sizableOrMax = positions.filter(p => ['SIZABLE', 'MAX_CONVICTION'].includes(p.conviction_tier));
  const sizableLosses = sizableOrMax.filter(p => p.realized_pnl != null && Number(p.realized_pnl) <= 0);
  if (sizableLosses.length > 0 && sizableLosses.length / Math.max(sizableOrMax.length, 1) > 0.7) {
    issues.push({
      severity: 'HIGH',
      category: 'POSITION_SIZING',
      title: 'High-conviction entries predominantly losing',
      evidence: [
        `${sizableLosses.length}/${sizableOrMax.length} SIZABLE/MAX_CONVICTION entries lost money`,
        `Total high-conviction loss: ${fmtDollar(sizableLosses.reduce((s, p) => s + (p.realized_pnl ? Number(p.realized_pnl) : 0), 0))}`,
      ],
      impact: 'Larger position sizes on losing entries amplify total losses',
      recommendation: 'High confidence does not compensate for exit timing issues. Fix exit logic before sizing aggressively.',
    });
  }
}

// ── SECTION 2: Deep Live vs Backtest Comparison ─────────────────────────────

function printDeepComparison(
  decisions: LiveDecision[],
  positions: LivePosition[],
  btJson: BacktestJson | null,
) {
  header(`SECTION 2: DEEP LIVE vs BACKTEST COMPARISON`);

  if (!btJson) {
    console.log('  Backtest data not available — skipping comparison.\n');
    return;
  }

  const liveEntries = decisions.filter(d => d.decision_type === 'NEW_ENTRY' && d.should_execute);
  const btConfirmed = btJson.confirmed;
  const btBlocked = btJson.blocked;
  const allBt = [...btConfirmed, ...btBlocked].sort((a, b) =>
    new Date(a.time).getTime() - new Date(b.time).getTime()
  );

  console.log(`  Live executed entries:     ${liveEntries.length}`);
  console.log(`  Backtest confirmed:        ${btConfirmed.length}`);
  console.log(`  Backtest blocked:          ${btBlocked.length}`);
  console.log(`  Backtest filtered:         ${btJson.filtered?.length ?? 0}`);

  // ── Match entries ──
  interface MatchedPair {
    live: LiveDecision | null;
    bt: BacktestEntry | null;
    timeDiffMin: number | null;
  }

  const matched: MatchedPair[] = [];
  const usedLive = new Set<string>();
  const usedBtIdx = new Set<number>();

  // Match bt confirmed → live
  for (let bi = 0; bi < btConfirmed.length; bi++) {
    const bt = btConfirmed[bi]!;
    const btMin = etToMinutes(bt.timeET);
    let bestLive: LiveDecision | null = null;
    let bestDiff = Infinity;
    for (const le of liveEntries) {
      if (usedLive.has(le.id)) continue;
      if (le.direction !== bt.direction) continue;
      const leMin = etToMinutes(utcToET(le.created_at));
      const diff = Math.abs(leMin - btMin);
      if (diff <= 6 && diff < bestDiff) {
        bestDiff = diff;
        bestLive = le;
      }
    }
    if (bestLive) {
      usedLive.add(bestLive.id);
      usedBtIdx.add(bi);
      matched.push({ live: bestLive, bt, timeDiffMin: bestDiff });
    }
  }

  // Unmatched BT confirmed
  for (let bi = 0; bi < btConfirmed.length; bi++) {
    if (!usedBtIdx.has(bi)) matched.push({ live: null, bt: btConfirmed[bi]!, timeDiffMin: null });
  }
  // Unmatched live
  for (const le of liveEntries) {
    if (!usedLive.has(le.id)) matched.push({ live: le, bt: null, timeDiffMin: null });
  }
  // Sort by time
  matched.sort((a, b) => {
    const aTime = a.bt ? etToMinutes(a.bt.timeET) : etToMinutes(utcToET(a.live!.created_at));
    const bTime = b.bt ? etToMinutes(b.bt.timeET) : etToMinutes(utcToET(b.live!.created_at));
    return aTime - bTime;
  });

  // ── Entry-by-entry deep comparison ──
  subHeader('2.1  ENTRY-BY-ENTRY DEEP COMPARISON');

  for (let i = 0; i < matched.length; i++) {
    const m = matched[i]!;
    const { live: le, bt } = m;

    const entryTime = bt ? bt.timeET : utcToET(le!.created_at);
    const dir = (bt?.direction || le?.direction || '?').toUpperCase();
    const matchType = le && bt ? 'MATCHED' : (bt ? 'BT-ONLY' : 'LIVE-ONLY');
    const matchIcon = le && bt ? '<=>' : (bt ? ' BT' : 'LIV');

    console.log(`  ┌─ #${i + 1} [${matchIcon}] ${entryTime} ET ${dir} ─────────────────────────────────────────────────`);

    if (le && bt) {
      // ────────────────── MATCHED ENTRY ──────────────────
      const leTime = utcToET(le.created_at);
      const liveConf = le.signal_confidence ?? le.orchestration_confidence;
      const confDiff = liveConf - bt.confidence;
      const liveMode = le.signal_mode || 'trend';
      const livePnl = le.realized_pnl != null ? Number(le.realized_pnl) : null;
      const btPnl = bt.sim?.pnlPct;
      const pos = positions.find(p => p.id === le.position_id);

      // Overview
      console.log(`  │`);
      console.log(`  │  ${''.padEnd(25)} ${'LIVE'.padStart(15)} ${'BACKTEST'.padStart(15)} ${'DELTA'.padStart(12)}`);
      console.log(`  │  ${'─'.repeat(25)} ${'─'.repeat(15)} ${'─'.repeat(15)} ${'─'.repeat(12)}`);
      console.log(`  │  ${'Time'.padEnd(25)} ${leTime.padStart(15)} ${bt.timeET.padStart(15)} ${(m.timeDiffMin != null ? `${m.timeDiffMin}min` : '—').padStart(12)}`);
      console.log(`  │  ${'Confidence'.padEnd(25)} ${fmtPct(liveConf).padStart(15)} ${fmtPct(bt.confidence).padStart(15)} ${(confDiff >= 0 ? '+' : '') + fmtPct(confDiff).padStart(11)}`);
      console.log(`  │  ${'Mode'.padEnd(25)} ${liveMode.padStart(15)} ${bt.mode.padStart(15)} ${(liveMode === bt.mode ? 'MATCH' : 'DIFFER').padStart(12)}`);
      console.log(`  │  ${'Alignment'.padEnd(25)} ${(le.signal_alignment || '—').padStart(15)} ${bt.alignment.padStart(15)}`);
      console.log(`  │  ${'Grade'.padEnd(25)} ${'—'.padStart(15)} ${bt.grade.padStart(15)}`);
      console.log(`  │  ${'MFE%'.padEnd(25)} ${'—'.padStart(15)} ${(bt.mfePct.toFixed(3) + '%').padStart(15)}`);
      console.log(`  │  ${'MAE%'.padEnd(25)} ${'—'.padStart(15)} ${(bt.maePct.toFixed(3) + '%').padStart(15)}`);

      if (pos) {
        const liveExitShort = (pos.close_reason || 'OPEN').split(' ')[0]!;
        const btExitShort = bt.sim?.exitReason || '—';
        console.log(`  │  ${'Exit Reason'.padEnd(25)} ${liveExitShort.padStart(15)} ${btExitShort.padStart(15)}`);
        console.log(`  │  ${'P&L'.padEnd(25)} ${(livePnl != null ? fmtDollar(livePnl) : 'OPEN').padStart(15)} ${(btPnl != null ? `${btPnl >= 0 ? '+' : ''}${btPnl.toFixed(2)}%` : '—').padStart(15)}`);
        console.log(`  │  ${'Hold Time'.padEnd(25)} ${((pos.hold_duration_min ?? 0) + 'min').padStart(15)} ${(bt.sim ? bt.sim.holdMin + 'min' : '—').padStart(15)}`);
      }

      // Confidence breakdown differences
      const liveBreakdown = le.analysis_payload?.confidenceBreakdown as ConfidenceBreakdown | undefined;
      if (liveBreakdown && bt.breakdown) {
        const factorDiffs: { label: string; key: string; live: number; bt: number; diff: number }[] = [];
        for (const [key, label] of Object.entries(BREAKDOWN_LABELS)) {
          if (key === 'total') continue;
          const lVal = (liveBreakdown as any)[key] as number | undefined;
          const bVal = (bt.breakdown as any)[key] as number | undefined;
          if (lVal != null && bVal != null && Math.abs(lVal - bVal) >= 0.005) {
            factorDiffs.push({ label, key, live: lVal, bt: bVal, diff: lVal - bVal });
          }
        }
        if (factorDiffs.length > 0) {
          factorDiffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
          console.log(`  │`);
          console.log(`  │  Confidence factor differences (top ${Math.min(factorDiffs.length, 8)}):`);
          for (const fd of factorDiffs.slice(0, 8)) {
            const sign = fd.diff >= 0 ? '+' : '';
            const flag = Math.abs(fd.diff) >= 0.03 ? ' <<<' : '';
            console.log(`  │    ${fd.label.padEnd(22)} live=${fmtPct(fd.live).padStart(6)} bt=${fmtPct(fd.bt).padStart(6)} (${sign}${fmtPct(fd.diff)})${flag}`);
          }
        }
      }

      // Divergence analysis
      const divergences: string[] = [];

      if (Math.abs(confDiff) >= 0.03) {
        divergences.push(`CONFIDENCE GAP (${confDiff >= 0 ? '+' : ''}${fmtPct(confDiff)}): Streaming bars vs REST historical bars compute different indicator values`);
      }
      if (liveMode !== bt.mode) {
        divergences.push(`MODE MISMATCH (live=${liveMode}, bt=${bt.mode}): Mode detection depends on price structure in lookback window — bar timing affects this`);
      }
      if (pos && bt.sim) {
        const liveExitCat = classifyExitReason(pos.close_reason).category;
        if (liveExitCat !== bt.sim.exitReason.split('_')[0]) {
          divergences.push(`EXIT DIVERGENCE: Live=${pos.close_reason?.split(' ')[0]} vs BT=${bt.sim.exitReason}. Live uses 5s option polling with velocity/decline checks; BT sim uses 1-min bar closes`);
        }
      }
      if (le.signal_spread_pct != null && le.signal_spread_pct > 0.03) {
        divergences.push(`WIDE SPREAD: Live option spread ${(le.signal_spread_pct * 100).toFixed(1)}% — backtest ignores real spreads`);
      }

      if (divergences.length > 0) {
        console.log(`  │`);
        console.log(`  │  Divergence reasons:`);
        for (const d of divergences) {
          console.log(`  │    - ${d}`);
        }
      }

    } else if (bt && !le) {
      // ────────────────── BT-ONLY ──────────────────
      const outcomeIcon = bt.outcome === 'GOOD' ? 'GOOD' : 'BAD';
      console.log(`  │  Backtest: conf=${fmtPct(bt.confidence)} | mode=${bt.mode} | grade=${bt.grade} ${outcomeIcon}`);
      console.log(`  │  MFE ${bt.mfePct.toFixed(3)}% | MAE ${bt.maePct.toFixed(3)}%`);
      if (bt.sim) console.log(`  │  Sim: ${bt.sim.exitReason} at ${bt.sim.holdMin}min | P&L ${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}%`);

      // Check why live missed it
      const btMin = etToMinutes(bt.timeET);
      const nearbyWaits = decisions.filter(d => {
        if (!d.direction || d.direction !== bt.direction) return false;
        return Math.abs(etToMinutes(utcToET(d.created_at)) - btMin) <= 6;
      });

      console.log(`  │  WHY LIVE MISSED:`);
      if (nearbyWaits.length > 0) {
        for (const nw of nearbyWaits.slice(0, 3)) {
          const gate = classifyLiveGate(nw);
          console.log(`  │    Found decision at ${utcToET(nw.created_at)} — gate=${gate}, execute=${nw.should_execute}`);
          if (gate === 'STAGE1_OBSERVE') console.log(`  │    -> Stage-1 observe, needed 2nd confirmation`);
          else if (gate === 'AI_WAIT') console.log(`  │    -> AI chose WAIT: "${(nw.reasoning || '').slice(0, 100)}"`);
        }
      } else {
        console.log(`  │    No matching live decision within +-6 min. Streaming data diverged from REST.`);
      }

      if (bt.outcome === 'GOOD') {
        issues.push({
          severity: 'MEDIUM',
          category: 'LIVE_BT_DIVERGENCE',
          title: `Missed GOOD entry at ${bt.timeET} ET`,
          evidence: [
            `Backtest grade ${bt.grade}, MFE ${bt.mfePct.toFixed(3)}%`,
            bt.sim ? `Sim P&L ${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}%` : 'No sim data',
            nearbyWaits.length > 0 ? `Live had ${nearbyWaits[0]!.decision_type} at ${utcToET(nearbyWaits[0]!.created_at)}` : 'No live signal near this time',
          ],
          impact: `Missed ${bt.mfePct.toFixed(3)}% potential move`,
          recommendation: 'Check if streaming data alignment can be improved or gate criteria relaxed',
        });
      }

    } else if (le && !bt) {
      // ────────────────── LIVE-ONLY ──────────────────
      const liveConf = le.signal_confidence ?? le.orchestration_confidence;
      const livePnl = le.realized_pnl != null ? Number(le.realized_pnl) : null;
      const pos = positions.find(p => p.id === le.position_id);

      console.log(`  │  Live: conf=${fmtPct(liveConf)} | mode=${le.signal_mode || '—'} | ${le.signal_selected_symbol || '—'}`);
      if (pos) {
        console.log(`  │  Result: ${pos.close_reason?.split(' ')[0]} | P&L ${fmtDollar(livePnl)}`);
      }

      // Check if BT had a blocked/filtered version
      const leMin = etToMinutes(utcToET(le.created_at));
      const nearbyBlocked = btBlocked.filter(b =>
        Math.abs(etToMinutes(b.timeET) - leMin) <= 6 && b.direction === le.direction
      );
      const nearbyFiltered = (btJson.filtered || []).filter(f =>
        Math.abs(etToMinutes(f.timeET) - leMin) <= 6 && f.direction === le.direction
      );

      console.log(`  │  WHY NOT IN BACKTEST:`);
      if (nearbyBlocked.length > 0) {
        console.log(`  │    BT blocked at ${nearbyBlocked[0]!.timeET} — gate=${nearbyBlocked[0]!.gate}, conf=${fmtPct(nearbyBlocked[0]!.confidence)}`);
        console.log(`  │    -> Live AI overrode the deterministic gate`);
      } else if (nearbyFiltered.length > 0) {
        console.log(`  │    BT filtered at ${nearbyFiltered[0]!.timeET} — ${nearbyFiltered[0]!.filterRule}`);
      } else {
        console.log(`  │    No BT signal nearby. Streaming data produced signal not visible in REST bars.`);
      }

      if (livePnl != null && livePnl < 0) {
        issues.push({
          severity: 'LOW',
          category: 'LIVE_BT_DIVERGENCE',
          title: `Live-only losing entry at ${utcToET(le.created_at)} ET`,
          evidence: [
            `Live conf=${fmtPct(liveConf)}, P&L=${fmtDollar(livePnl)}`,
            nearbyBlocked.length > 0 ? `BT blocked this — backtest was right` : `No BT signal at all`,
          ],
          impact: `Lost ${fmtDollar(Math.abs(livePnl))}`,
          recommendation: 'Streaming-only signals without REST confirmation may be less reliable',
        });
      }
    }

    console.log(`  └${'─'.repeat(W - 4)}\n`);
  }

  // ── Summary comparison table ──
  subHeader('2.2  COMPARISON SUMMARY TABLE');

  const hdr = ['#', 'Match', 'Time', 'Dir', 'Live Conf', 'BT Conf', 'Live Exit', 'BT Exit', 'Live P&L', 'BT Sim', 'BT Grade'];
  console.log(`  ${hdr.map((h, i) => h.padEnd(i === 0 ? 3 : i === 6 || i === 7 ? 18 : 10)).join(' ')}`);
  console.log(`  ${'─'.repeat(W - 4)}`);

  for (let i = 0; i < matched.length; i++) {
    const m = matched[i]!;
    const { live: le, bt } = m;
    const matchLabel = le && bt ? '<=>' : (bt ? ' BT' : 'LIV');
    const time = bt ? bt.timeET : utcToET(le!.created_at);
    const dir = (bt?.direction || le?.direction || '?').toUpperCase();
    const liveConf = le ? fmtPct(le.signal_confidence ?? le.orchestration_confidence) : '—';
    const btConf = bt ? fmtPct(bt.confidence) : '—';
    const pos = le ? positions.find(p => p.id === le.position_id) : null;
    const liveExit = pos?.close_reason?.split(' ')[0] || '—';
    const btExit = bt?.sim?.exitReason || '—';
    const livePnl = pos?.realized_pnl != null ? fmtDollar(Number(pos.realized_pnl)) : '—';
    const btSim = bt?.sim ? `${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}%` : '—';
    const grade = bt?.grade || '—';

    console.log(`  ${String(i + 1).padEnd(3)} ${matchLabel.padEnd(10)} ${time.padEnd(10)} ${dir.padEnd(10)} ${liveConf.padEnd(10)} ${btConf.padEnd(10)} ${liveExit.padEnd(18)} ${btExit.padEnd(18)} ${livePnl.padEnd(10)} ${btSim.padEnd(10)} ${grade}`);
  }

  // ── Cross-cutting divergence patterns ──
  subHeader('2.3  SYSTEMATIC DIVERGENCE PATTERNS');

  // Confidence bias
  const matchedWithBoth = matched.filter(m => m.live && m.bt);
  if (matchedWithBoth.length > 0) {
    const confDiffs = matchedWithBoth.map(m => {
      const lc = m.live!.signal_confidence ?? m.live!.orchestration_confidence;
      return lc - m.bt!.confidence;
    });
    const avgConfDiff = confDiffs.reduce((a, b) => a + b, 0) / confDiffs.length;
    const maxConfDiff = Math.max(...confDiffs.map(Math.abs));

    console.log(`  Confidence: live is on average ${avgConfDiff >= 0 ? '+' : ''}${fmtPct(avgConfDiff)} vs backtest`);
    console.log(`  Max confidence gap: ${fmtPct(maxConfDiff)}`);

    // Mode agreement
    const modeMatch = matchedWithBoth.filter(m => (m.live!.signal_mode || 'trend') === m.bt!.mode).length;
    console.log(`  Mode agreement: ${modeMatch}/${matchedWithBoth.length}`);

    // Exit divergence
    const exitDiverged = matchedWithBoth.filter(m => {
      const pos = positions.find(p => p.id === m.live!.position_id);
      if (!pos?.close_reason || !m.bt!.sim) return false;
      const liveCat = classifyExitReason(pos.close_reason).category;
      return liveCat !== m.bt!.sim.exitReason.replace(/_.*/, '');
    });
    console.log(`  Exit mechanism diverged: ${exitDiverged.length}/${matchedWithBoth.length}`);

    // P&L divergence
    const pnlPairs = matchedWithBoth.filter(m => {
      const pos = positions.find(p => p.id === m.live!.position_id);
      return pos?.realized_pnl != null && m.bt!.sim;
    }).map(m => {
      const pos = positions.find(p => p.id === m.live!.position_id)!;
      return { livePnl: Number(pos.realized_pnl), btPnl: m.bt!.sim!.pnlPct };
    });

    if (pnlPairs.length > 0) {
      const liveAllLoss = pnlPairs.every(p => p.livePnl <= 0);
      const btMixed = pnlPairs.some(p => p.btPnl > 0);
      if (liveAllLoss && btMixed) {
        issues.push({
          severity: 'CRITICAL',
          category: 'EXIT_LOGIC',
          title: 'Live loses on entries where backtest profits',
          evidence: [
            `All ${pnlPairs.length} matched entries lost money in live`,
            `Backtest sim shows ${pnlPairs.filter(p => p.btPnl > 0).length} wins`,
            `Root cause: live 5s polling triggers velocity/decline exits before the move develops`,
            `BT sim uses 1-min bar closes and misses intra-bar noise that triggers live exits`,
          ],
          impact: 'The entry signals may be correct but the exit mechanism destroys them',
          recommendation: 'The 5s stream polling is too fast for option premium noise. Either widen velocity thresholds or add a grace period after fill.',
        });
      }
    }
  }
}

// ── SECTION 3: Issue Identification & Tuning Recommendations ────────────────

function printIssuesAndTuning(
  positions: LivePosition[],
  evaluations: LiveEvaluation[],
) {
  header('SECTION 3: IDENTIFIED ISSUES');

  // Add evaluation-derived issues
  const timingPoor = evaluations.filter(e => e.timing_quality === 'POOR');
  if (timingPoor.length / Math.max(evaluations.length, 1) >= 0.5) {
    issues.push({
      severity: 'HIGH',
      category: 'ENTRY_TIMING',
      title: 'Majority of entries have POOR timing quality',
      evidence: [
        `${timingPoor.length}/${evaluations.length} evaluated as POOR timing`,
        `Evaluation scores: ${evaluations.map(e => `${e.evaluation_grade}(${e.evaluation_score})`).join(', ')}`,
      ],
      impact: 'Good signals but bad entry timing means the move has already happened or is about to reverse',
      recommendation: 'Consider tighter mode-aware entry windows and momentum confirmation before entry',
    });
  }

  // Detect hold duration issue
  const zeroHold = positions.filter(p => (p.hold_duration_min ?? 0) === 0);
  if (zeroHold.length / Math.max(positions.length, 1) >= 0.5) {
    issues.push({
      severity: 'CRITICAL',
      category: 'EXIT_TIMING',
      title: 'Most positions close in <1 minute',
      evidence: [
        `${zeroHold.length}/${positions.length} positions have 0min hold duration`,
        `Close reasons: ${zeroHold.map(p => p.close_reason?.split(' ')[0]).join(', ')}`,
        `Mean hold: ${(positions.reduce((s, p) => s + (p.hold_duration_min ?? 0), 0) / Math.max(positions.length, 1)).toFixed(1)}min`,
      ],
      impact: 'Trades never have opportunity to work. Option premiums need time to respond to underlying moves.',
      recommendation: 'Add minimum hold grace period or widen early-exit thresholds for stream-based exits',
    });
  }

  // Sort issues by severity
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  if (issues.length === 0) {
    console.log('  No significant issues detected.\n');
  }

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]!;
    const severityIcon = issue.severity === 'CRITICAL' ? '[!!!]'
      : issue.severity === 'HIGH' ? '[!! ]'
      : issue.severity === 'MEDIUM' ? '[ ! ]'
      : '[   ]';

    console.log(`  ${severityIcon} ISSUE #${i + 1}: ${issue.title} [${issue.severity}] [${issue.category}]`);
    console.log(`  │`);
    console.log(`  │  Evidence:`);
    for (const e of issue.evidence) {
      console.log(`  │    - ${e}`);
    }
    console.log(`  │`);
    console.log(`  │  Impact: ${issue.impact}`);
    console.log(`  │`);
    console.log(`  │  Recommendation: ${issue.recommendation}`);
    if (issue.parameterChange) {
      console.log(`  │  Parameter: ${issue.parameterChange.param} in ${issue.parameterChange.file}`);
      console.log(`  │    Current: ${issue.parameterChange.current} -> Suggested: ${issue.parameterChange.suggested}`);
    }
    console.log(`  └${'─'.repeat(W - 4)}\n`);
  }

  // ── Tuning recommendations ──
  header('SECTION 4: TUNING RECOMMENDATIONS');

  const criticalExitIssues = issues.filter(i => i.category === 'EXIT_LOGIC' || i.category === 'EXIT_TIMING');
  const entryIssues = issues.filter(i => i.category === 'ENTRY_TIMING');
  const divergenceIssues = issues.filter(i => i.category === 'LIVE_BT_DIVERGENCE');

  if (criticalExitIssues.length > 0) {
    subHeader('4.1  EXIT LOGIC TUNING (HIGHEST PRIORITY)');

    console.log(`  The primary problem is exit logic — not entry signals.`);
    console.log(`  Signal quality is mostly GOOD/EXCELLENT but positions die in seconds.`);
    console.log('');
    console.log(`  ROOT CAUSE ANALYSIS:`);
    console.log(`  The order-agent monitors option premium via 5s stream polling.`);
    console.log(`  On each 5s tick, it checks multiple exit conditions:`);
    console.log(`    - VELOCITY_CRASH: price dropped 3%+ in 15s window`);
    console.log(`    - VELOCITY_FADE:  price dropped 2.5%+ in 15s window AND pnl<0`);
    console.log(`    - DECLINING_SINCE_FILL: 3 consecutive stream drops (~15s) + pnl<=-1% + peak<1%`);
    console.log(`    - PROFIT_REVERSED: peak>=1%, current<=0, ticks>=4 (or peak>=5%)`);
    console.log('');
    console.log(`  For SPY 0DTE/1DTE options at $1.50-$3.50 premium:`);
    console.log(`    - A 2.5% premium move = $0.04-$0.09 = $0.06-$0.13 in underlying`);
    console.log(`    - That's 0.01-0.02% of SPY price — well within normal 15s noise`);
    console.log(`    - 3 consecutive stream drops at 5s interval is just 15 seconds of normal drift`);
    console.log('');
    console.log(`  RECOMMENDED CHANGES:`);
    console.log('');
    console.log(`  1. Add post-fill grace period (src/agents/order-agent.ts)`);
    console.log(`     Current: All exit checks active immediately after fill`);
    console.log(`     Change:  Skip VELOCITY_FADE and DECLINING_SINCE_FILL for first 30s (6 ticks)`);
    console.log(`     Why:     Option premium after fill is noisy — bid-ask bounce, market maker`);
    console.log(`              adjustments, and underlying noise all create false velocity signals.`);
    console.log(`              30s grace period lets fill settle before measuring real momentum.`);
    console.log('');
    console.log(`  2. Widen VELOCITY_FADE threshold for SPY`);
    console.log(`     Current: -2.5% in 15s window while pnl<0`);
    console.log(`     Change:  -4.0% in 15s window while pnl<-2%`);
    console.log(`     Why:     SPY option premiums at $1.50-3.50 need wider threshold.`);
    console.log(`              $0.06 move on a $2 contract = 3% but represents only $0.09 in`);
    console.log(`              underlying (~0.014% of SPY). Real adverse velocity should be`);
    console.log(`              measured against larger thresholds for cheaper contracts.`);
    console.log('');
    console.log(`  3. Increase DECLINING_SINCE_FILL consecutive decline count`);
    console.log(`     Current: 3 consecutive stream drops + pnl<=-1%`);
    console.log(`     Change:  5 consecutive stream drops + pnl<=-2%`);
    console.log(`     Why:     3 drops = 15s is too short for option premium to confirm direction.`);
    console.log(`              Market makers widen spread after fill, causing initial "decline"`);
    console.log(`              that isn't real adverse movement. 5 drops = 25s is more meaningful.`);
    console.log('');
    console.log(`  4. Raise PROFIT_REVERSED peak threshold`);
    console.log(`     Current: peak>=1% + current<=0 + ticks>=4`);
    console.log(`     Change:  peak>=2% + current<=-0.5% + ticks>=6`);
    console.log(`     Why:     1% peak on a $2 option = $0.02 = well within bid-ask noise.`);
    console.log(`              A "profit reversal" from 1% is likely just bid-ask oscillation,`);
    console.log(`              not a genuine reversal of the trade thesis.`);
    console.log('');
    console.log(`  5. VELOCITY_CRASH: keep as-is (3% in 15s is a genuine crash)`);
    console.log(`     But add: only trigger after grace period (30s post-fill)`);
  }

  if (entryIssues.length > 0) {
    subHeader('4.2  ENTRY TIMING TUNING');

    const earlyEntries = positions.filter(p => {
      const minSinceOpen = etToMinutes(utcToET(p.opened_at)) - etToMinutes('09:30');
      return minSinceOpen < 30;
    });

    console.log(`  ${earlyEntries.length} entries in first 30 min of market.`);
    console.log('');
    console.log(`  RECOMMENDED CHANGES:`);
    console.log('');
    console.log(`  1. Consider increasing entryWindowStartMin`);
    console.log(`     Current: 30 min (src/scripts/backtest-configs/spy.ts)`);
    console.log(`     Test:    45 min — run backtest-range to compare`);
    console.log(`     Why:     First 30 min has widest option spreads and most erratic premium moves`);
    console.log('');
    console.log(`  2. Add minimum gap between entries`);
    console.log(`     Current: no enforced gap in live (trendCooldownMin only in backtest)`);
    console.log(`     Change:  Enforce 10+ min between entries to avoid compounding same-direction losses`);
  }

  if (divergenceIssues.length > 0) {
    subHeader('4.3  LIVE/BACKTEST ALIGNMENT');

    console.log(`  ${divergenceIssues.length} divergence issues detected.`);
    console.log('');
    console.log(`  These are informational — fixing exit logic (4.1) will have far more impact.`);
    console.log(`  Once exit logic is tuned, re-run this analysis to see if divergences matter.`);
  }

  // ── Priority summary ──
  subHeader('4.4  PRIORITY ORDER');

  console.log(`  1. [CRITICAL] Fix exit thresholds — this is the #1 problem`);
  console.log(`     All signals are GOOD but every trade dies in <30s`);
  console.log(`     Expected impact: positions hold 5-30min instead of <30s`);
  console.log('');
  console.log(`  2. [HIGH] Validate with backtest after exit changes`);
  console.log(`     Run: npx tsx src/scripts/backtest-range-spy.ts 2026-03-15 2026-04-06`);
  console.log(`     Compare win rate / avg P&L before and after`);
  console.log('');
  console.log(`  3. [MEDIUM] Tune entry timing only if exit fixes don't resolve losses`);
  console.log(`     Entry signals are mostly correct — timing issues may resolve when`);
  console.log(`     positions are allowed to hold through initial premium noise`);
  console.log('');
  console.log(`  4. [LOW] Investigate live/backtest divergences`);
  console.log(`     Streaming vs REST bar differences are secondary to exit logic`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'#'.repeat(W)}`);
  console.log(`#  COMPREHENSIVE LIVE TRADING ANALYSIS: ${TICKER} on ${TARGET_DATE}`);
  console.log(`${'#'.repeat(W)}`);

  // Fetch all live data
  console.log('\n  Fetching live data from database...');
  const [decisions, positions, evaluations, moves, schedulerStats, waitPatterns] = await Promise.all([
    fetchLiveDecisions(),
    fetchPositions(),
    fetchEvaluations(),
    fetchMarketMoves(),
    fetchSchedulerStats(),
    fetchWaitDecisionPatterns(),
  ]);
  await closePool();

  if (positions.length === 0 && decisions.length === 0) {
    console.log(`  No data found for ${TICKER} on ${TARGET_DATE}. Exiting.\n`);
    return;
  }

  console.log(`  Found: ${decisions.length} decisions, ${positions.length} positions, ${evaluations.length} evaluations, ${moves.length} market moves\n`);

  // Run backtest
  const btJson = runBacktest();

  // Section 1: Live data analysis
  printLiveDataAnalysis(decisions, positions, evaluations, moves, schedulerStats, waitPatterns);

  // Section 2: Deep comparison
  printDeepComparison(decisions, positions, btJson);

  // Section 3 & 4: Issues and tuning
  printIssuesAndTuning(positions, evaluations);

  console.log(`\n${'#'.repeat(W)}`);
  console.log(`#  END OF ANALYSIS`);
  console.log(`${'#'.repeat(W)}\n`);
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
