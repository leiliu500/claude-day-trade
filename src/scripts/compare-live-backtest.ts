/**
 * compare-live-backtest.ts — Deep comparison of live trading vs backtest predictions.
 *
 * Queries the DB for live decisions + signal snapshots on a given date,
 * runs the backtest in --json mode for the same day, and outputs a detailed
 * side-by-side comparison with confidence breakdown, indicator values,
 * signal mode, and divergence analysis.
 *
 * Usage:
 *   npx tsx src/scripts/compare-live-backtest.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: today (ET), SPY
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { getPool, closePool } from '../db/client.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';

// ── Config ────────────────────────────────────────────────────────────────────

const now = new Date();
const etNow = new Date(now.getTime() - 4 * 60 * 60_000);
const DEFAULT_DATE = etNow.toISOString().slice(0, 10);

const TARGET_DATE = process.argv[2] || DEFAULT_DATE;
const TICKER = process.argv[3] || 'SPY';

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveEntry {
  // Decision fields
  id: string;
  decision_type: string;
  direction: string | null;
  confirmation_count: number;
  orchestration_confidence: number;
  reasoning: string;
  should_execute: boolean;
  entry_strategy: {
    stage?: string;
    confirmation_count?: number;
    notes?: string;
  } | null;
  created_at: string;
  // Position fields
  position_id: string | null;
  entry_price: number | null;
  exit_price: number | null;
  close_reason: string | null;
  realized_pnl: number | null;
  // Signal snapshot fields
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
  // Full JSON payloads
  signal_payload: any | null;
  analysis_payload: any | null;
  option_payload: any | null;
}

interface BacktestJsonEntry {
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
  confirmed: BacktestJsonEntry[];
  blocked: BacktestJsonEntry[];
  filtered?: { time: string; timeET: string; direction: string; mode: string; confidence: number; price: number; grade: string; outcome: string; filterRule: string; filterCategory: string; mfePct: number; maePct: number; }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function utcToET(utcTime: string): string {
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4); // EDT
  return d.toISOString().slice(11, 16);
}

function etToMinutes(et: string): number {
  const [h, m] = et.split(':').map(Number);
  return h! * 60 + m!;
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

function fmtNum(v: number | string | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return '—';
  return n.toFixed(decimals);
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

// ── Fetch live decisions + signal snapshots from DB ─────────────────────────

async function fetchLiveEntries(): Promise<LiveEntry[]> {
  const pool = getPool();
  const { rows } = await pool.query<LiveEntry>(
    `SELECT
       d.id, d.decision_type, d.direction, d.confirmation_count,
       d.orchestration_confidence, d.reasoning, d.should_execute,
       d.entry_strategy, d.created_at,
       pj.id as position_id, pj.entry_price, pj.exit_price,
       pj.close_reason, pj.realized_pnl,
       -- Signal snapshot fields
       ss.direction as signal_direction,
       ss.alignment as signal_alignment,
       ss.confidence as signal_confidence,
       COALESCE((ss.analysis_payload->>'selectedMode'), 'trend') as signal_mode,
       ss.entry_premium as signal_entry_premium,
       ss.stop_premium as signal_stop_premium,
       ss.tp_premium as signal_tp_premium,
       ss.risk_reward as signal_risk_reward,
       ss.spread_pct as signal_spread_pct,
       ss.option_liquidity_ok as signal_liquidity_ok,
       ss.selected_symbol as signal_selected_symbol,
       -- Full payloads
       ss.signal_payload,
       ss.analysis_payload,
       ss.option_payload
     FROM trading.trading_decisions d
     LEFT JOIN trading.position_journal pj ON d.id = pj.decision_id
     LEFT JOIN trading.signal_snapshots ss ON d.signal_snapshot_id = ss.id
     WHERE d.trade_date = $1::date AND d.ticker = $2
     ORDER BY d.created_at ASC`,
    [TARGET_DATE, TICKER]
  );
  return rows;
}

// ── Run backtest in JSON mode ───────────────────────────────────────────────

function runBacktestJson(): BacktestJson | null {
  try {
    const output = execSync(
      `npx tsx src/scripts/backtest-day.ts ${TARGET_DATE} ${TICKER} --json`,
      { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const jsonMatch = output.match(/__JSON_START__(.+?)__JSON_END__/);
    if (!jsonMatch) {
      console.error('  ⚠ No JSON output found in backtest');
      return null;
    }
    return JSON.parse(jsonMatch[1]!) as BacktestJson;
  } catch (err) {
    console.error(`  Backtest failed: ${(err as Error).message}`);
    return null;
  }
}

// ── Confidence breakdown comparison ─────────────────────────────────────────

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

function printBreakdownComparison(live: ConfidenceBreakdown | null, bt: ConfidenceBreakdown, indent = '      ') {
  const keys = Object.keys(BREAKDOWN_LABELS) as (keyof ConfidenceBreakdown)[];
  const diffs: { key: string; label: string; liveVal: number | null; btVal: number; diff: number }[] = [];

  for (const key of keys) {
    const btVal = bt[key] as number;
    const liveVal = live ? (live[key] as number) : null;
    const diff = liveVal != null ? liveVal - btVal : 0;
    diffs.push({ key, label: BREAKDOWN_LABELS[key]!, liveVal, btVal, diff });
  }

  // Only show factors where there's a meaningful difference or non-zero value
  const significant = diffs.filter(d =>
    d.key === 'total' || Math.abs(d.diff) >= 0.01 || Math.abs(d.btVal) >= 0.01 || (d.liveVal != null && Math.abs(d.liveVal) >= 0.01)
  );

  console.log(`${indent}${'Factor'.padEnd(22)} ${'Live'.padStart(8)} ${'Backtest'.padStart(8)} ${'Diff'.padStart(8)}`);
  console.log(`${indent}${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);

  for (const d of significant) {
    const liveStr = d.liveVal != null ? fmtPct(d.liveVal).padStart(8) : '    —   ';
    const btStr = fmtPct(d.btVal).padStart(8);
    let diffStr = '        ';
    if (d.liveVal != null && d.key !== 'total') {
      const diffPct = fmtPct(d.diff);
      const arrow = Math.abs(d.diff) >= 0.03 ? ' ◀◀' : Math.abs(d.diff) >= 0.01 ? ' ◀' : '';
      diffStr = (diffPct + arrow).padStart(12);
    }
    const isSeparator = d.key === 'total';
    if (isSeparator) console.log(`${indent}${'─'.repeat(50)}`);
    console.log(`${indent}${d.label.padEnd(22)} ${liveStr} ${btStr} ${diffStr}`);
  }
}

// ── Indicator comparison from signal payloads ───────────────────────────────

function extractIndicators(signalPayload: any): Record<string, any> | null {
  if (!signalPayload?.timeframes?.length) return null;

  const tfs = signalPayload.timeframes;
  const result: Record<string, any> = {
    direction: signalPayload.direction,
    alignment: signalPayload.alignment,
    currentPrice: signalPayload.currentPrice,
    atr: signalPayload.atr,
    signalMode: signalPayload.signalMode,
    regimeClarity: signalPayload.regimeClarity,
    strengthScore: signalPayload.strengthScore,
  };

  // Extract per-timeframe indicators
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i];
    const label = i === 0 ? 'LTF' : i === 1 ? 'MTF' : 'HTF';
    const tfName = tf.timeframe || label;

    result[`${label}_tf`] = tfName;
    if (tf.dmi) {
      result[`${label}_plusDI`] = tf.dmi.plusDI;
      result[`${label}_minusDI`] = tf.dmi.minusDI;
      result[`${label}_adx`] = typeof tf.dmi.adx === 'string' ? parseFloat(tf.dmi.adx) : tf.dmi.adx;
      result[`${label}_adxSlope`] = tf.dmi.adxSlope;
      result[`${label}_diSpreadSlope`] = tf.dmi.diSpreadSlope;
    }
    if (tf.atr) {
      result[`${label}_atr`] = tf.atr.atr;
      result[`${label}_atrPct`] = tf.atr.atrPct;
    }
    if (tf.obv) {
      result[`${label}_obvTrend`] = tf.obv.trend;
      result[`${label}_obvDivergence`] = tf.obv.divergence;
    }
    if (tf.vwap) {
      result[`${label}_vwap`] = tf.vwap.vwap;
      result[`${label}_priceVsVwap`] = tf.vwap.priceVsVwap;
    }
    if (tf.td?.setup) {
      result[`${label}_tdSetup`] = `${tf.td.setup.direction} ${tf.td.setup.count}`;
    }
    if (tf.priceVelocity) {
      result[`${label}_roc`] = tf.priceVelocity.roc;
      result[`${label}_acceleration`] = tf.priceVelocity.acceleration;
    }
    if (tf.volumeSurge) {
      result[`${label}_volRatio`] = tf.volumeSurge.volumeRatio;
      result[`${label}_volTrend`] = tf.volumeSurge.volumeTrend;
    }
    if (tf.priceStructure) {
      result[`${label}_rangePos`] = tf.priceStructure.rangePosition;
    }
    result[`${label}_candlePattern`] = tf.candlePattern || 'none';
  }

  // Market structure
  if (signalPayload.priorDayLevels) {
    result.pdh = signalPayload.priorDayLevels.pdh;
    result.pdl = signalPayload.priorDayLevels.pdl;
    result.structureBias = signalPayload.priorDayLevels.structureBias;
  }
  if (signalPayload.orb) {
    result.orbBreakout = signalPayload.orb.breakoutDirection;
    result.orbStrength = signalPayload.orb.breakoutStrength;
  }

  return result;
}

function printIndicatorComparison(liveIndicators: Record<string, any>, indent = '      ') {
  const groups = [
    {
      title: 'Signal Overview',
      keys: ['direction', 'alignment', 'signalMode', 'currentPrice', 'atr', 'strengthScore', 'regimeClarity'],
    },
    {
      title: 'HTF Indicators (15m)',
      keys: ['HTF_plusDI', 'HTF_minusDI', 'HTF_adx', 'HTF_adxSlope', 'HTF_diSpreadSlope', 'HTF_obvTrend', 'HTF_obvDivergence', 'HTF_vwap', 'HTF_priceVsVwap', 'HTF_tdSetup', 'HTF_roc', 'HTF_acceleration', 'HTF_volRatio', 'HTF_volTrend', 'HTF_rangePos', 'HTF_candlePattern'],
    },
    {
      title: 'MTF Indicators (3m/5m)',
      keys: ['MTF_plusDI', 'MTF_minusDI', 'MTF_adx', 'MTF_adxSlope', 'MTF_diSpreadSlope', 'MTF_obvTrend', 'MTF_obvDivergence', 'MTF_priceVsVwap', 'MTF_tdSetup', 'MTF_roc', 'MTF_acceleration', 'MTF_volRatio', 'MTF_candlePattern'],
    },
    {
      title: 'LTF Indicators (1m)',
      keys: ['LTF_plusDI', 'LTF_minusDI', 'LTF_adx', 'LTF_adxSlope', 'LTF_diSpreadSlope', 'LTF_obvTrend', 'LTF_obvDivergence', 'LTF_priceVsVwap', 'LTF_tdSetup', 'LTF_roc', 'LTF_acceleration', 'LTF_volRatio', 'LTF_candlePattern'],
    },
    {
      title: 'Market Structure',
      keys: ['pdh', 'pdl', 'structureBias', 'orbBreakout', 'orbStrength'],
    },
  ];

  for (const group of groups) {
    const activeKeys = group.keys.filter(k => liveIndicators[k] != null);
    if (activeKeys.length === 0) continue;

    console.log(`${indent}── ${group.title} ──`);
    for (const key of activeKeys) {
      const val = liveIndicators[key];
      const label = key.replace(/^[A-Z]+_/, '').padEnd(20);
      const fmtVal = typeof val === 'number' ? fmtNum(val, 4) : String(val);
      console.log(`${indent}  ${label} ${fmtVal}`);
    }
  }
}

// ── Classify live gate ──────────────────────────────────────────────────────

function classifyLiveGate(d: LiveEntry): string {
  if (d.reasoning?.includes('[STAGE-1 OBSERVE]')) return 'STAGE1_OBSERVE';
  if (d.reasoning?.includes('[WEAKENING-SIGNAL BLOCK]')) return 'WEAKENING_BLOCK';
  if (d.reasoning?.includes('[STALE-SIGNAL BLOCK]')) return 'STALE_BLOCK';
  if (d.reasoning?.includes('[PHASE-CHANGE OVERRIDE]')) return 'PHASE_CHANGE_OVERRIDE';
  if (d.reasoning?.includes('[RANGE BYPASS]')) return 'RANGE_BYPASS';
  if (d.reasoning?.includes('[HIGH-CONV OVERRIDE]')) return 'HIGH_CONV_OVERRIDE';
  if (d.decision_type === 'NEW_ENTRY' && d.should_execute) return 'PASSED';
  return 'AI_WAIT';
}

// ── Divergence reasons ──────────────────────────────────────────────────────

function analyzeDivergenceReasons(
  live: LiveEntry | null,
  bt: BacktestJsonEntry,
  liveBreakdown: ConfidenceBreakdown | null,
): string[] {
  const reasons: string[] = [];

  if (!live) {
    // Backtest found entry, live didn't
    if (bt.gate === 'PASSED' || bt.gate === 'HIGH_CONV_OVERRIDE' || bt.gate === 'PHASE_CHANGE_OVERRIDE') {
      reasons.push('Live system had no matching signal at this time — possible data difference (streaming vs REST bars)');
    }
    return reasons;
  }

  // Compare confidence
  const liveConf = live.signal_confidence ?? live.orchestration_confidence;
  const confDiff = liveConf - bt.confidence;
  if (Math.abs(confDiff) >= 0.03) {
    reasons.push(`Confidence gap: live ${fmtPct(liveConf)} vs backtest ${fmtPct(bt.confidence)} (Δ${confDiff >= 0 ? '+' : ''}${fmtPct(confDiff)})`);
  }

  // Compare mode
  const liveMode = live.signal_mode || 'trend';
  if (liveMode !== bt.mode) {
    reasons.push(`Mode divergence: live=${liveMode}, backtest=${bt.mode} — different regime detection changes all confidence factors`);
  }

  // Compare gate result
  const liveGate = classifyLiveGate(live);
  if (liveGate !== bt.gate) {
    reasons.push(`Gate divergence: live=${liveGate}, backtest=${bt.gate}`);
  }

  // Compare breakdown factors
  if (liveBreakdown && bt.breakdown) {
    const bigDiffs: string[] = [];
    for (const [key, label] of Object.entries(BREAKDOWN_LABELS)) {
      if (key === 'total') continue;
      const liveVal = (liveBreakdown as any)[key] as number | undefined;
      const btVal = (bt.breakdown as any)[key] as number | undefined;
      if (liveVal != null && btVal != null) {
        const diff = liveVal - btVal;
        if (Math.abs(diff) >= 0.03) {
          bigDiffs.push(`${label}: ${fmtPct(diff)} (live ${fmtPct(liveVal)} vs bt ${fmtPct(btVal)})`);
        }
      }
    }
    if (bigDiffs.length > 0) {
      reasons.push(`Key confidence factor differences:\n        ${bigDiffs.join('\n        ')}`);
    }
  }

  // AI orchestrator vs deterministic
  if (live.orchestration_confidence !== liveConf) {
    const aiDelta = live.orchestration_confidence - liveConf;
    if (Math.abs(aiDelta) >= 0.02) {
      reasons.push(`AI orchestrator adjusted confidence by ${aiDelta >= 0 ? '+' : ''}${fmtPct(aiDelta)} (deterministic ${fmtPct(liveConf)} → orchestrated ${fmtPct(live.orchestration_confidence)})`);
    }
  }

  // Option data differences (backtest uses mocked options)
  if (live.signal_spread_pct != null && live.signal_spread_pct > 0.03) {
    reasons.push(`Wide option spread in live: ${(live.signal_spread_pct * 100).toFixed(1)}% — backtest doesn't penalize for real spreads`);
  }
  if (live.signal_liquidity_ok === false) {
    reasons.push(`Option liquidity check FAILED in live — backtest skips real liquidity check`);
  }

  // Data source difference
  reasons.push('Note: live uses streaming 1m bars (real-time), backtest uses REST historical bars (may differ at bar boundaries)');

  return reasons;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  DEEP LIVE vs BACKTEST COMPARISON: ${TICKER} on ${TARGET_DATE}`);
  console.log(`${'═'.repeat(100)}\n`);

  // ── 1. Fetch live data ──────────────────────────────────────────────────────
  console.log('  Fetching live decisions + signal snapshots from DB...');
  const liveEntries = await fetchLiveEntries();
  await closePool();

  // ── 2. Run backtest in JSON mode ────────────────────────────────────────────
  console.log(`  Running backtest for ${TARGET_DATE} ${TICKER} (--json mode)...`);
  const btJson = runBacktestJson();
  if (!btJson) return;

  const allBtEntries = [...btJson.confirmed, ...btJson.blocked];
  allBtEntries.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const liveExecuted = liveEntries.filter(d => d.decision_type === 'NEW_ENTRY' && d.should_execute);
  const liveStage1s = liveEntries.filter(d =>
    d.reasoning?.includes('[STAGE-1 OBSERVE]') ||
    (d.entry_strategy?.stage === 'OBSERVE' && d.confirmation_count === 1)
  );

  console.log(`  Found ${liveEntries.length} live decisions (${liveExecuted.length} executed, ${liveStage1s.length} stage-1)`);
  console.log(`  Found ${btJson.confirmed.length} backtest confirmed, ${btJson.blocked.length} blocked, ${btJson.filtered?.length ?? 0} filtered\n`);

  // ── 3. Detailed side-by-side per backtest entry ─────────────────────────────
  console.log(`  ${'─'.repeat(96)}`);
  console.log(`  ENTRY-BY-ENTRY COMPARISON`);
  console.log(`  ${'─'.repeat(96)}\n`);

  const matchedLiveIds = new Set<string>();

  for (let i = 0; i < allBtEntries.length; i++) {
    const bt = allBtEntries[i]!;
    const btMinutes = etToMinutes(bt.timeET);
    const btIsConfirmed = bt.gate === 'PASSED' || bt.gate === 'HIGH_CONV_OVERRIDE' || bt.gate === 'PHASE_CHANGE_OVERRIDE';

    // Find closest live decision within ±5 min window (wider for better matching)
    let closestLive: LiveEntry | null = null;
    let closestDiff = Infinity;
    for (const ld of liveEntries) {
      if (!ld.direction) continue;
      const liveET = utcToET(ld.created_at);
      const liveMin = etToMinutes(liveET);
      const diff = Math.abs(liveMin - btMinutes);
      if (diff <= 5 && ld.direction === bt.direction && diff < closestDiff) {
        closestDiff = diff;
        closestLive = ld;
      }
    }

    if (closestLive) matchedLiveIds.add(closestLive.id);

    const outcomeIcon = bt.outcome === 'GOOD' ? '✅' : bt.outcome === 'BAD' ? '❌' : '⚠️';
    const gateIcon = btIsConfirmed ? '🟢' : bt.gate === 'STAGE1_OBSERVE' ? '🔵' : '🔴';

    // ── Header ──
    console.log(`  ┌─ BACKTEST ENTRY #${i + 1} ──────────────────────────────────────────────────`);
    console.log(`  │  Time: ${bt.timeET} ET | ${bt.direction.toUpperCase()} | $${bt.price.toFixed(2)} | Mode: ${bt.mode}`);
    console.log(`  │  Confidence: ${fmtPct(bt.confidence)} | Grade: ${bt.grade} ${outcomeIcon} | Gate: ${gateIcon} ${bt.gate}`);
    if (btIsConfirmed) {
      console.log(`  │  Forward: MFE ${bt.mfePct.toFixed(2)}% | MAE ${bt.maePct.toFixed(2)}% | MFE/MAE ${bt.mfeOverMae.toFixed(1)}x | Peak at ${bt.mfePeakMinutes}min`);
      if (bt.sim) {
        console.log(`  │  Sim: ${bt.sim.exitReason} at ${bt.sim.holdMin}min | P&L ${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}% | Peak ${bt.sim.peakPnl.toFixed(2)}%`);
      }
    }
    if (bt.move5m != null || bt.move15m != null) {
      const moves = [
        bt.move5m != null ? `5m: ${bt.move5m >= 0 ? '+' : ''}${bt.move5m.toFixed(3)}%` : null,
        bt.move10m != null ? `10m: ${bt.move10m >= 0 ? '+' : ''}${bt.move10m.toFixed(3)}%` : null,
        bt.move15m != null ? `15m: ${bt.move15m >= 0 ? '+' : ''}${bt.move15m.toFixed(3)}%` : null,
        bt.move30m != null ? `30m: ${bt.move30m >= 0 ? '+' : ''}${bt.move30m.toFixed(3)}%` : null,
      ].filter(Boolean);
      console.log(`  │  Price moves: ${moves.join(' | ')}`);
    }

    // ── Live match ──
    console.log(`  │`);
    if (closestLive) {
      const leTime = utcToET(closestLive.created_at);
      const liveGate = classifyLiveGate(closestLive);
      const liveConf = closestLive.signal_confidence ?? closestLive.orchestration_confidence;
      const orchConf = closestLive.orchestration_confidence;
      const pnl = closestLive.realized_pnl !== null ? `P&L: $${Number(closestLive.realized_pnl).toFixed(2)}` : (closestLive.position_id ? 'OPEN' : '—');

      const liveIcon = closestLive.should_execute && closestLive.decision_type === 'NEW_ENTRY' ? '🟢' :
        liveGate === 'STAGE1_OBSERVE' ? '🔵' : '⏸️';

      console.log(`  │  ${liveIcon} LIVE MATCH at ${leTime} ET (Δ${closestDiff}min)`);
      console.log(`  │  Decision: ${closestLive.decision_type} | Execute: ${closestLive.should_execute} | Gate: ${liveGate}`);
      console.log(`  │  Signal conf: ${fmtPct(liveConf)} | Orchestrated conf: ${fmtPct(orchConf)} | ${pnl}`);
      if (closestLive.signal_mode) {
        console.log(`  │  Mode: ${closestLive.signal_mode} | Alignment: ${closestLive.signal_alignment || '—'}`);
      }

      // Option details (live only — backtest mocks these)
      if (closestLive.signal_selected_symbol) {
        console.log(`  │  Option: ${closestLive.signal_selected_symbol}`);
        console.log(`  │  Entry: $${fmtNum(closestLive.signal_entry_premium)} | Stop: $${fmtNum(closestLive.signal_stop_premium)} | TP: $${fmtNum(closestLive.signal_tp_premium)} | R:R ${fmtNum(closestLive.signal_risk_reward)}x`);
        console.log(`  │  Spread: ${closestLive.signal_spread_pct != null ? (closestLive.signal_spread_pct * 100).toFixed(1) + '%' : '—'} | Liquidity: ${closestLive.signal_liquidity_ok ? '✅' : '❌'}`);
      }

      // ── Confidence breakdown comparison ──
      const liveBreakdown = closestLive.analysis_payload?.confidenceBreakdown as ConfidenceBreakdown | undefined;
      if (liveBreakdown || bt.breakdown) {
        console.log(`  │`);
        console.log(`  │  ── Confidence Breakdown Comparison ──`);
        printBreakdownComparison(liveBreakdown || null, bt.breakdown, '  │    ');
      }

      // ── Indicator snapshot (live only — backtest doesn't export these) ──
      if (closestLive.signal_payload) {
        const indicators = extractIndicators(closestLive.signal_payload);
        if (indicators) {
          console.log(`  │`);
          console.log(`  │  ── Live Indicator Snapshot ──`);
          printIndicatorComparison(indicators, '  │    ');
        }
      }

      // ── Divergence reasons ──
      const reasons = analyzeDivergenceReasons(closestLive, bt, liveBreakdown || null);
      if (reasons.length > 0) {
        console.log(`  │`);
        console.log(`  │  ── Divergence Analysis ──`);
        for (const r of reasons) {
          const lines = r.split('\n');
          for (const line of lines) {
            console.log(`  │    • ${line}`);
          }
        }
      }
    } else {
      console.log(`  │  ── NO LIVE MATCH within ±5 min`);
      if (btIsConfirmed && bt.outcome === 'GOOD') {
        console.log(`  │  ⚠ MISSED OPPORTUNITY: This was a Grade ${bt.grade} entry with ${bt.mfePct.toFixed(2)}% MFE`);
      }
      console.log(`  │  Possible reasons:`);
      console.log(`  │    • Streaming bars may have produced different indicator values`);
      console.log(`  │    • AI orchestrator may have been cautious (streak/drawdown context)`);
      console.log(`  │    • Prior run may not have triggered at this exact time`);
    }

    console.log(`  └${'─'.repeat(96)}\n`);
  }

  // ── 4. Live entries NOT in backtest ─────────────────────────────────────────
  const unmatchedLive = liveExecuted.filter(le => !matchedLiveIds.has(le.id));

  if (unmatchedLive.length > 0) {
    console.log(`  ${'─'.repeat(96)}`);
    console.log(`  LIVE ENTRIES NOT IN BACKTEST`);
    console.log(`  ${'─'.repeat(96)}\n`);

    for (const le of unmatchedLive) {
      const leTime = utcToET(le.created_at);
      const pnl = le.realized_pnl !== null ? `P&L: $${Number(le.realized_pnl).toFixed(2)}` : 'OPEN';

      console.log(`  ┌─ LIVE-ONLY ENTRY ──────────────────────────────────────────────────`);
      console.log(`  │  Time: ${leTime} ET | ${le.direction?.toUpperCase()} | conf=${fmtPct(le.orchestration_confidence)} | ${pnl}`);
      if (le.signal_mode) {
        console.log(`  │  Mode: ${le.signal_mode} | Alignment: ${le.signal_alignment || '—'}`);
      }
      if (le.signal_selected_symbol) {
        console.log(`  │  Option: ${le.signal_selected_symbol} | Entry: $${fmtNum(le.signal_entry_premium)} | R:R ${fmtNum(le.signal_risk_reward)}x`);
      }

      console.log(`  │  Likely causes:`);
      console.log(`  │    • AI conviction from real-time context (not reproducible in backtest)`);
      console.log(`  │    • Real option data pushed confidence above threshold`);
      console.log(`  │    • Streaming bar timing differs from REST historical bars`);

      // Show live breakdown
      const liveBreakdown = le.analysis_payload?.confidenceBreakdown as ConfidenceBreakdown | undefined;
      if (liveBreakdown) {
        console.log(`  │`);
        console.log(`  │  ── Live Confidence Breakdown ──`);
        const keys = Object.keys(BREAKDOWN_LABELS) as (keyof ConfidenceBreakdown)[];
        for (const key of keys) {
          const val = liveBreakdown[key] as number;
          if (Math.abs(val) >= 0.01 || key === 'total') {
            const label = BREAKDOWN_LABELS[key]!;
            if (key === 'total') console.log(`  │    ${'─'.repeat(30)}`);
            console.log(`  │    ${label.padEnd(22)} ${fmtPct(val).padStart(8)}`);
          }
        }
      }

      // Show indicators
      if (le.signal_payload) {
        const indicators = extractIndicators(le.signal_payload);
        if (indicators) {
          console.log(`  │`);
          console.log(`  │  ── Live Indicator Snapshot ──`);
          printIndicatorComparison(indicators, '  │    ');
        }
      }

      console.log(`  └${'─'.repeat(96)}\n`);
    }
  }

  // ── 5. Filter-blocked entries (backtest only) ──────────────────────────────
  if (btJson.filtered && btJson.filtered.length > 0) {
    console.log(`  ${'─'.repeat(96)}`);
    console.log(`  FILTER-BLOCKED ENTRIES (backtest shouldAllowEntry rejected)`);
    console.log(`  ${'─'.repeat(96)}\n`);

    for (const fb of btJson.filtered) {
      const outcomeIcon = fb.outcome === 'GOOD' ? '✅' : fb.outcome === 'BAD' ? '❌' : '⚠️';
      console.log(`  ${fb.timeET} ET | ${fb.direction.toUpperCase()} | ${fb.mode} | conf=${fmtPct(fb.confidence)} | ${outcomeIcon} ${fb.grade}`);
      console.log(`    Filter: ${fb.filterRule} (${fb.filterCategory})`);
      console.log(`    MFE ${fb.mfePct.toFixed(2)}% | MAE ${fb.maePct.toFixed(2)}%`);
      console.log('');
    }
  }

  // ── 6. Completed entries comparison table ──────────────────────────────────
  console.log(`  ${'═'.repeat(96)}`);
  console.log(`  COMPLETED ENTRIES COMPARISON — Backtest vs Live`);
  console.log(`  ${'═'.repeat(96)}\n`);

  // Gather all backtest confirmed entries and all live executed entries
  const btExecuted = btJson.confirmed; // only confirmed (gate passed) entries for comparison
  const liveExec = liveEntries.filter(d => d.decision_type === 'NEW_ENTRY' && d.should_execute);

  interface MatchedEntry {
    btEntry: BacktestJsonEntry | null;
    liveEntry: LiveEntry | null;
    timeDiffMin: number | null;
  }
  const matched: MatchedEntry[] = [];
  const usedBtIdx = new Set<number>();
  const usedLiveIdx = new Set<number>();

  // Match backtest → live (±5 min, same direction)
  for (let bi = 0; bi < btExecuted.length; bi++) {
    const bt = btExecuted[bi]!;
    const btMin = etToMinutes(bt.timeET);
    let bestLi = -1;
    let bestDiff = Infinity;
    for (let li = 0; li < liveExec.length; li++) {
      if (usedLiveIdx.has(li)) continue;
      const le = liveExec[li]!;
      if (le.direction !== bt.direction) continue;
      const leMin = etToMinutes(utcToET(le.created_at));
      const diff = Math.abs(leMin - btMin);
      if (diff <= 5 && diff < bestDiff) {
        bestDiff = diff;
        bestLi = li;
      }
    }
    if (bestLi >= 0) {
      usedBtIdx.add(bi);
      usedLiveIdx.add(bestLi);
      matched.push({ btEntry: bt, liveEntry: liveExec[bestLi]!, timeDiffMin: bestDiff });
    }
  }

  // Unmatched backtest entries
  for (let bi = 0; bi < btExecuted.length; bi++) {
    if (!usedBtIdx.has(bi)) {
      matched.push({ btEntry: btExecuted[bi]!, liveEntry: null, timeDiffMin: null });
    }
  }

  // Unmatched live entries
  for (let li = 0; li < liveExec.length; li++) {
    if (!usedLiveIdx.has(li)) {
      matched.push({ btEntry: null, liveEntry: liveExec[li]!, timeDiffMin: null });
    }
  }

  // Sort by time (use whichever is available)
  matched.sort((a, b) => {
    const aTime = a.btEntry ? etToMinutes(a.btEntry.timeET) : etToMinutes(utcToET(a.liveEntry!.created_at));
    const bTime = b.btEntry ? etToMinutes(b.btEntry.timeET) : etToMinutes(utcToET(b.liveEntry!.created_at));
    return aTime - bTime;
  });

  if (matched.length === 0) {
    console.log(`  No executed entries to compare.\n`);
  } else {
    // Table header
    const hdr = [
      '#'.padStart(2),
      'Match'.padEnd(5),
      'Time(BT)'.padEnd(8),
      'Time(Live)'.padEnd(10),
      'ΔMin'.padStart(4),
      'Dir'.padEnd(7),
      'BT Price'.padStart(9),
      'Live Entry$'.padStart(11),
      'Live Exit$'.padStart(10),
      'BT Sim P&L'.padStart(10),
      'Live P&L'.padStart(10),
      'BT Exit'.padEnd(8),
      'Live Exit'.padEnd(12),
      'BT Grade'.padEnd(8),
      'Option'.padEnd(22),
    ];
    console.log(`  ${hdr.join(' │ ')}`);
    console.log(`  ${'─'.repeat(hdr.join(' │ ').length)}`);

    let btSimTotal = 0;
    let livePnlTotal = 0;
    let matchCount = 0;
    let btOnlyCount = 0;
    let liveOnlyCount = 0;

    for (let i = 0; i < matched.length; i++) {
      const m = matched[i]!;
      const bt = m.btEntry;
      const le = m.liveEntry;
      const isMatched = bt && le;

      let matchLabel: string;
      if (isMatched) { matchLabel = '✓'.padEnd(5); matchCount++; }
      else if (bt && !le) { matchLabel = 'BT'.padEnd(5); btOnlyCount++; }
      else { matchLabel = 'LIVE'.padEnd(5); liveOnlyCount++; }

      const btTime = bt ? bt.timeET.padEnd(8) : '—'.padEnd(8);
      const liveTime = le ? utcToET(le.created_at).padEnd(10) : '—'.padEnd(10);
      const timeDiff = m.timeDiffMin != null ? `${m.timeDiffMin}`.padStart(4) : '—'.padStart(4);
      const dir = (bt?.direction || le?.direction || '—').padEnd(7);
      const btPrice = bt ? `$${bt.price.toFixed(2)}`.padStart(9) : '—'.padStart(9);
      const liveEntryP = le?.entry_price != null ? `$${Number(le.entry_price).toFixed(2)}`.padStart(11) : '—'.padStart(11);
      const liveExitP = le?.exit_price != null ? `$${Number(le.exit_price).toFixed(2)}`.padStart(10) : (le?.position_id ? 'OPEN'.padStart(10) : '—'.padStart(10));

      const btSimPnl = bt?.sim ? `${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}%` : '—';
      const livePnl = le?.realized_pnl != null ? `$${Number(le.realized_pnl).toFixed(2)}` : (le?.position_id ? 'OPEN' : '—');

      const btExit = bt?.sim?.exitReason?.padEnd(8) || '—'.padEnd(8);
      const liveExit = (le?.close_reason || (le?.position_id ? 'OPEN' : '—')).padEnd(12);
      const btGrade = bt ? `${bt.grade}`.padEnd(8) : '—'.padEnd(8);
      const option = (le?.signal_selected_symbol || '—').padEnd(22);

      if (bt?.sim) btSimTotal += bt.sim.pnlPct;
      if (le?.realized_pnl != null) livePnlTotal += Number(le.realized_pnl);

      const row = [
        `${i + 1}`.padStart(2),
        matchLabel,
        btTime,
        liveTime,
        timeDiff,
        dir,
        btPrice,
        liveEntryP,
        liveExitP,
        btSimPnl.padStart(10),
        livePnl.padStart(10),
        btExit,
        liveExit,
        btGrade,
        option,
      ];
      console.log(`  ${row.join(' │ ')}`);
    }

    console.log(`  ${'─'.repeat(hdr.join(' │ ').length)}`);

    // Totals row
    console.log(`  Totals: ${matchCount} matched, ${btOnlyCount} backtest-only, ${liveOnlyCount} live-only`);
    console.log(`  BT Sim P&L total: ${btSimTotal >= 0 ? '+' : ''}${btSimTotal.toFixed(2)}% | Live P&L total: $${livePnlTotal.toFixed(2)}`);

    // Timing analysis for matched entries
    const matchedPairs = matched.filter(m => m.btEntry && m.liveEntry && m.timeDiffMin != null);
    if (matchedPairs.length > 0) {
      const avgTimeDiff = matchedPairs.reduce((s, m) => s + m.timeDiffMin!, 0) / matchedPairs.length;
      const maxTimeDiff = Math.max(...matchedPairs.map(m => m.timeDiffMin!));
      const exactMatches = matchedPairs.filter(m => m.timeDiffMin === 0).length;
      console.log(`\n  Entry Timing Analysis:`);
      console.log(`    Avg time offset:    ${avgTimeDiff.toFixed(1)} min`);
      console.log(`    Max time offset:    ${maxTimeDiff} min`);
      console.log(`    Exact matches (0m): ${exactMatches}/${matchedPairs.length}`);

      // Direction + outcome agreement
      let directionAgree = 0;
      let outcomeAgree = 0;
      for (const m of matchedPairs) {
        if (m.btEntry!.direction === m.liveEntry!.direction) directionAgree++;
        const btWin = m.btEntry!.sim && m.btEntry!.sim.pnlPct > 0;
        const liveWin = m.liveEntry!.realized_pnl != null && Number(m.liveEntry!.realized_pnl) > 0;
        if (btWin === liveWin) outcomeAgree++;
      }
      console.log(`    Direction agreement: ${directionAgree}/${matchedPairs.length}`);
      if (matchedPairs.every(m => m.liveEntry!.realized_pnl != null)) {
        console.log(`    Win/loss agreement: ${outcomeAgree}/${matchedPairs.length}`);
      }
    }

    console.log('');

    // ── Per-entry detailed difference analysis ──
    console.log(`  ${'─'.repeat(96)}`);
    console.log(`  DETAILED ENTRY-BY-ENTRY DIFFERENCES & REASONS`);
    console.log(`  ${'─'.repeat(96)}\n`);

    for (let i = 0; i < matched.length; i++) {
      const m = matched[i]!;
      const bt = m.btEntry;
      const le = m.liveEntry;

      const entryTime = bt ? bt.timeET : utcToET(le!.created_at);
      const dir = bt?.direction || le?.direction || '?';

      if (bt && le) {
        // ── MATCHED ENTRY ──
        const leTime = utcToET(le.created_at);
        const liveConf = le.signal_confidence ?? le.orchestration_confidence;
        const confDiff = liveConf - bt.confidence;
        const liveMode = le.signal_mode || 'trend';
        const btWin = bt.sim && bt.sim.pnlPct > 0;
        const liveWin = le.realized_pnl != null && Number(le.realized_pnl) > 0;
        const livePnlVal = le.realized_pnl != null ? Number(le.realized_pnl) : null;

        console.log(`  ┌─ #${i + 1} MATCHED: ${bt.timeET} ET ${dir.toUpperCase()} ─────────────────────────────────────`);

        // Timing difference
        if (m.timeDiffMin! > 0) {
          console.log(`  │  TIMING: BT ${bt.timeET} vs Live ${leTime} (${m.timeDiffMin}min offset)`);
          console.log(`  │    Why: Live uses streaming 1m bars aggregated in real-time; backtest uses REST historical bars.`);
          console.log(`  │    Bar boundary alignment can shift signal trigger by 1-3 min. Scheduler 3-min cycle adds jitter.`);
        } else {
          console.log(`  │  TIMING: Exact match at ${bt.timeET} ET`);
        }

        // Entry price difference
        if (le.entry_price != null) {
          const btSpotPrice = bt.price;
          const livePremium = Number(le.entry_price);
          console.log(`  │  ENTRY PRICE: BT spot $${btSpotPrice.toFixed(2)} | Live option premium $${livePremium.toFixed(2)} (${le.signal_selected_symbol || '—'})`);
          console.log(`  │    Note: BT sim uses spot price % moves; live uses actual option premium with Greeks + spread.`);
        }

        // Confidence difference
        if (Math.abs(confDiff) >= 0.01) {
          const arrow = confDiff > 0 ? 'higher' : 'lower';
          console.log(`  │  CONFIDENCE: BT ${fmtPct(bt.confidence)} vs Live ${fmtPct(liveConf)} (live ${fmtPct(Math.abs(confDiff))} ${arrow})`);

          // Break down the confidence difference by factor
          const liveBreakdown = le.analysis_payload?.confidenceBreakdown as ConfidenceBreakdown | undefined;
          if (liveBreakdown && bt.breakdown) {
            const factorDiffs: { label: string; diff: number; liveVal: number; btVal: number }[] = [];
            for (const [key, label] of Object.entries(BREAKDOWN_LABELS)) {
              if (key === 'total') continue;
              const lVal = (liveBreakdown as any)[key] as number | undefined;
              const bVal = (bt.breakdown as any)[key] as number | undefined;
              if (lVal != null && bVal != null && Math.abs(lVal - bVal) >= 0.01) {
                factorDiffs.push({ label, diff: lVal - bVal, liveVal: lVal, btVal: bVal });
              }
            }
            if (factorDiffs.length > 0) {
              factorDiffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
              console.log(`  │    Top divergent factors:`);
              for (const fd of factorDiffs.slice(0, 5)) {
                const sign = fd.diff >= 0 ? '+' : '';
                console.log(`  │      ${fd.label.padEnd(20)} live ${fmtPct(fd.liveVal).padStart(6)} vs bt ${fmtPct(fd.btVal).padStart(6)} (${sign}${fmtPct(fd.diff)})`);
              }
              // Explain likely root cause per factor
              const topFactor = factorDiffs[0]!;
              if (['OBV', 'VWAP'].some(k => topFactor.label.includes(k))) {
                console.log(`  │    Likely cause: OBV/VWAP computed over different bar counts (streaming cache ~800 bars vs REST fetch)`);
              } else if (['DI Spread', 'ADX', 'DI Cross'].some(k => topFactor.label.includes(k))) {
                console.log(`  │    Likely cause: DMI indicators sensitive to bar boundary timing — 1-min aggregation differences`);
              } else if (topFactor.label.includes('Price')) {
                console.log(`  │    Likely cause: Price-based indicators use real-time tick vs bar close — small price deltas compound`);
              } else if (topFactor.label.includes('Volume')) {
                console.log(`  │    Likely cause: Volume data differs between SIP streaming and REST consolidation`);
              }
            }
          }

          // AI orchestrator adjustment
          if (le.orchestration_confidence !== liveConf) {
            const aiDelta = le.orchestration_confidence - liveConf;
            if (Math.abs(aiDelta) >= 0.01) {
              console.log(`  │    AI orchestrator adjusted: ${fmtPct(liveConf)} → ${fmtPct(le.orchestration_confidence)} (${aiDelta >= 0 ? '+' : ''}${fmtPct(aiDelta)})`);
              console.log(`  │    Backtest has no AI orchestrator — this is a live-only adjustment based on session context.`);
            }
          }
        } else {
          console.log(`  │  CONFIDENCE: Match — BT ${fmtPct(bt.confidence)} ≈ Live ${fmtPct(liveConf)}`);
        }

        // Mode difference
        if (liveMode !== bt.mode) {
          console.log(`  │  MODE: BT=${bt.mode} vs Live=${liveMode}`);
          console.log(`  │    Why: Mode detection depends on price structure (swing highs/lows), VWAP deviation, and range`);
          console.log(`  │    position — all sensitive to which bars are in the lookback window at trigger time.`);
        }

        // Exit reason / P&L difference
        if (bt.sim && livePnlVal != null) {
          const btExitR = bt.sim.exitReason;
          const liveExitR = le.close_reason || 'OPEN';
          const btPnl = bt.sim.pnlPct;

          console.log(`  │  EXIT: BT sim=${btExitR} (${btPnl >= 0 ? '+' : ''}${btPnl.toFixed(2)}%) vs Live=${liveExitR} ($${livePnlVal.toFixed(2)})`);

          if (btWin !== liveWin) {
            console.log(`  │    OUTCOME DIVERGED: BT ${btWin ? 'WIN' : 'LOSS'} vs Live ${liveWin ? 'WIN' : 'LOSS'}`);
            const reasons: string[] = [];
            if (btExitR !== liveExitR) {
              reasons.push(`Different exit mechanism: BT sim uses fixed stop/TP on spot; live uses option premium stops with real fills`);
            }
            reasons.push(`BT sim uses close prices for stop/TP checks; live monitors every 5s via option quote polling`);
            reasons.push(`Option premium decay (theta) and vol changes affect live P&L but not BT spot sim`);
            if (le.signal_spread_pct != null && le.signal_spread_pct > 0.02) {
              reasons.push(`Live option spread was ${(le.signal_spread_pct * 100).toFixed(1)}% — entry/exit slippage not modeled in BT`);
            }
            for (const r of reasons) {
              console.log(`  │      • ${r}`);
            }
          } else if (btExitR !== liveExitR) {
            console.log(`  │    Same outcome (both ${btWin ? 'win' : 'loss'}) but different exit: BT=${btExitR}, Live=${liveExitR}`);
            console.log(`  │      • BT sim checks stop/TP on 1-min bar close; live checks every 5s on option mid price`);
            console.log(`  │      • Intrabar wicks can trigger live stops that BT sim misses (or vice versa)`);
          }
        } else if (bt.sim && le.position_id && livePnlVal == null) {
          console.log(`  │  EXIT: BT sim=${bt.sim.exitReason} (${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}%) | Live position still OPEN`);
        }

        // Grade assessment
        if (bt.outcome === 'GOOD') {
          console.log(`  │  VERDICT: BT grades this ${bt.grade} (GOOD) — MFE ${bt.mfePct.toFixed(2)}%, MAE ${bt.maePct.toFixed(2)}%`);
        } else if (bt.outcome === 'BAD') {
          console.log(`  │  VERDICT: BT grades this ${bt.grade} (BAD) — MFE ${bt.mfePct.toFixed(2)}%, MAE ${bt.maePct.toFixed(2)}%`);
        }

        console.log(`  └${'─'.repeat(90)}\n`);

      } else if (bt && !le) {
        // ── BACKTEST-ONLY ENTRY ──
        console.log(`  ┌─ #${i + 1} BACKTEST-ONLY: ${bt.timeET} ET ${dir.toUpperCase()} ────────────────────────────────`);
        console.log(`  │  BT: ${bt.grade} ${bt.outcome} | conf=${fmtPct(bt.confidence)} | mode=${bt.mode} | MFE ${bt.mfePct.toFixed(2)}%`);
        if (bt.sim) {
          console.log(`  │  BT sim: ${bt.sim.exitReason} | ${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}%`);
        }
        console.log(`  │  WHY NOT IN LIVE:`);

        // Check if there's a non-executed live decision near this time
        const btMin = etToMinutes(bt.timeET);
        const nearbyLiveAll = liveEntries.filter(ld => {
          if (!ld.direction || ld.direction !== bt.direction) return false;
          const ldMin = etToMinutes(utcToET(ld.created_at));
          return Math.abs(ldMin - btMin) <= 6;
        });

        if (nearbyLiveAll.length > 0) {
          for (const nl of nearbyLiveAll) {
            const nlTime = utcToET(nl.created_at);
            const nlGate = classifyLiveGate(nl);
            console.log(`  │    Found nearby live decision at ${nlTime} ET — gate=${nlGate}, execute=${nl.should_execute}`);
            if (nlGate === 'STAGE1_OBSERVE') {
              console.log(`  │    → Signal was at stage-1 (observe), needed 2nd confirmation that never came`);
            } else if (nlGate === 'AI_WAIT') {
              console.log(`  │    → AI orchestrator chose to wait: "${(nl.reasoning || '').slice(0, 120)}"`);
            } else if (nlGate === 'WEAKENING_BLOCK') {
              console.log(`  │    → Signal was weakening by the time live evaluated it`);
            } else if (nlGate === 'STALE_BLOCK') {
              console.log(`  │    → Signal was stale (old) when live evaluated`);
            } else if (!nl.should_execute) {
              console.log(`  │    → Decision made but should_execute=false: "${(nl.reasoning || '').slice(0, 120)}"`);
            }
          }
        } else {
          console.log(`  │    No live decision found within ±6 min — signal likely never triggered in live`);
          console.log(`  │    Possible causes:`);
          console.log(`  │      • Streaming bar data produced different indicator values at this time`);
          console.log(`  │      • Scheduler cycle (3min) may have evaluated at a different bar`);
          console.log(`  │      • Prior position was still open, blocking new entry`);
        }

        if (bt.outcome === 'GOOD') {
          console.log(`  │  IMPACT: Missed a GOOD entry — ${bt.mfePct.toFixed(2)}% MFE potential${bt.sim ? `, sim P&L ${bt.sim.pnlPct >= 0 ? '+' : ''}${bt.sim.pnlPct.toFixed(2)}%` : ''}`);
        } else {
          console.log(`  │  IMPACT: Avoided a ${bt.outcome} entry — this was correct to skip`);
        }
        console.log(`  └${'─'.repeat(90)}\n`);

      } else if (!bt && le) {
        // ── LIVE-ONLY ENTRY ──
        const leTime = utcToET(le.created_at);
        const liveConf = le.signal_confidence ?? le.orchestration_confidence;
        const livePnlVal = le.realized_pnl != null ? Number(le.realized_pnl) : null;

        console.log(`  ┌─ #${i + 1} LIVE-ONLY: ${leTime} ET ${dir.toUpperCase()} ──────────────────────────────────────`);
        console.log(`  │  Live: conf=${fmtPct(liveConf)} | mode=${le.signal_mode || '—'} | ${le.signal_selected_symbol || '—'}`);
        if (livePnlVal != null) {
          console.log(`  │  Result: ${le.close_reason} | P&L $${livePnlVal.toFixed(2)}`);
        } else if (le.position_id) {
          console.log(`  │  Result: OPEN`);
        }
        console.log(`  │  WHY NOT IN BACKTEST:`);

        // Check if there's a nearby backtest signal (blocked or filtered)
        const leMin = etToMinutes(leTime);
        const nearbyBtBlocked = btJson.blocked.filter(b => {
          return Math.abs(etToMinutes(b.timeET) - leMin) <= 6 && b.direction === le.direction;
        });
        const nearbyBtFiltered = (btJson.filtered || []).filter(f => {
          return Math.abs(etToMinutes(f.timeET) - leMin) <= 6 && f.direction === le.direction;
        });

        if (nearbyBtBlocked.length > 0) {
          for (const nb of nearbyBtBlocked) {
            console.log(`  │    BT had a BLOCKED signal at ${nb.timeET} ET — gate=${nb.gate}, conf=${fmtPct(nb.confidence)}`);
            console.log(`  │    → Live AI overrode the gate and executed; backtest deterministic gate blocked it`);
          }
        } else if (nearbyBtFiltered.length > 0) {
          for (const nf of nearbyBtFiltered) {
            console.log(`  │    BT had a FILTERED signal at ${nf.timeET} ET — filter=${nf.filterRule} (${nf.filterCategory})`);
            console.log(`  │    → Live system doesn't apply this backtest filter, or AI overrode it`);
          }
        } else {
          console.log(`  │    No backtest signal found within ±6 min`);
          console.log(`  │    Possible causes:`);
          console.log(`  │      • Streaming bars produced a signal that REST bars don't show`);
          console.log(`  │      • AI orchestrator created entry from session context (not reproducible in backtest)`);
          console.log(`  │      • Real option data (spread, liquidity) pushed signal above threshold`);
        }

        if (livePnlVal != null) {
          const impact = livePnlVal > 0 ? 'Live-only entry was profitable — backtest is too conservative here' :
            'Live-only entry lost money — backtest was right to not trigger';
          console.log(`  │  IMPACT: ${impact}`);
        }
        console.log(`  └${'─'.repeat(90)}\n`);
      }
    }
  }

  // ── 7. Summary ──────────────────────────────────────────────────────────────
  console.log(`  ${'═'.repeat(96)}`);
  console.log(`  SUMMARY`);
  console.log(`  ${'═'.repeat(96)}\n`);

  // Counts
  const btConfirmed = btJson.confirmed;
  const btBlocked = btJson.blocked;

  console.log(`  Backtest:  ${allBtEntries.length} total entries (${btConfirmed.length} confirmed, ${btBlocked.length} blocked, ${btJson.filtered?.length ?? 0} filtered)`);
  console.log(`  Live:      ${liveEntries.length} decisions (${liveExecuted.length} executed, ${liveStage1s.length} stage-1)\n`);

  // Alignment score
  let aligned = 0;
  let missedGoodCount = 0;
  let avoidedBadCount = 0;

  for (const bt of btConfirmed) {
    const btMin = etToMinutes(bt.timeET);
    const hasLiveMatch = liveExecuted.some(le => {
      const leMin = etToMinutes(utcToET(le.created_at));
      return Math.abs(leMin - btMin) <= 5 && le.direction === bt.direction;
    });
    if (hasLiveMatch) {
      aligned++;
    } else if (bt.outcome === 'GOOD') {
      missedGoodCount++;
    } else if (bt.outcome === 'BAD') {
      avoidedBadCount++;
    }
  }

  console.log(`  Alignment (backtest confirmed → live entry within ±5 min):`);
  console.log(`    Matched:      ${aligned}/${btConfirmed.length}`);
  if (btConfirmed.length > 0) {
    console.log(`    Score:        ${(aligned / btConfirmed.length * 100).toFixed(0)}%`);
  }
  if (missedGoodCount > 0) console.log(`    ⚠ Missed GOOD: ${missedGoodCount} (potential lost profit)`);
  if (avoidedBadCount > 0) console.log(`    ✅ Avoided BAD:  ${avoidedBadCount} (AI was smarter)`);
  console.log(`    Live-only:    ${unmatchedLive.length} entries not in backtest\n`);

  // Confidence gap analysis
  const confGaps: { label: string; live: number; bt: number; diff: number }[] = [];
  for (const bt of allBtEntries) {
    const btMin = etToMinutes(bt.timeET);
    for (const ld of liveEntries) {
      if (!ld.direction || ld.direction !== bt.direction) continue;
      const ldMin = etToMinutes(utcToET(ld.created_at));
      if (Math.abs(ldMin - btMin) <= 3) {
        const liveConf = ld.signal_confidence ?? ld.orchestration_confidence;
        confGaps.push({ label: `${bt.timeET} ${bt.direction}`, live: liveConf, bt: bt.confidence, diff: liveConf - bt.confidence });
        break;
      }
    }
  }
  if (confGaps.length > 0) {
    const avgGap = confGaps.reduce((a, b) => a + b.diff, 0) / confGaps.length;
    console.log(`  Confidence gaps (live - backtest):`);
    for (const g of confGaps) {
      const arrow = g.diff > 0.02 ? '↑' : g.diff < -0.02 ? '↓' : '≈';
      console.log(`    ${g.label.padEnd(20)} live ${fmtPct(g.live).padStart(6)} vs bt ${fmtPct(g.bt).padStart(6)} → ${arrow} ${g.diff >= 0 ? '+' : ''}${fmtPct(g.diff)}`);
    }
    console.log(`    Average gap: ${avgGap >= 0 ? '+' : ''}${fmtPct(avgGap)}`);
    console.log(`    (positive = live more confident, negative = backtest more confident)\n`);
  }

  // Mode agreement
  const modeMatches: { time: string; liveMode: string; btMode: string; match: boolean }[] = [];
  for (const bt of allBtEntries) {
    const btMin = etToMinutes(bt.timeET);
    for (const ld of liveEntries) {
      if (!ld.direction || ld.direction !== bt.direction) continue;
      const ldMin = etToMinutes(utcToET(ld.created_at));
      if (Math.abs(ldMin - btMin) <= 3 && ld.signal_mode) {
        modeMatches.push({ time: bt.timeET, liveMode: ld.signal_mode, btMode: bt.mode, match: ld.signal_mode === bt.mode });
        break;
      }
    }
  }
  if (modeMatches.length > 0) {
    const modeAgree = modeMatches.filter(m => m.match).length;
    console.log(`  Signal mode agreement: ${modeAgree}/${modeMatches.length}`);
    const divergent = modeMatches.filter(m => !m.match);
    if (divergent.length > 0) {
      for (const d of divergent) {
        console.log(`    ⚠ ${d.time} ET: live=${d.liveMode} vs backtest=${d.btMode}`);
      }
    }
    console.log('');
  }

  // Tuning recommendations
  console.log(`  ${'─'.repeat(96)}`);
  console.log(`  TUNING INSIGHTS`);
  console.log(`  ${'─'.repeat(96)}\n`);

  if (missedGoodCount > 0) {
    console.log(`  📊 ${missedGoodCount} good entries missed by live system. Check:`);
    console.log(`     • Is AI orchestrator too cautious? (streak/drawdown context making it wait)`);
    console.log(`     • Are streaming bar values producing lower indicator readings?`);
    console.log(`     • Are real option spreads/liquidity filtering out entries?\n`);
  }
  if (avoidedBadCount > 0) {
    console.log(`  ✅ ${avoidedBadCount} bad entries avoided by live system — AI is adding value here.\n`);
  }
  if (unmatchedLive.length > 0) {
    console.log(`  🔍 ${unmatchedLive.length} live-only entries (no backtest match). Check:`);
    console.log(`     • Are streaming bars triggering at different times than REST bars?`);
    console.log(`     • Is AI creating entries from context not visible to backtest?\n`);
  }

  const bigGaps = confGaps.filter(g => Math.abs(g.diff) >= 0.05);
  if (bigGaps.length > 0) {
    console.log(`  ⚡ ${bigGaps.length} entries with >5% confidence gap. Root causes to investigate:`);
    console.log(`     • Bar data differences (streaming cache vs REST fetch)`);
    console.log(`     • OBV/VWAP computed on different bar counts`);
    console.log(`     • AI orchestrator adjustments (check raw_claude_response in DB)\n`);
  }

  const divergentModes = modeMatches.filter(m => !m.match);
  if (divergentModes.length > 0) {
    console.log(`  🔀 ${divergentModes.length} mode mismatches. Mode detection is sensitive to:`);
    console.log(`     • Price structure (swing highs/lows computed from different bar windows)`);
    console.log(`     • VWAP deviation calculation (depends on bar count)`);
    console.log(`     • Range position boundaries\n`);
  }

  console.log(`${'═'.repeat(100)}\n`);
}

main().catch(err => {
  console.error('Compare failed:', err);
  process.exit(1);
});
