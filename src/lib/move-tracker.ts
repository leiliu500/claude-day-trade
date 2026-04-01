/**
 * move-tracker.ts — Live intraday move detection from the 1-min bar stream cache.
 *
 * Scans the current day's bars for significant directional moves (MFE >= 0.25%)
 * and tracks whether the trading system has detected them, including delay metrics.
 *
 * Used by:
 *  - Dashboard API (/api/market-moves) for real-time move panel
 *  - Scheduler tick for near-miss Telegram alerts
 */

import { AlpacaStreamManager } from './alpaca-stream.js';
import { getTickerConfig } from '../ticker-configs.js';
import type { OHLCVBar } from '../types/market.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DetectedMove {
  ticker: string;
  startIdx: number;
  startTime: string;
  startTimeET: string;
  startPrice: number;
  direction: 'bullish' | 'bearish';
  currentMfePct: number;    // max favorable excursion so far (%)
  currentMaePct: number;    // max adverse excursion so far (%)
  peakPrice: number;
  peakTime: string;
  peakTimeET: string;
  durationMinutes: number;  // minutes since move start
  active: boolean;          // still within move (not reverted)
}

export interface SignalTick {
  time: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  mode: string;
  ticker: string;
}

export type MissClassification =
  | 'CAUGHT'            // not a miss
  // Reasonable — system correctly avoided or cannot improve
  | 'FAST_REVERSAL'     // MFE/MAE < 2.0 or peak < 5 min — choppy, not tradeable
  | 'COUNTER_TREND'     // counter-move against a sustained system direction
  | 'NO_DATA'           // cache gap, insufficient bars
  // Tunable — system should improve here
  | 'NEAR_MISS'         // right dir + mode, confidence within 5% of threshold
  | 'FILTER_COST'       // blocked by filter on a good move
  | 'DELAY_COST'        // detected but delay ate >50% of MFE
  | 'WRONG_DIR_LATE'    // system pointed wrong dir for a sustained high-R move
  | 'LOW_CONF_GOOD';    // right dir, conf far below threshold, but high MFE

export interface MoveWithSignal extends DetectedMove {
  signalStatus: 'DETECTED' | 'WRONG_DIR' | 'LOW_CONF' | 'NO_SIGNAL' | 'FILTER_BLOCKED';
  matchingSignal: SignalTick | null;
  delayMinutes: number | null;     // minutes from move start to first matching signal
  entryCostPct: number | null;     // % price already moved by signal time
  remainingMfePct: number | null;  // MFE from signal time forward
  captureRatio: number | null;     // remainingMfe / fullMfe
  // Miss classification
  classification: MissClassification;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  actionHint: string;
}

export interface NearMissAlert {
  ticker: string;
  time: string;
  timeET: string;
  direction: 'bullish' | 'bearish';
  confidence: number;
  threshold: number;
  gap: number;             // threshold - confidence (positive = below threshold)
  mode: string;
  moveMfePct: number;      // MFE of the underlying move
  filterRule?: string;     // if blocked by filter rather than confidence
}

export interface DelaySummary {
  ticker: string;
  totalMoves: number;
  detected: number;
  missed: number;
  avgDelayMinutes: number;
  medianDelayMinutes: number;
  avgCaptureRatio: number;
  movesOverHalfLost: number;  // moves where capture < 50%
}

// ── In-memory signal log (populated by scheduler/pipeline each tick) ─────────

const recentSignals: SignalTick[] = [];
const MAX_SIGNAL_LOG = 2000;

const recentNearMisses: NearMissAlert[] = [];
const MAX_NEAR_MISSES = 100;

const recentFilterBlocks: NearMissAlert[] = [];
const MAX_FILTER_BLOCKS = 100;

/**
 * Record a signal tick from the trading pipeline.
 * Called from scheduler.ts after each pipeline run.
 */
export function recordSignalTick(tick: SignalTick): void {
  recentSignals.push(tick);
  if (recentSignals.length > MAX_SIGNAL_LOG) {
    recentSignals.splice(0, recentSignals.length - MAX_SIGNAL_LOG);
  }
}

/**
 * Record a near-miss alert (confidence within threshold gap).
 * Called from scheduler.ts when a signal narrowly misses.
 */
export function recordNearMiss(alert: NearMissAlert): void {
  // Deduplicate: don't record same ticker+direction within 3 minutes
  const cutoff = Date.now() - 3 * 60_000;
  const dup = recentNearMisses.find(n =>
    n.ticker === alert.ticker &&
    n.direction === alert.direction &&
    new Date(n.time).getTime() > cutoff
  );
  if (!dup) {
    recentNearMisses.push(alert);
    if (recentNearMisses.length > MAX_NEAR_MISSES) {
      recentNearMisses.splice(0, recentNearMisses.length - MAX_NEAR_MISSES);
    }
  }
}

/**
 * Record a filter-blocked entry.
 * Called from scheduler.ts when an entry passes confidence but is filter-blocked.
 */
export function recordFilterBlock(alert: NearMissAlert): void {
  const cutoff = Date.now() - 3 * 60_000;
  const dup = recentFilterBlocks.find(n =>
    n.ticker === alert.ticker &&
    n.direction === alert.direction &&
    new Date(n.time).getTime() > cutoff
  );
  if (!dup) {
    recentFilterBlocks.push(alert);
    if (recentFilterBlocks.length > MAX_FILTER_BLOCKS) {
      recentFilterBlocks.splice(0, recentFilterBlocks.length - MAX_FILTER_BLOCKS);
    }
  }
}

export function getRecentNearMisses(): NearMissAlert[] {
  return [...recentNearMisses];
}

export function getRecentFilterBlocks(): NearMissAlert[] {
  return [...recentFilterBlocks];
}

/** Clear all state (called at start of each trading day). */
export function resetDailyState(): void {
  recentSignals.length = 0;
  recentNearMisses.length = 0;
  recentFilterBlocks.length = 0;
}

// ── UTC to ET helper ──────────────────────────────────────────────────────────

function utcToET(utcTime: string): string {
  const d = new Date(utcTime);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'America/New_York',
  });
}

// ── Core: detect moves from 1-min bars ────────────────────────────────────────

const MIN_MFE_PCT = 0.25; // lower than backtest (0.30) for earlier detection
const DEDUP_WINDOW_MS = 10 * 60_000;

/**
 * Scan the current day's 1-min bars for significant directional moves.
 * Returns deduplicated moves with signal matching + delay metrics.
 */
export function detectLiveMoves(ticker: string): MoveWithSignal[] {
  const stream = AlpacaStreamManager.getInstance();
  const bars = stream.getBars(ticker, '1m', 30);
  if (!bars || bars.length < 30) return [];

  // Filter to today only (ET date)
  const todayET = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const todayBars = bars.filter(b => {
    const barDateET = new Date(b.timestamp).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    return barDateET === todayET;
  });
  if (todayBars.length < 20) return [];

  // Skip first 15 minutes (open noise)
  const scanStart = Math.min(15, Math.floor(todayBars.length * 0.1));
  const moves: DetectedMove[] = [];

  for (let i = scanStart; i < todayBars.length; i++) {
    const bar = todayBars[i]!;
    const entryPrice = bar.close;
    const entryTs = new Date(bar.timestamp).getTime();

    let bullMfe = 0, bullMae = 0, bullPeakPrice = entryPrice, bullPeakTs = bar.timestamp;
    let bearMfe = 0, bearMae = 0, bearPeakPrice = entryPrice, bearPeakTs = bar.timestamp;

    for (let j = i + 1; j < todayBars.length; j++) {
      const fb = todayBars[j]!;
      const bullFav = fb.high - entryPrice;
      const bullAdv = entryPrice - fb.low;
      if (bullFav > bullMfe) { bullMfe = bullFav; bullPeakPrice = fb.high; bullPeakTs = fb.timestamp; }
      if (bullAdv > bullMae) bullMae = bullAdv;

      const bearFav = entryPrice - fb.low;
      const bearAdv = fb.high - entryPrice;
      if (bearFav > bearMfe) { bearMfe = bearFav; bearPeakPrice = fb.low; bearPeakTs = fb.timestamp; }
      if (bearAdv > bearMae) bearMae = bearAdv;
    }

    const bullMfePct = (bullMfe / entryPrice) * 100;
    const bearMfePct = (bearMfe / entryPrice) * 100;
    const bullMaePct = (bullMae / entryPrice) * 100;
    const bearMaePct = (bearMae / entryPrice) * 100;

    const bestDir = bullMfePct >= bearMfePct ? 'bullish' as const : 'bearish' as const;
    const mfePct = bestDir === 'bullish' ? bullMfePct : bearMfePct;
    const maePct = bestDir === 'bullish' ? bullMaePct : bearMaePct;
    const peakPrice = bestDir === 'bullish' ? bullPeakPrice : bearPeakPrice;
    const peakTs = bestDir === 'bullish' ? bullPeakTs : bearPeakTs;

    if (mfePct >= MIN_MFE_PCT && (maePct < 0.01 || mfePct / maePct > 1.2)) {
      const durationMin = Math.round((Date.now() - entryTs) / 60_000);
      // Check if move is still active (price hasn't reverted past MAE * 2)
      const lastBar = todayBars[todayBars.length - 1]!;
      const lastPrice = lastBar.close;
      const reversion = bestDir === 'bullish'
        ? (entryPrice - lastPrice) / entryPrice * 100
        : (lastPrice - entryPrice) / entryPrice * 100;
      const active = reversion < mfePct * 0.5; // still active if hasn't given back >50%

      moves.push({
        ticker,
        startIdx: i,
        startTime: bar.timestamp,
        startTimeET: utcToET(bar.timestamp),
        startPrice: entryPrice,
        direction: bestDir,
        currentMfePct: mfePct,
        currentMaePct: maePct,
        peakPrice,
        peakTime: peakTs,
        peakTimeET: utcToET(peakTs),
        durationMinutes: durationMin,
        active,
      });
    }
  }

  // Deduplicate: within 10-min windows of same direction, keep best MFE
  const deduped: DetectedMove[] = [];
  for (const mv of moves) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.direction === mv.direction) {
      const prevTs = new Date(prev.startTime).getTime();
      const currTs = new Date(mv.startTime).getTime();
      if (currTs - prevTs < DEDUP_WINDOW_MS) {
        if (mv.currentMfePct > prev.currentMfePct) deduped[deduped.length - 1] = mv;
        continue;
      }
    }
    deduped.push(mv);
  }

  // Match each move against recorded signals
  return deduped.map(mv => matchMoveToSignal(mv, todayBars));
}

function matchMoveToSignal(mv: DetectedMove, bars: OHLCVBar[]): MoveWithSignal {
  const mvStartTs = new Date(mv.startTime).getTime();
  const searchEndTs = new Date(mv.peakTime).getTime() + 30 * 60_000;
  const tickerSignals = recentSignals.filter(s => s.ticker === mv.ticker);
  const threshold = getTickerConfig(mv.ticker).minConfidence;
  const mfeOverMae = mv.currentMaePct > 0.01 ? mv.currentMfePct / mv.currentMaePct : 999;

  // Compute peak minutes (time from start to peak)
  const peakMinutes = Math.round((new Date(mv.peakTime).getTime() - mvStartTs) / 60_000);

  // Find first signal tick with matching direction + mode + confidence >= threshold
  let firstMatch: SignalTick | null = null;
  for (const s of tickerSignals) {
    const sTs = new Date(s.time).getTime();
    if (sTs < mvStartTs) continue;
    if (sTs > searchEndTs) break;
    if (s.direction === mv.direction && s.mode !== 'none' && s.confidence >= threshold) {
      firstMatch = s;
      break;
    }
  }

  // Find nearest tick for classification context
  const nearTick = tickerSignals.find(s => {
    const sTs = new Date(s.time).getTime();
    return Math.abs(sTs - mvStartTs) <= 5 * 60_000;
  });

  // Count how many surrounding ticks pointed opposite direction (for counter-trend check)
  const surroundingTicks = tickerSignals.filter(s => {
    const sTs = new Date(s.time).getTime();
    return sTs >= mvStartTs && sTs <= new Date(mv.peakTime).getTime();
  });
  const oppositeCount = surroundingTicks.filter(s => s.direction !== mv.direction && s.direction !== 'neutral').length;

  // Base result for missed moves
  const baseMissed = {
    matchingSignal: nearTick ?? null,
    delayMinutes: null as number | null,
    entryCostPct: null as number | null,
    remainingMfePct: null as number | null,
    captureRatio: null as number | null,
  };

  if (!firstMatch) {
    // Determine signal status
    let signalStatus: MoveWithSignal['signalStatus'];
    if (!nearTick || nearTick.direction === 'neutral') signalStatus = 'NO_SIGNAL';
    else if (nearTick.direction !== mv.direction) signalStatus = 'WRONG_DIR';
    else signalStatus = 'LOW_CONF';

    // ── Classify the miss ──────────────────────────────────────────────────

    // Fast reversal / choppy
    if (mfeOverMae < 2.0 || (peakMinutes <= 3 && mv.currentMfePct < 0.40)) {
      return { ...mv, ...baseMissed, signalStatus, classification: 'FAST_REVERSAL', priority: 'LOW',
        actionHint: `R=${mfeOverMae.toFixed(1)}, peak@${peakMinutes}m — too choppy for clean entry.` };
    }

    // No data / cache gap
    if (signalStatus === 'NO_SIGNAL' && !nearTick) {
      return { ...mv, ...baseMissed, signalStatus, classification: 'NO_DATA', priority: 'LOW',
        actionHint: 'Cache gap — insufficient bars for indicator computation.' };
    }

    // Counter-trend: short-lived move against sustained system direction
    if (signalStatus === 'WRONG_DIR' && peakMinutes <= 20 && mv.currentMfePct < 0.50 &&
        oppositeCount > surroundingTicks.length * 0.7) {
      return { ...mv, ...baseMissed, signalStatus, classification: 'COUNTER_TREND', priority: 'LOW',
        actionHint: `System held ${nearTick?.direction} (${oppositeCount}/${surroundingTicks.length} ticks) — counter-move.` };
    }

    // Check for filter blocks
    const recentFb = recentFilterBlocks.find(fb =>
      fb.ticker === mv.ticker && fb.direction === mv.direction &&
      Math.abs(new Date(fb.time).getTime() - mvStartTs) <= 5 * 60_000
    );
    if (recentFb) {
      return { ...mv, ...baseMissed, signalStatus: 'FILTER_BLOCKED', classification: 'FILTER_COST',
        priority: mv.currentMfePct >= 0.40 ? 'HIGH' : 'MEDIUM',
        actionHint: `Blocked by "${recentFb.filterRule}" on ${mv.currentMfePct.toFixed(2)}% move — review filter.` };
    }

    // Near-miss threshold
    if (signalStatus === 'LOW_CONF' && nearTick) {
      const gap = threshold - nearTick.confidence;
      if (gap <= 0.05 && gap > 0) {
        return { ...mv, ...baseMissed, signalStatus, classification: 'NEAR_MISS',
          priority: mv.currentMfePct >= 0.50 ? 'HIGH' : 'MEDIUM',
          actionHint: `Conf ${(nearTick.confidence * 100).toFixed(0)}% — ${(gap * 100).toFixed(1)}% below ${(threshold * 100).toFixed(0)}%.` };
      }
    }

    // Wrong direction on sustained high-R move
    if (signalStatus === 'WRONG_DIR' && peakMinutes > 15 && mfeOverMae >= 3.0) {
      return { ...mv, ...baseMissed, signalStatus, classification: 'WRONG_DIR_LATE',
        priority: mv.currentMfePct >= 0.60 ? 'HIGH' : 'MEDIUM',
        actionHint: `System was ${nearTick?.direction} while ${mv.direction} ran ${peakMinutes}m (R=${mfeOverMae.toFixed(1)}).` };
    }

    // Right direction but low confidence on good move
    if (nearTick?.direction === mv.direction && mv.currentMfePct >= 0.40) {
      return { ...mv, ...baseMissed, signalStatus, classification: 'LOW_CONF_GOOD',
        priority: mv.currentMfePct >= 0.60 ? 'HIGH' : 'MEDIUM',
        actionHint: `Right dir, conf=${(nearTick.confidence * 100).toFixed(0)}% on ${mv.currentMfePct.toFixed(2)}% move.` };
    }

    // Default: counter-trend or low priority
    if (signalStatus === 'WRONG_DIR') {
      return { ...mv, ...baseMissed, signalStatus, classification: 'COUNTER_TREND', priority: 'LOW',
        actionHint: `System was ${nearTick?.direction}.` };
    }
    return { ...mv, ...baseMissed, signalStatus, classification: 'LOW_CONF_GOOD', priority: 'LOW',
      actionHint: `Conf=${((nearTick?.confidence ?? 0) * 100).toFixed(0)}%, mode=${nearTick?.mode ?? 'unknown'}` };
  }

  // ── Detected: compute delay metrics ────────────────────────────────────────
  const signalTs = new Date(firstMatch.time).getTime();
  const delayMin = Math.round((signalTs - mvStartTs) / 60_000);

  let signalPrice = mv.startPrice;
  for (const b of bars) {
    if (new Date(b.timestamp).getTime() >= signalTs) { signalPrice = b.close; break; }
  }

  const entryCostPct = Math.abs(signalPrice - mv.startPrice) / mv.startPrice * 100;
  let remainingMfe = 0;
  let pastSignal = false;
  for (const b of bars) {
    if (new Date(b.timestamp).getTime() >= signalTs) pastSignal = true;
    if (!pastSignal) continue;
    const fav = mv.direction === 'bullish' ? b.high - signalPrice : signalPrice - b.low;
    if (fav > remainingMfe) remainingMfe = fav;
  }
  const remainingMfePct = (remainingMfe / signalPrice) * 100;
  const captureRatio = mv.currentMfePct > 0.01 ? remainingMfePct / mv.currentMfePct : 0;

  // Classify detected moves — check if delay cost too much
  let classification: MissClassification = 'CAUGHT';
  let priority: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  let actionHint = '';
  if (captureRatio < 0.50) {
    classification = 'DELAY_COST';
    priority = mv.currentMfePct >= 0.50 ? 'HIGH' : 'MEDIUM';
    actionHint = `Delay ${delayMin}m ate ${(100 - captureRatio * 100).toFixed(0)}% of MFE.`;
  }

  return {
    ...mv, signalStatus: 'DETECTED', matchingSignal: firstMatch,
    delayMinutes: delayMin, entryCostPct, remainingMfePct, captureRatio,
    classification, priority, actionHint,
  };
}

/**
 * Compute delay summary for a ticker.
 */
export function computeDelaySummary(ticker: string): DelaySummary | null {
  const moves = detectLiveMoves(ticker);
  if (moves.length === 0) return null;

  const detected = moves.filter(m => m.signalStatus === 'DETECTED');
  const missed = moves.filter(m => m.signalStatus !== 'DETECTED');
  const delays = detected.map(m => m.delayMinutes ?? 0);
  const avgDelay = delays.length > 0 ? delays.reduce((s, d) => s + d, 0) / delays.length : 0;
  const sorted = [...delays].sort((a, b) => a - b);
  const medianDelay = sorted.length > 0
    ? sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    : 0;
  const avgCapture = detected.length > 0
    ? detected.reduce((s, m) => s + (m.captureRatio ?? 0), 0) / detected.length
    : 0;
  const overHalfLost = detected.filter(m => (m.captureRatio ?? 0) < 0.50).length;

  return {
    ticker,
    totalMoves: moves.length,
    detected: detected.length,
    missed: missed.length,
    avgDelayMinutes: Math.round(avgDelay * 10) / 10,
    medianDelayMinutes: medianDelay,
    avgCaptureRatio: Math.round(avgCapture * 1000) / 1000,
    movesOverHalfLost: overHalfLost,
  };
}
