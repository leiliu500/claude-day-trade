#!/usr/bin/env npx tsx
/**
 * backtest-levels-range.ts — Run level-based backtest across a date range.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-levels-range.ts 2025-10-01 2026-04-06 SPY
 *   Defaults: 2025-10-01 → 2026-04-06, SPY
 *
 * Walks each trading day, runs the level engine + structure + context + interaction
 * pipeline, and aggregates win/loss/move capture across all days.
 */

import 'dotenv/config';
import { config } from '../config.js';
import { normalizeAlpacaBars } from '../types/market.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import type { LevelSetup } from '../types/levels.js';
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

const START_DATE = process.argv[2] || '2025-10-01';
const END_DATE = process.argv[3] || '2026-04-06';
const TICKER = process.argv[4] || 'SPY';
const MIN_CONFIDENCE = 0.65;
const DEDUP_COOLDOWN_MS = 15 * 60_000;
const MAX_SETUPS_PER_DAY = 6;

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

// ── Alpaca ────────────────────────────────────────────────────────────────────

const headers = {
  'APCA-API-KEY-ID': config.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
};

async function fetchBarsRange(
  ticker: string, timeframe: Timeframe, start: string, end: string,
): Promise<OHLCVBar[]> {
  const allBars: OHLCVBar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF[timeframe]);
    url.searchParams.set('start', start); url.searchParams.set('end', end);
    url.searchParams.set('limit', '10000'); url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca error ${res.status}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    allBars.push(...normalizeAlpacaBars(data));
    if (data.next_page_token) pageToken = data.next_page_token; else break;
  }
  return allBars;
}

function filterRegularSession(bars: OHLCVBar[]): OHLCVBar[] {
  return bars.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(b.timestamp));
    const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = h * 60 + m;
    return mins >= 570 && mins < 960; // 9:30-16:00
  });
}

function toET(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
}

// ── Trade Simulation ─────────────────────────────────────────────────────────

interface TradeResult {
  direction: 'bullish' | 'bearish';
  entryPrice: number;
  exitReason: 'target' | 'stop' | 'close';
  pnlPct: number;
  mfePct: number;
  maePct: number;
  holdBars: number;
}

function simulateTrade(
  dir: 'bullish' | 'bearish', entry: number, stop: number, target: number,
  futureBars: OHLCVBar[], maxBars = 120,
): TradeResult {
  let mfe = 0, mae = 0, exitPrice = entry, holdBars = 0;
  let exitReason: TradeResult['exitReason'] = 'close';

  for (let i = 0; i < Math.min(maxBars, futureBars.length); i++) {
    const bar = futureBars[i]!;
    holdBars = i + 1;
    if (dir === 'bullish') {
      mfe = Math.max(mfe, (bar.high - entry) / entry * 100);
      mae = Math.max(mae, (entry - bar.low) / entry * 100);
      if (bar.low <= stop) { exitPrice = stop; exitReason = 'stop'; break; }
      if (bar.high >= target) { exitPrice = target; exitReason = 'target'; break; }
    } else {
      mfe = Math.max(mfe, (entry - bar.low) / entry * 100);
      mae = Math.max(mae, (bar.high - entry) / entry * 100);
      if (bar.high >= stop) { exitPrice = stop; exitReason = 'stop'; break; }
      if (bar.low <= target) { exitPrice = target; exitReason = 'target'; break; }
    }
    exitPrice = bar.close;
  }
  const pnlPct = dir === 'bullish'
    ? (exitPrice - entry) / entry * 100
    : (entry - exitPrice) / entry * 100;
  return { direction: dir, entryPrice: entry, exitReason, pnlPct, mfePct: mfe, maePct: mae, holdBars };
}

// ── Single Day Backtest ──────────────────────────────────────────────────────

interface DayResult {
  date: string;
  dayChange: number;
  dayType: string;
  setups: number;
  wins: number;
  losses: number;
  held: number;
  pnl: number;
  movesCaught: number;
  movesTotal: number;
}

async function backtestDay(
  date: string,
  allOneMin: OHLCVBar[],
  dailyBars: OHLCVBar[],
): Promise<DayResult | null> {
  const targetBars = allOneMin.filter(b => b.timestamp.startsWith(date));
  if (targetBars.length < 30) return null;

  const dayOpen = targetBars[0]!.open;
  const dayClose = targetBars[targetBars.length - 1]!.close;
  const dayChange = (dayClose - dayOpen) / dayOpen * 100;

  const avgDailyATRPct = dailyBars.length >= 3
    ? dailyBars.filter(b => b.timestamp.slice(0, 10) <= date).slice(-5)
        .reduce((s, b) => s + (b.high - b.low) / b.close * 100, 0) / 5
    : 1.0;

  // Get bars up to and including this date for warmup
  const allBarsUpToDate = allOneMin.filter(b => b.timestamp.slice(0, 10) <= date);
  const dailyBarsUpToDate = dailyBars.filter(b => b.timestamp.slice(0, 10) <= date);

  const levelCache = new LevelCache();
  const recentSetupKeys = new Map<string, number>();
  const setupResults: TradeResult[] = [];
  let lastDayType = 'undetermined';

  const openTime = new Date(`${date}T13:30:00Z`).getTime();
  const closeTime = new Date(`${date}T20:00:00Z`).getTime();

  for (let t = openTime; t <= closeTime; t += 60_000) {
    const barsUpToNow = allBarsUpToDate.filter(b => new Date(b.timestamp).getTime() <= t);
    const todayBars = barsUpToNow.filter(b => b.timestamp.startsWith(date));
    if (todayBars.length < 5) continue;

    const currentPrice = todayBars[todayBars.length - 1]!.close;
    const atrResult = computeATR(barsUpToNow.slice(-100), 14, true);
    const atr = atrResult.atr || currentPrice * 0.005;

    const vwapResult = computeVWAP(todayBars);
    const orbResult = computeORB(todayBars, currentPrice);
    const volumeProfile = computeVolumeProfile(todayBars);
    const swingPoints = detectSwingPoints(todayBars, 3, 2, 20);

    const levelOutput = computeLevels({
      dailyBars: dailyBarsUpToDate,
      todayBars1m: todayBars,
      currentPrice,
      vwapResult, orbResult, volumeProfile,
      swingHighs: swingPoints.filter(s => s.type === 'high').map(s => s.price),
      swingLows: swingPoints.filter(s => s.type === 'low').map(s => s.price),
    });

    const trackedLevels = levelCache.updateLevels(levelOutput.allLevels, currentPrice, atr);
    const structure = analyzeStructure(todayBars, trackedLevels, atr);
    const priorDayLevels = computePriorDayLevels(dailyBarsUpToDate, currentPrice);
    const context = computeMarketContext(todayBars, priorDayLevels.pdc, avgDailyATRPct, orbResult);
    lastDayType = context.dayType;

    const recentBars = todayBars.slice(-20);
    const interaction = detectLevelInteraction(recentBars, trackedLevels, atr);
    if (!interaction) continue;

    const setup = generateSetup(interaction, structure, context,
      levelOutput.nearestAbove, levelOutput.nearestBelow, atr, currentPrice);
    if (!setup) continue;

    // Confidence check
    const mockSignal = {
      levelData: { setup, structure, context, activeInteraction: interaction,
        allLevels: trackedLevels, nearestAbove: levelOutput.nearestAbove,
        nearestBelow: levelOutput.nearestBelow, volumeProfile },
      timeframes: [{ vwap: vwapResult }],
    } as any as SignalPayload & { levelData: LevelSignalData };
    const lcb = computeLevelConfidence(mockSignal);
    if (lcb.total < MIN_CONFIDENCE) continue;

    // Dedup
    const dedupKey = `${setup.level.type}:${setup.level.price.toFixed(1)}:${setup.direction}`;
    const lastTs = recentSetupKeys.get(dedupKey);
    if (lastTs && (t - lastTs) < DEDUP_COOLDOWN_MS) continue;
    recentSetupKeys.set(dedupKey, t);

    // Max setups per day
    if (setupResults.length >= MAX_SETUPS_PER_DAY) continue;

    // Simulate
    const futureIdx = targetBars.findIndex(b => new Date(b.timestamp).getTime() > t);
    if (futureIdx < 0) continue;
    const result = simulateTrade(setup.direction, currentPrice, setup.stopPrice, setup.targetPrice, targetBars.slice(futureIdx));
    setupResults.push(result);
  }

  const wins = setupResults.filter(r => r.exitReason === 'target').length;
  const losses = setupResults.filter(r => r.exitReason === 'stop').length;
  const held = setupResults.filter(r => r.exitReason === 'close').length;
  const pnl = setupResults.reduce((s, r) => s + r.pnlPct, 0);

  return {
    date, dayChange, dayType: lastDayType,
    setups: setupResults.length, wins, losses, held, pnl,
    movesCaught: 0, movesTotal: 0, // skip move scanner for speed
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  LEVEL RANGE BACKTEST: ${TICKER} from ${START_DATE} to ${END_DATE}`);
  console.log(`  Threshold: ${MIN_CONFIDENCE}, Dedup: ${DEDUP_COOLDOWN_MS / 60_000}min`);
  console.log(`${'='.repeat(80)}\n`);

  // Fetch ALL 1m bars for the entire range (with 5-day warmup)
  const warmup = new Date(START_DATE);
  warmup.setDate(warmup.getDate() - 7);
  console.log(`Fetching 1m bars ${warmup.toISOString().slice(0, 10)} → ${END_DATE}...`);
  const allOneMinRaw = await fetchBarsRange(TICKER, '1m', warmup.toISOString().slice(0, 10) + 'T00:00:00Z', END_DATE + 'T23:59:59Z');
  const allOneMin = filterRegularSession(allOneMinRaw);
  console.log(`  → ${allOneMinRaw.length} raw, ${allOneMin.length} regular-session bars`);

  console.log(`Fetching daily bars...`);
  const dailyBars = await fetchBarsRange(TICKER, '1d', warmup.toISOString().slice(0, 10) + 'T00:00:00Z', END_DATE + 'T23:59:59Z');
  console.log(`  → ${dailyBars.length} daily bars\n`);

  // Find all trading days in range
  const tradingDays = new Set<string>();
  for (const bar of allOneMin) {
    const d = bar.timestamp.slice(0, 10);
    if (d >= START_DATE && d <= END_DATE) tradingDays.add(d);
  }
  const sortedDays = [...tradingDays].sort();
  console.log(`  ${sortedDays.length} trading days found\n`);

  // Run each day
  const results: DayResult[] = [];
  let processed = 0;

  for (const date of sortedDays) {
    try {
      const result = await backtestDay(date, allOneMin, dailyBars);
      if (result) {
        results.push(result);
        const emoji = result.pnl >= 0 ? '✅' : '❌';
        const winRate = result.setups > 0 ? ((result.wins / result.setups) * 100).toFixed(0) : '-';
        console.log(
          `  ${emoji} ${date} | ${result.dayType.padEnd(12)} | ` +
          `${result.dayChange >= 0 ? '+' : ''}${result.dayChange.toFixed(2)}% | ` +
          `${result.setups} setups | ${result.wins}W/${result.losses}L/${result.held}H (${winRate}%) | ` +
          `P&L: ${result.pnl >= 0 ? '+' : ''}${result.pnl.toFixed(2)}%`
        );
      }
    } catch (err) {
      console.log(`  ⚠️  ${date} — error: ${(err as Error).message}`);
    }
    processed++;
    if (processed % 20 === 0) console.log(`  --- ${processed}/${sortedDays.length} days processed ---`);
  }

  // ── Aggregate Results ──────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  AGGREGATE RESULTS: ${TICKER} ${START_DATE} → ${END_DATE}`);
  console.log(`${'='.repeat(80)}\n`);

  const totalSetups = results.reduce((s, r) => s + r.setups, 0);
  const totalWins = results.reduce((s, r) => s + r.wins, 0);
  const totalLosses = results.reduce((s, r) => s + r.losses, 0);
  const totalHeld = results.reduce((s, r) => s + r.held, 0);
  const totalPnL = results.reduce((s, r) => s + r.pnl, 0);
  const winRate = totalSetups > 0 ? (totalWins / totalSetups * 100).toFixed(1) : '0';
  const avgPnLPerDay = results.length > 0 ? totalPnL / results.length : 0;
  const avgSetupsPerDay = results.length > 0 ? totalSetups / results.length : 0;

  const profitDays = results.filter(r => r.pnl > 0).length;
  const lossDays = results.filter(r => r.pnl < 0).length;
  const flatDays = results.filter(r => r.pnl === 0).length;

  console.log(`  Days:           ${results.length} traded (${profitDays} profit, ${lossDays} loss, ${flatDays} flat)`);
  console.log(`  Day win rate:   ${(profitDays / results.length * 100).toFixed(1)}%`);
  console.log(`  Total setups:   ${totalSetups} (${avgSetupsPerDay.toFixed(1)}/day)`);
  console.log(`  Wins:           ${totalWins}`);
  console.log(`  Losses:         ${totalLosses}`);
  console.log(`  Held:           ${totalHeld}`);
  console.log(`  Win rate:       ${winRate}%`);
  console.log(`  Total P&L:      ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}% (underlying)`);
  console.log(`  Avg P&L/day:    ${avgPnLPerDay >= 0 ? '+' : ''}${avgPnLPerDay.toFixed(3)}%`);

  // Avg win size vs avg loss size
  const winResults = results.flatMap(r => [r]).filter(r => r.wins > 0);
  const avgWinPnL = totalWins > 0
    ? results.filter(r => r.pnl > 0).reduce((s, r) => s + r.pnl, 0) / profitDays
    : 0;
  const avgLossPnL = lossDays > 0
    ? results.filter(r => r.pnl < 0).reduce((s, r) => s + r.pnl, 0) / lossDays
    : 0;
  console.log(`  Avg profit day: +${avgWinPnL.toFixed(3)}%`);
  console.log(`  Avg loss day:   ${avgLossPnL.toFixed(3)}%`);
  console.log(`  Profit factor:  ${Math.abs(avgLossPnL) > 0 ? (avgWinPnL / Math.abs(avgLossPnL)).toFixed(2) : 'N/A'}`);

  // By day type
  console.log(`\n  ── By Day Type ──`);
  const dayTypes = [...new Set(results.map(r => r.dayType))];
  for (const dt of dayTypes.sort()) {
    const dtResults = results.filter(r => r.dayType === dt);
    const dtSetups = dtResults.reduce((s, r) => s + r.setups, 0);
    const dtWins = dtResults.reduce((s, r) => s + r.wins, 0);
    const dtPnL = dtResults.reduce((s, r) => s + r.pnl, 0);
    const dtWinRate = dtSetups > 0 ? (dtWins / dtSetups * 100).toFixed(0) : '-';
    console.log(`    ${dt.padEnd(14)} ${dtResults.length} days | ${dtSetups} setups | ${dtWinRate}% win | P&L: ${dtPnL >= 0 ? '+' : ''}${dtPnL.toFixed(2)}%`);
  }

  // Best and worst days
  const sorted = [...results].sort((a, b) => b.pnl - a.pnl);
  console.log(`\n  ── Best Days ──`);
  for (const r of sorted.slice(0, 5)) {
    console.log(`    ${r.date} ${r.dayType.padEnd(12)} ${r.dayChange >= 0 ? '+' : ''}${r.dayChange.toFixed(2)}% | ${r.wins}W/${r.losses}L | P&L: +${r.pnl.toFixed(2)}%`);
  }
  console.log(`\n  ── Worst Days ──`);
  for (const r of sorted.slice(-5).reverse()) {
    console.log(`    ${r.date} ${r.dayType.padEnd(12)} ${r.dayChange >= 0 ? '+' : ''}${r.dayChange.toFixed(2)}% | ${r.wins}W/${r.losses}L | P&L: ${r.pnl.toFixed(2)}%`);
  }
}

main().catch(err => { console.error('Range backtest failed:', err); process.exit(1); });
