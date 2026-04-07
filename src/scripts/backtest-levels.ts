#!/usr/bin/env npx tsx
/**
 * backtest-levels.ts — Replay a historical trading day through the level-based
 * signal + analysis pipeline.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-levels.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: 2026-04-06, SPY
 *
 * Fetches 1m bars from Alpaca, walks through market hours in 1-minute intervals,
 * runs the level engine + structure tracker + market context + level interaction
 * at each step. Reports all level interactions and generated setups.
 */

import 'dotenv/config';
import { config } from '../config.js';
import { normalizeAlpacaBars } from '../types/market.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import type { LevelSetup, LevelInteraction, PriceLevel, MarketContext, StructureAnalysis } from '../types/levels.js';
import { computeVolumeProfile } from '../levels/volume-profile.js';
import { computeLevels } from '../levels/level-engine.js';
import { LevelCache } from '../levels/level-cache.js';
import { detectSwingPoints } from '../structure/swing-detector.js';
import { analyzeStructure } from '../structure/structure-tracker.js';
import { computeMarketContext } from '../context/market-context.js';
import { detectLevelInteraction, generateSetup } from '../levels/level-interaction.js';
import { computeATR } from '../indicators/atr.js';
import { computeVWAP } from '../indicators/vwap.js';
import { computePriorDayLevels, computeORB } from '../indicators/market-structure.js';
import { computeLevelConfidence } from '../agents/level-analysis-agent.js';
import type { SignalPayload } from '../types/signal.js';
import type { LevelSignalData } from '../types/levels.js';

// ── Config ────────────────────────────────────────────────────────────────────

const TARGET_DATE = process.argv.filter(a => !a.startsWith('--'))[2] || '2026-04-06';
const TICKER = process.argv.filter(a => !a.startsWith('--'))[3] || 'SPY';
const MIN_CONFIDENCE = 0.65;

const MARKET_OPEN_UTC = '13:30';
const MARKET_CLOSE_UTC = '20:00';

// ── Alpaca REST helpers ───────────────────────────────────────────────────────

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string,
  timeframe: Timeframe,
  start: string,
  end: string,
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const allBars: OHLCVBar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF[timeframe]);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    allBars.push(...normalizeAlpacaBars(data));
    if (data.next_page_token) { pageToken = data.next_page_token; } else { break; }
  }
  return allBars;
}

function filterRegularSession(bars: OHLCVBar[]): OHLCVBar[] {
  return bars.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(b.timestamp));
    const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
}

function toET(utcTimestamp: string): string {
  const d = new Date(utcTimestamp);
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
}

// ── MFE/MAE computation ──────────────────────────────────────────────────────

interface TradeOutcome {
  direction: 'bullish' | 'bearish';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  mfePct: number;
  maePct: number;
  hitTarget: boolean;
  hitStop: boolean;
  exitPrice: number;
  exitReason: 'target' | 'stop' | 'close';
  holdBars: number;
}

function simulateTrade(
  direction: 'bullish' | 'bearish',
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
  futureBars: OHLCVBar[],
  maxBars = 120,
): TradeOutcome {
  let mfe = 0;
  let mae = 0;
  let exitPrice = entryPrice;
  let exitReason: TradeOutcome['exitReason'] = 'close';
  let holdBars = 0;

  const barsToCheck = futureBars.slice(0, maxBars);

  for (let i = 0; i < barsToCheck.length; i++) {
    const bar = barsToCheck[i]!;
    holdBars = i + 1;

    if (direction === 'bullish') {
      const favorable = (bar.high - entryPrice) / entryPrice * 100;
      const adverse = (entryPrice - bar.low) / entryPrice * 100;
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);

      if (bar.low <= stopPrice) {
        exitPrice = stopPrice;
        exitReason = 'stop';
        break;
      }
      if (bar.high >= targetPrice) {
        exitPrice = targetPrice;
        exitReason = 'target';
        break;
      }
    } else {
      const favorable = (entryPrice - bar.low) / entryPrice * 100;
      const adverse = (bar.high - entryPrice) / entryPrice * 100;
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);

      if (bar.high >= stopPrice) {
        exitPrice = stopPrice;
        exitReason = 'stop';
        break;
      }
      if (bar.low <= targetPrice) {
        exitPrice = targetPrice;
        exitReason = 'target';
        break;
      }
    }

    exitPrice = bar.close;
  }

  return {
    direction, entryPrice, stopPrice, targetPrice,
    mfePct: mfe, maePct: mae,
    hitTarget: exitReason === 'target',
    hitStop: exitReason === 'stop',
    exitPrice,
    exitReason,
    holdBars,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface SetupRecord {
  time: string;
  timeET: string;
  setup: LevelSetup;
  confidence: number;
  meetsThreshold: boolean;
  outcome?: TradeOutcome;
}

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  LEVEL BACKTEST: ${TICKER} on ${TARGET_DATE} (Threshold: ${MIN_CONFIDENCE})`);
  console.log(`  Walking market hours ${MARKET_OPEN_UTC}–${MARKET_CLOSE_UTC} UTC in 1-min intervals`);
  console.log(`${'='.repeat(80)}\n`);

  // ── Fetch data ────────────────────────────────────────────────────────────
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 30); // 30 days for weekly/monthly levels
  const startStr = warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const endStr = TARGET_DATE + 'T23:59:59Z';

  console.log(`Fetching 1m bars...`);
  const allOneMinRaw = await fetchBarsRange(TICKER, '1m',
    new Date(new Date(TARGET_DATE).getTime() - 4 * 24 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00Z',
    endStr);
  const allOneMin = filterRegularSession(allOneMinRaw);
  console.log(`  → ${allOneMinRaw.length} raw, ${allOneMin.length} regular-session`);

  console.log(`Fetching daily bars...`);
  const dailyBars = await fetchBarsRange(TICKER, '1d', startStr, endStr);
  console.log(`  → ${dailyBars.length} daily bars`);

  const targetDateBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  if (targetDateBars.length === 0) {
    console.error(`No bars found for ${TARGET_DATE}`);
    process.exit(1);
  }

  const dayHigh = Math.max(...targetDateBars.map(b => b.high));
  const dayLow = Math.min(...targetDateBars.map(b => b.low));
  const dayOpen = targetDateBars[0]!.open;
  const dayClose = targetDateBars[targetDateBars.length - 1]!.close;
  console.log(`\n  Day: $${dayLow.toFixed(2)} – $${dayHigh.toFixed(2)} (O: $${dayOpen.toFixed(2)}, C: $${dayClose.toFixed(2)}, ${((dayClose - dayOpen) / dayOpen * 100).toFixed(2)}%)\n`);

  // Compute average daily ATR for context
  const avgDailyATRPct = dailyBars.length >= 3
    ? dailyBars.slice(-5).reduce((s, b) => s + (b.high - b.low) / b.close * 100, 0) / Math.min(5, dailyBars.length)
    : 1.0;

  // ── Walk market hours ─────────────────────────────────────────────────────
  const levelCache = new LevelCache();
  const setups: SetupRecord[] = [];
  const allTicks: { time: string; timeET: string; price: number; interaction: string; level: string; setupType: string; confidence: number; structure: string; dayType: string }[] = [];

  // Setup dedup: no repeat setup at same level within 15 min
  const DEDUP_COOLDOWN_MS = 15 * 60_000;
  const recentSetupKeys = new Map<string, number>(); // key → simulated timestamp

  const openTime = new Date(`${TARGET_DATE}T${MARKET_OPEN_UTC}:00Z`);
  const closeTime = new Date(`${TARGET_DATE}T${MARKET_CLOSE_UTC}:00Z`);

  let tickCount = 0;

  for (let t = openTime.getTime(); t <= closeTime.getTime(); t += 60_000) {
    const tickTs = new Date(t).toISOString();
    const timeET = toET(tickTs);

    // Build bars up to this point
    const barsUpToNow = allOneMin.filter(b => new Date(b.timestamp).getTime() <= t);
    const todayBarsUpToNow = barsUpToNow.filter(b => b.timestamp.startsWith(TARGET_DATE));

    if (todayBarsUpToNow.length < 5) continue;

    const currentPrice = todayBarsUpToNow[todayBarsUpToNow.length - 1]!.close;
    tickCount++;

    // ATR from recent bars
    const atrResult = computeATR(barsUpToNow.slice(-100), 14, true);
    const atr = atrResult.atr || currentPrice * 0.005;

    // Compute levels
    const vwapResult = computeVWAP(todayBarsUpToNow);
    const orbResult = computeORB(todayBarsUpToNow, currentPrice);
    const volumeProfile = computeVolumeProfile(todayBarsUpToNow);

    const swingPoints = detectSwingPoints(todayBarsUpToNow, 3, 2, 20);
    const swingHighs = swingPoints.filter(s => s.type === 'high').map(s => s.price);
    const swingLows = swingPoints.filter(s => s.type === 'low').map(s => s.price);

    const levelOutput = computeLevels({
      dailyBars,
      todayBars1m: todayBarsUpToNow,
      currentPrice,
      vwapResult,
      orbResult,
      volumeProfile,
      swingHighs,
      swingLows,
    });

    const trackedLevels = levelCache.updateLevels(levelOutput.allLevels, currentPrice, atr);

    // Structure
    const structure = analyzeStructure(todayBarsUpToNow, trackedLevels, atr);

    // Context
    const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
    const context = computeMarketContext(todayBarsUpToNow, priorDayLevels.pdc, avgDailyATRPct, orbResult);

    // Level interaction
    const recentBars = todayBarsUpToNow.slice(-20);
    const interaction = detectLevelInteraction(recentBars, trackedLevels, atr);

    // Setup generation
    let setup: LevelSetup | null = null;
    let confidence = 0;
    let meetsThreshold = false;

    if (interaction) {
      setup = generateSetup(
        interaction, structure, context,
        levelOutput.nearestAbove, levelOutput.nearestBelow,
        atr, currentPrice,
      );

      if (setup) {
        // Compute confidence
        const mockSignal = {
          levelData: { setup, structure, context, activeInteraction: interaction,
            allLevels: trackedLevels, nearestAbove: levelOutput.nearestAbove,
            nearestBelow: levelOutput.nearestBelow, volumeProfile },
          timeframes: [{ vwap: vwapResult }],
        } as any as SignalPayload & { levelData: LevelSignalData };

        const lcb = computeLevelConfidence(mockSignal);
        confidence = lcb.total;
        meetsThreshold = confidence >= MIN_CONFIDENCE;
      }
    }

    // Record tick
    allTicks.push({
      time: tickTs,
      timeET,
      price: currentPrice,
      interaction: interaction?.interaction ?? 'none',
      level: interaction?.level.label ?? '-',
      setupType: setup?.type ?? '-',
      confidence,
      structure: structure.state,
      dayType: context.dayType,
    });

    // Record setup (with dedup)
    if (setup && meetsThreshold) {
      const dedupKey = `${setup.level.type}:${setup.level.price.toFixed(1)}:${setup.direction}`;
      const lastSetupTs = recentSetupKeys.get(dedupKey);
      const isDup = lastSetupTs !== undefined && (t - lastSetupTs) < DEDUP_COOLDOWN_MS;

      if (!isDup) {
        recentSetupKeys.set(dedupKey, t);
        // Simulate trade outcome with future bars
        const futureBarIdx = targetDateBars.findIndex(b => new Date(b.timestamp).getTime() > t);
        const futureBars = futureBarIdx >= 0 ? targetDateBars.slice(futureBarIdx) : [];

        const outcome = futureBars.length > 0
          ? simulateTrade(setup.direction, currentPrice, setup.stopPrice, setup.targetPrice, futureBars)
          : undefined;

        setups.push({ time: tickTs, timeET, setup, confidence, meetsThreshold, outcome });
      }
    }

    // Progress
    if (tickCount % 30 === 0) {
      console.log(
        `  Processed ${tickCount} ticks (${timeET} ET, $${currentPrice.toFixed(2)}, ` +
        `struct=${structure.state}, day=${context.dayType}, ` +
        `levels=${trackedLevels.length}, ` +
        `interact=${interaction?.interaction ?? 'none'}${interaction ? ` at ${interaction.level.label}` : ''})`
      );
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  RESULTS: ${tickCount} ticks processed, ${setups.length} setups generated`);
  console.log(`${'='.repeat(80)}\n`);

  // Show levels computed at the end of day
  console.log(`  ── Price Levels (end of day) ──`);
  const finalLevels = levelCache.getLevels().sort((a, b) => b.price - a.price);
  for (const level of finalLevels) {
    const dist = ((level.price - dayClose) / dayClose * 100).toFixed(2);
    console.log(`    $${level.price.toFixed(2)} ${level.label.padEnd(25)} str=${level.strength} ${level.freshness.padEnd(7)} touches=${level.touchCount} (${dist}%)`);
  }

  // Show all setups with outcomes
  if (setups.length > 0) {
    console.log(`\n  ── Setups ──`);

    let wins = 0;
    let losses = 0;
    let totalPnL = 0;

    for (let i = 0; i < setups.length; i++) {
      const s = setups[i]!;
      const o = s.outcome;
      const dir = s.setup.direction === 'bullish' ? '▲' : '▼';
      const confPct = (s.confidence * 100).toFixed(0);

      console.log(`\n  Setup #${i + 1}: ${dir} ${s.setup.direction.toUpperCase()} | ${s.setup.type} | ${s.timeET} ET`);
      console.log(`    Level:      ${s.setup.level.label} ($${s.setup.level.price.toFixed(2)}, str=${s.setup.level.strength})`);
      console.log(`    Entry:      $${s.setup.entryPrice.toFixed(2)} | Stop: $${s.setup.stopPrice.toFixed(2)} | Target: $${s.setup.targetPrice.toFixed(2)}`);
      console.log(`    R:R:        ${s.setup.riskReward.toFixed(1)} | Confidence: ${confPct}%`);
      console.log(`    Structure:  ${s.setup.structure.state} | Day: ${s.setup.context.dayType}`);

      if (o) {
        const pnl = s.setup.direction === 'bullish'
          ? (o.exitPrice - o.entryPrice) / o.entryPrice * 100
          : (o.entryPrice - o.exitPrice) / o.entryPrice * 100;
        totalPnL += pnl;
        if (o.exitReason === 'target') wins++;
        else if (o.exitReason === 'stop') losses++;

        const emoji = o.exitReason === 'target' ? '🎯' : o.exitReason === 'stop' ? '🛑' : '🔔';
        console.log(`    Outcome:    ${emoji} ${o.exitReason.toUpperCase()} after ${o.holdBars}m | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
        console.log(`    MFE:        ${o.mfePct.toFixed(2)}% | MAE: ${o.maePct.toFixed(2)}%`);
      }
    }

    console.log(`\n  ── Summary ──`);
    console.log(`    Setups:     ${setups.length} (above ${(MIN_CONFIDENCE * 100).toFixed(0)}% threshold)`);
    console.log(`    Wins:       ${wins} (target hit)`);
    console.log(`    Losses:     ${losses} (stop hit)`);
    console.log(`    Held:       ${setups.length - wins - losses} (closed at EOD)`);
    console.log(`    Total P&L:  ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}% (underlying moves)`);
  } else {
    console.log(`\n  No setups met the ${(MIN_CONFIDENCE * 100).toFixed(0)}% confidence threshold.`);
  }

  // Timeline with interactions
  console.log(`\n  ── Price Timeline ──`);
  for (let i = 0; i < allTicks.length; i += 6) { // every 6 min
    const tick = allTicks[i]!;
    const bar = `$${tick.price.toFixed(2)}`;
    const confBar = tick.confidence > 0
      ? `[${'█'.repeat(Math.round(tick.confidence * 20))}${' '.repeat(20 - Math.round(tick.confidence * 20))}] ${(tick.confidence * 100).toFixed(0)}%`
      : '';
    const setupMark = setups.find(s => s.timeET === tick.timeET)
      ? ` ← SETUP`
      : '';
    const interactMark = tick.interaction !== 'none'
      ? ` ${tick.interaction}@${tick.level}`
      : '';

    console.log(`    ${tick.timeET} ${bar} ${tick.structure.padEnd(12)} ${tick.dayType.padEnd(14)}${interactMark}${confBar}${setupMark}`);
  }

  // ── Move scanner (same as existing backtest) ──────────────────────────────
  console.log(`\n  ── Significant Moves (MFE >= 0.3%) ──`);
  const moves = findSignificantMoves(targetDateBars, 0.003);
  let caught = 0;
  let missed = 0;
  for (const move of moves) {
    const matchingSetup = setups.find(s => {
      const setupTs = new Date(s.time).getTime();
      const moveStart = new Date(move.startBar.timestamp).getTime();
      const moveEnd = new Date(move.endBar.timestamp).getTime();
      return setupTs >= moveStart - 5 * 60_000 && setupTs <= moveEnd &&
             s.setup.direction === move.direction;
    });
    if (matchingSetup) {
      caught++;
      console.log(`    ✅ ${toET(move.startBar.timestamp)}→${toET(move.endBar.timestamp)} ${move.direction} MFE=${(move.mfePct * 100).toFixed(2)}% CAUGHT`);
    } else {
      missed++;
      console.log(`    ❌ ${toET(move.startBar.timestamp)}→${toET(move.endBar.timestamp)} ${move.direction} MFE=${(move.mfePct * 100).toFixed(2)}% MISSED`);
    }
  }
  console.log(`\n    Caught: ${caught}/${moves.length} | Missed: ${missed}/${moves.length}`);
}

// ── Move Detection ──────────────────────────────────────────────────────────

interface SignificantMove {
  startBar: OHLCVBar;
  endBar: OHLCVBar;
  direction: 'bullish' | 'bearish';
  mfePct: number;
  maePct: number;
}

function findSignificantMoves(bars: OHLCVBar[], minMFE: number): SignificantMove[] {
  const moves: SignificantMove[] = [];

  for (let i = 0; i < bars.length - 10; i += 5) {
    const startBar = bars[i]!;
    const startPrice = startBar.close;
    let maxUp = 0, maxDown = 0, maxUpMAE = 0, maxDownMAE = 0;
    let bestUpBar = startBar, bestDownBar = startBar;

    for (let j = i + 1; j < Math.min(i + 120, bars.length); j++) {
      const bar = bars[j]!;
      const upMove = (bar.high - startPrice) / startPrice;
      const downMove = (startPrice - bar.low) / startPrice;

      if (upMove > maxUp) {
        maxUp = upMove;
        bestUpBar = bar;
        maxUpMAE = 0;
        for (let k = i + 1; k <= j; k++) {
          const maeBar = bars[k]!;
          maxUpMAE = Math.max(maxUpMAE, (startPrice - maeBar.low) / startPrice);
        }
      }
      if (downMove > maxDown) {
        maxDown = downMove;
        bestDownBar = bar;
        maxDownMAE = 0;
        for (let k = i + 1; k <= j; k++) {
          const maeBar = bars[k]!;
          maxDownMAE = Math.max(maxDownMAE, (maeBar.high - startPrice) / startPrice);
        }
      }
    }

    if (maxUp >= minMFE && maxUp / (maxUpMAE || 0.001) > 1.2) {
      moves.push({ startBar, endBar: bestUpBar, direction: 'bullish', mfePct: maxUp, maePct: maxUpMAE });
    }
    if (maxDown >= minMFE && maxDown / (maxDownMAE || 0.001) > 1.2) {
      moves.push({ startBar, endBar: bestDownBar, direction: 'bearish', mfePct: maxDown, maePct: maxDownMAE });
    }
  }

  // Deduplicate overlapping moves (keep the one with higher MFE)
  const deduped: SignificantMove[] = [];
  for (const move of moves.sort((a, b) => b.mfePct - a.mfePct)) {
    const overlap = deduped.some(d =>
      d.direction === move.direction &&
      Math.abs(new Date(d.startBar.timestamp).getTime() - new Date(move.startBar.timestamp).getTime()) < 15 * 60_000
    );
    if (!overlap) deduped.push(move);
  }

  return deduped.sort((a, b) => new Date(a.startBar.timestamp).getTime() - new Date(b.startBar.timestamp).getTime());
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
