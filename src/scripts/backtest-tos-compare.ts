#!/usr/bin/env npx tsx
/**
 * backtest-tos-compare.ts — Compare current system signals vs TOS-parity indicators.
 *
 * Walks through a trading day and at each 1-minute bar computes:
 *   1. Current system indicators (DMI + custom signals)
 *   2. TOS-parity indicators (RSI, MACD, EMA, Bollinger, Stochastic)
 *
 * Then compares direction calls and entry quality side-by-side.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-tos-compare.ts [YYYY-MM-DD] [TICKER]
 */

import 'dotenv/config';
import { config } from '../config.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { computeTimeframeIndicators, classifyAlignment } from '../agents/signal-agent.js';
import { detectDirection } from '../lib/direction-detector.js';
import { computeRSI } from '../indicators/rsi.js';
import { computeMACD } from '../indicators/macd.js';
import { computeEMA } from '../indicators/ema.js';
import { computeBollinger } from '../indicators/bollinger.js';
import { computeStochastic } from '../indicators/stochastic.js';
import { computeATR } from '../indicators/atr.js';

const TARGET_DATE = process.argv[2] || '2026-04-14';
const TICKER = process.argv[3] || 'SPY';

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string, timeframe: Timeframe, start: string, end: string,
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
    if (data.next_page_token) pageToken = data.next_page_token;
    else break;
  }
  return allBars;
}

function aggregate1mBars(oneMins: OHLCVBar[], timeframe: Timeframe, upToTs: number): OHLCVBar[] {
  const n = { '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 }[timeframe] ?? 1;
  if (n <= 1) return oneMins.filter(b => new Date(b.timestamp).getTime() <= upToTs);
  const bucketMs = n * 60_000;
  const currentBucket = Math.floor(upToTs / bucketMs) * bucketMs;
  const groups = new Map<number, OHLCVBar[]>();
  for (const bar of oneMins) {
    const ts = new Date(bar.timestamp).getTime();
    if (ts > upToTs) continue;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (bucket >= currentBucket) continue;
    let g = groups.get(bucket);
    if (!g) { g = []; groups.set(bucket, g); }
    g.push(bar);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, bars]) => ({
      timestamp: new Date(bucket).toISOString(),
      open: bars[0]!.open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1]!.close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
      vwap: (() => {
        const totalVol = bars.reduce((s, b) => s + b.volume, 0);
        if (totalVol === 0) return undefined;
        return bars.reduce((s, b) => s + (b.vwap ?? 0) * b.volume, 0) / totalVol;
      })(),
    }));
}

function utcToET(utcTime: string): string {
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4);
  return d.toISOString().slice(11, 16);
}

// ── TOS-parity direction detection ──────────────────────────────────────────
// Standard TOS approach: EMA crossover for trend, MACD for momentum, RSI for
// overbought/oversold, Stochastic for timing, Bollinger for volatility.
interface TOSSignal {
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  reasons: string[];
  rsi: number;
  macdHist: number;
  emaFast: number;
  emaSlow: number;
  stochK: number;
  stochD: number;
  bbPercentB: number;
  bbSqueeze: boolean;
}

function computeTOSSignal(bars1m: OHLCVBar[], bars5m: OHLCVBar[]): TOSSignal {
  const rsi1m = computeRSI(bars1m, 14);
  const rsi5m = computeRSI(bars5m, 14);
  const macd1m = computeMACD(bars1m, 12, 26, 9);
  const macd5m = computeMACD(bars5m, 12, 26, 9);
  const ema1m = computeEMA(bars1m, 9, 21);
  const ema5m = computeEMA(bars5m, 9, 21);
  const bb5m = computeBollinger(bars5m, 20, 2.0);
  const stoch5m = computeStochastic(bars5m, 14, 3, 1);

  let score = 0; // positive = bullish, negative = bearish
  const reasons: string[] = [];

  // 1. EMA trend filter (HTF: 5m) — primary trend direction
  if (ema5m.bullishAlignment) { score += 2; reasons.push('5m EMA bull aligned'); }
  else if (ema5m.bearishAlignment) { score -= 2; reasons.push('5m EMA bear aligned'); }
  if (ema1m.goldenCross) { score += 1.5; reasons.push('1m golden cross'); }
  else if (ema1m.deathCross) { score -= 1.5; reasons.push('1m death cross'); }
  if (ema5m.goldenCross) { score += 2; reasons.push('5m golden cross'); }
  else if (ema5m.deathCross) { score -= 2; reasons.push('5m death cross'); }

  // Price vs EMA (trend confirmation)
  if (ema5m.priceAboveFast && ema5m.priceAboveSlow) { score += 1; reasons.push('price > both 5m EMAs'); }
  else if (!ema5m.priceAboveFast && !ema5m.priceAboveSlow) { score -= 1; reasons.push('price < both 5m EMAs'); }

  // 2. MACD momentum (HTF: 5m for trend, LTF: 1m for timing)
  if (macd5m.histogramCrossUp) { score += 2; reasons.push('5m MACD hist cross up'); }
  else if (macd5m.histogramCrossDown) { score -= 2; reasons.push('5m MACD hist cross down'); }
  if (macd5m.histogramIncreasing && macd5m.histogram > 0) { score += 1; reasons.push('5m MACD hist rising bull'); }
  else if (!macd5m.histogramIncreasing && macd5m.histogram < 0) { score -= 1; reasons.push('5m MACD hist falling bear'); }
  if (macd1m.macdCrossUp) { score += 1; reasons.push('1m MACD cross up'); }
  else if (macd1m.macdCrossDown) { score -= 1; reasons.push('1m MACD cross down'); }

  // 3. RSI (overbought/oversold + momentum)
  if (rsi5m.crossedAbove30) { score += 2; reasons.push('5m RSI crossed above 30'); }
  else if (rsi5m.crossedBelow70) { score -= 2; reasons.push('5m RSI crossed below 70'); }
  if (rsi5m.overbought) { score -= 1.5; reasons.push('5m RSI overbought'); }
  else if (rsi5m.oversold) { score += 1.5; reasons.push('5m RSI oversold'); }
  // RSI midline: >50 = bullish momentum, <50 = bearish momentum
  if (rsi5m.rsi > 55) { score += 0.5; reasons.push(`5m RSI ${rsi5m.rsi.toFixed(0)} (bull momentum)`); }
  else if (rsi5m.rsi < 45) { score -= 0.5; reasons.push(`5m RSI ${rsi5m.rsi.toFixed(0)} (bear momentum)`); }

  // 4. Stochastic (timing in overbought/oversold zones)
  if (stoch5m.bullishSignal) { score += 2; reasons.push('5m Stoch bullish signal'); }
  else if (stoch5m.bearishSignal) { score -= 2; reasons.push('5m Stoch bearish signal'); }
  if (stoch5m.overbought) { score -= 0.5; reasons.push('5m Stoch overbought'); }
  else if (stoch5m.oversold) { score += 0.5; reasons.push('5m Stoch oversold'); }

  // 5. Bollinger Bands (volatility + mean reversion)
  if (bb5m.squeeze) { score += 0; reasons.push('5m BB squeeze (pending breakout)'); }
  if (bb5m.aboveUpper) { score -= 1; reasons.push('5m price above upper BB'); }
  else if (bb5m.belowLower) { score += 1; reasons.push('5m price below lower BB'); }

  // Convert score to direction and confidence
  const maxScore = 15; // approximate max possible absolute score
  const normalizedConf = Math.min(1, Math.abs(score) / maxScore) * 0.5 + 0.38; // 0.38 base like current system
  const direction: TOSSignal['direction'] =
    score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';

  return {
    direction,
    confidence: Math.min(1, normalizedConf),
    reasons: reasons.filter(r => {
      if (direction === 'bullish') return !r.includes('bear');
      if (direction === 'bearish') return !r.includes('bull');
      return true;
    }),
    rsi: rsi5m.rsi,
    macdHist: macd5m.histogram,
    emaFast: ema5m.emaFast,
    emaSlow: ema5m.emaSlow,
    stochK: stoch5m.k,
    stochD: stoch5m.d,
    bbPercentB: bb5m.percentB,
    bbSqueeze: bb5m.squeeze,
  };
}

// ── Forward move analysis ───────────────────────────────────────────────────
function analyzeForwardMove(
  bars: OHLCVBar[], entryIdx: number, direction: 'bullish' | 'bearish',
  windowBars = 30,
): { mfePct: number; maePct: number; grade: string } {
  const entryPrice = bars[entryIdx]!.close;
  let mfe = 0, mae = 0;
  const end = Math.min(entryIdx + windowBars, bars.length);
  for (let i = entryIdx + 1; i < end; i++) {
    const favorable = direction === 'bullish'
      ? (bars[i]!.high - entryPrice) / entryPrice * 100
      : (entryPrice - bars[i]!.low) / entryPrice * 100;
    const adverse = direction === 'bullish'
      ? (entryPrice - bars[i]!.low) / entryPrice * 100
      : (bars[i]!.high - entryPrice) / entryPrice * 100;
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);
  }
  const grade = mfe > 0.40 ? 'A' : mfe > 0.25 ? 'B' : mfe > 0.15 ? 'C' : mfe > 0.05 ? 'D' : 'F';
  return { mfePct: mfe, maePct: mae, grade };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  TOS PARITY COMPARISON: ${TICKER} on ${TARGET_DATE}`);
  console.log(`${'═'.repeat(80)}\n`);

  // Fetch bars
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 4);
  const startStr = warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const endStr = TARGET_DATE + 'T23:59:59Z';

  console.log(`Fetching 1m bars: ${startStr} → ${endStr}`);
  const allOneMinRaw = await fetchBarsRange(TICKER, '1m', startStr, endStr);
  const allOneMin = allOneMinRaw.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(b.timestamp));
    const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
  console.log(`  → ${allOneMin.length} regular-session bars\n`);

  const targetDateBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  if (targetDateBars.length === 0) { console.error('No bars for target date'); process.exit(1); }

  // Build stream cache (same as backtest-day.ts)
  const BAR_CACHE_SIZE = 800;
  const openTime = new Date(`${TARGET_DATE}T13:30:00Z`);
  const closeTime = new Date(`${TARGET_DATE}T20:00:00Z`);
  const streamCache: OHLCVBar[] = allOneMin
    .filter(b => new Date(b.timestamp).getTime() < openTime.getTime())
    .slice(-BAR_CACHE_SIZE);

  const btPersistence = { dir: null as 'bullish' | 'bearish' | null, ts: 0 };

  // Track entries for both systems
  interface EntrySignal {
    time: string;
    timeET: string;
    direction: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
    price: number;
    mfePct: number;
    maePct: number;
    grade: string;
    reasons?: string[];
  }

  const currentEntries: EntrySignal[] = [];
  const tosEntries: EntrySignal[] = [];

  // All tick data for summary
  interface TickData {
    timeET: string;
    price: number;
    curDir: string;
    curConf: number;
    tosDir: string;
    tosConf: number;
    agree: boolean;
    tosRsi: number;
    tosMACD: number;
    tosStochK: number;
  }
  const ticks: TickData[] = [];

  let todayBarIdx = 0;
  const todayBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  const CUR_THRESHOLD = 0.65;
  const TOS_THRESHOLD = 0.62;

  // Walk minute by minute
  for (let t = new Date(openTime); t <= closeTime; t.setMinutes(t.getMinutes() + 1)) {
    const currentTs = t.getTime();
    const timeStr = t.toISOString();
    const timeET = utcToET(timeStr);

    // Add completed bars to stream cache
    while (todayBarIdx < todayBars.length) {
      const barTs = new Date(todayBars[todayBarIdx]!.timestamp).getTime();
      if (barTs < currentTs) {
        streamCache.push(todayBars[todayBarIdx]!);
        if (streamCache.length > BAR_CACHE_SIZE) streamCache.splice(0, streamCache.length - BAR_CACHE_SIZE);
        todayBarIdx++;
      } else break;
    }

    if (streamCache.length < 50) continue;

    const ltfBars = streamCache.slice(-500);
    const mtfBars = aggregate1mBars(streamCache, '3m', currentTs).slice(-500);
    const htfBars = aggregate1mBars(streamCache, '5m', currentTs).slice(-500);

    if (ltfBars.length < 30 || mtfBars.length < 14 || htfBars.length < 14) continue;

    // ── Current system ──────────────────────────────────────────────────────
    const { direction: curDir } = detectDirection(ltfBars, mtfBars, htfBars, true, btPersistence, currentTs);
    const tfIndicators = [
      computeTimeframeIndicators(ltfBars, '1m', curDir, true),
      computeTimeframeIndicators(mtfBars, '3m', curDir, false),
      computeTimeframeIndicators(htfBars, '5m', curDir, false),
    ];
    const curAlignment = classifyAlignment(tfIndicators, curDir);
    const currentPrice = ltfBars[ltfBars.length - 1]!.close;
    const htfAdx = tfIndicators[2]?.dmi.adx ?? 0;
    // Simple confidence proxy (ADX-based + alignment)
    let curConf = 0.38 + (htfAdx / 100) * 0.3;
    if (curAlignment === 'all_aligned') curConf += 0.06;
    else if (curAlignment === 'htf_mtf_aligned') curConf += 0.03;
    curConf = Math.min(1, curConf);

    // ── TOS-parity system ───────────────────────────────────────────────────
    const tosSignal = computeTOSSignal(ltfBars, htfBars);

    // Find this bar's index in targetDateBars for forward analysis
    const barIdx = targetDateBars.findIndex(b => new Date(b.timestamp).getTime() >= currentTs);

    ticks.push({
      timeET, price: currentPrice,
      curDir: curDir, curConf,
      tosDir: tosSignal.direction, tosConf: tosSignal.confidence,
      agree: curDir === tosSignal.direction,
      tosRsi: tosSignal.rsi,
      tosMACD: tosSignal.macdHist,
      tosStochK: tosSignal.stochK,
    });

    // Track entry signals when either system fires
    if (barIdx >= 0 && barIdx < targetDateBars.length - 30) {
      // Current system entry
      if (curDir !== 'neutral' && curConf >= CUR_THRESHOLD) {
        const fw = analyzeForwardMove(targetDateBars, barIdx, curDir as 'bullish' | 'bearish');
        // Dedup: skip if same direction entry within last 3 minutes
        const recent = currentEntries[currentEntries.length - 1];
        if (!recent || timeET > recent.timeET.slice(0, 4) + String(parseInt(recent.timeET.slice(4)) + 3)) {
          currentEntries.push({
            time: timeStr, timeET, direction: curDir, confidence: curConf,
            price: currentPrice, ...fw,
          });
        }
      }

      // TOS system entry
      if (tosSignal.direction !== 'neutral' && tosSignal.confidence >= TOS_THRESHOLD) {
        const fw = analyzeForwardMove(targetDateBars, barIdx, tosSignal.direction);
        const recent = tosEntries[tosEntries.length - 1];
        if (!recent || timeET > recent.timeET.slice(0, 4) + String(parseInt(recent.timeET.slice(4)) + 3)) {
          tosEntries.push({
            time: timeStr, timeET, direction: tosSignal.direction,
            confidence: tosSignal.confidence, price: currentPrice,
            ...fw, reasons: tosSignal.reasons,
          });
        }
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  // Direction agreement
  const agreeTicks = ticks.filter(t => t.agree).length;
  const totalTicks = ticks.length;
  console.log(`\n${'─'.repeat(80)}`);
  console.log('  DIRECTION AGREEMENT');
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Total ticks: ${totalTicks}`);
  console.log(`  Systems agree: ${agreeTicks} (${(agreeTicks/totalTicks*100).toFixed(1)}%)`);
  console.log(`  Systems disagree: ${totalTicks - agreeTicks} (${((totalTicks-agreeTicks)/totalTicks*100).toFixed(1)}%)`);

  // Show disagreements
  const disagreements = ticks.filter(t => !t.agree && t.curDir !== 'neutral' && t.tosDir !== 'neutral');
  if (disagreements.length > 0) {
    console.log(`\n  Notable disagreements (both systems have direction):`);
    console.log(`  ${'Time'.padEnd(8)} ${'Price'.padEnd(10)} ${'Current'.padEnd(12)} ${'TOS'.padEnd(12)} ${'TOS RSI'.padEnd(10)} ${'TOS MACD'.padEnd(10)}`);
    for (const d of disagreements.slice(0, 20)) {
      console.log(`  ${d.timeET.padEnd(8)} $${d.price.toFixed(2).padEnd(9)} ${d.curDir.padEnd(12)} ${d.tosDir.padEnd(12)} ${d.tosRsi.toFixed(1).padEnd(10)} ${d.tosMACD.toFixed(4).padEnd(10)}`);
    }
    if (disagreements.length > 20) console.log(`  ... and ${disagreements.length - 20} more`);
  }

  // Entry comparison
  console.log(`\n${'─'.repeat(80)}`);
  console.log('  ENTRY SIGNAL COMPARISON');
  console.log(`${'─'.repeat(80)}`);

  function printEntries(label: string, entries: EntrySignal[]) {
    const wins = entries.filter(e => e.grade === 'A' || e.grade === 'B');
    const losses = entries.filter(e => e.grade === 'F');
    const avgMfe = entries.length > 0 ? entries.reduce((s, e) => s + e.mfePct, 0) / entries.length : 0;
    const avgMae = entries.length > 0 ? entries.reduce((s, e) => s + e.maePct, 0) / entries.length : 0;

    console.log(`\n  ${label}`);
    console.log(`  Entries: ${entries.length} | Good (A/B): ${wins.length} | Bad (F): ${losses.length} | Win%: ${entries.length ? (wins.length/entries.length*100).toFixed(0) : 0}%`);
    console.log(`  Avg MFE: +${avgMfe.toFixed(3)}% | Avg MAE: -${avgMae.toFixed(3)}% | MFE/MAE: ${avgMae > 0 ? (avgMfe/avgMae).toFixed(2) : '∞'}`);
    console.log(`  ${'#'.padEnd(4)} ${'Time'.padEnd(8)} ${'Dir'.padEnd(8)} ${'Conf'.padEnd(8)} ${'Price'.padEnd(10)} ${'MFE'.padEnd(8)} ${'MAE'.padEnd(8)} ${'Grade'}`);
    console.log(`  ${'─'.repeat(70)}`);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const gradeIcon = e.grade === 'A' ? '🟢' : e.grade === 'B' ? '🔵' : e.grade === 'C' ? '🟡' : e.grade === 'D' ? '🟠' : '🔴';
      console.log(`  ${String(i + 1).padEnd(4)} ${e.timeET.padEnd(8)} ${(e.direction === 'bullish' ? '▲ bull' : '▼ bear').padEnd(8)} ${(e.confidence * 100).toFixed(0).padEnd(7)}% $${e.price.toFixed(2).padEnd(9)} +${e.mfePct.toFixed(3).padEnd(7)}% -${e.maePct.toFixed(3).padEnd(7)}% ${gradeIcon} ${e.grade}`);
    }
  }

  printEntries(`CURRENT SYSTEM (DMI + Velocity + Volume, threshold ${CUR_THRESHOLD * 100}%)`, currentEntries);
  printEntries(`TOS PARITY (RSI + MACD + EMA + Stoch + BB, threshold ${TOS_THRESHOLD * 100}%)`, tosEntries);

  // Head-to-head summary
  console.log(`\n${'─'.repeat(80)}`);
  console.log('  HEAD-TO-HEAD COMPARISON');
  console.log(`${'─'.repeat(80)}`);

  const curGood = currentEntries.filter(e => e.grade === 'A' || e.grade === 'B').length;
  const curBad = currentEntries.filter(e => e.grade === 'F').length;
  const tosGood = tosEntries.filter(e => e.grade === 'A' || e.grade === 'B').length;
  const tosBad = tosEntries.filter(e => e.grade === 'F').length;
  const curAvgMfe = currentEntries.length > 0 ? currentEntries.reduce((s, e) => s + e.mfePct, 0) / currentEntries.length : 0;
  const tosAvgMfe = tosEntries.length > 0 ? tosEntries.reduce((s, e) => s + e.mfePct, 0) / tosEntries.length : 0;
  const curAvgMae = currentEntries.length > 0 ? currentEntries.reduce((s, e) => s + e.maePct, 0) / currentEntries.length : 0;
  const tosAvgMae = tosEntries.length > 0 ? tosEntries.reduce((s, e) => s + e.maePct, 0) / tosEntries.length : 0;

  console.log(`\n  ${'Metric'.padEnd(25)} ${'Current System'.padEnd(20)} ${'TOS Parity'.padEnd(20)} Winner`);
  console.log(`  ${'─'.repeat(75)}`);
  const fmtCompare = (label: string, cur: string, tos: string, curBetter: boolean | null) => {
    const winner = curBetter === null ? '  TIED' : curBetter ? '  ← Current' : '  → TOS';
    console.log(`  ${label.padEnd(25)} ${cur.padEnd(20)} ${tos.padEnd(20)} ${winner}`);
  };

  fmtCompare('Total entries', String(currentEntries.length), String(tosEntries.length), null);
  fmtCompare('Good entries (A/B)', String(curGood), String(tosGood), curGood > tosGood ? true : curGood < tosGood ? false : null);
  fmtCompare('Bad entries (F)', String(curBad), String(tosBad), curBad < tosBad ? true : curBad > tosBad ? false : null);
  fmtCompare('Win rate', currentEntries.length ? `${(curGood/currentEntries.length*100).toFixed(0)}%` : 'N/A',
    tosEntries.length ? `${(tosGood/tosEntries.length*100).toFixed(0)}%` : 'N/A',
    currentEntries.length && tosEntries.length ? (curGood/currentEntries.length) > (tosGood/tosEntries.length) : null);
  fmtCompare('Avg MFE', `+${curAvgMfe.toFixed(3)}%`, `+${tosAvgMfe.toFixed(3)}%`, curAvgMfe > tosAvgMfe ? true : curAvgMfe < tosAvgMfe ? false : null);
  fmtCompare('Avg MAE', `-${curAvgMae.toFixed(3)}%`, `-${tosAvgMae.toFixed(3)}%`, curAvgMae < tosAvgMae ? true : curAvgMae > tosAvgMae ? false : null);
  fmtCompare('MFE/MAE ratio',
    curAvgMae > 0 ? (curAvgMfe / curAvgMae).toFixed(2) : '∞',
    tosAvgMae > 0 ? (tosAvgMfe / tosAvgMae).toFixed(2) : '∞',
    curAvgMae > 0 && tosAvgMae > 0 ? (curAvgMfe/curAvgMae) > (tosAvgMfe/tosAvgMae) : null);

  // TOS indicator snapshot at disagreements
  if (disagreements.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log('  TOS INDICATOR VALUES AT KEY DISAGREEMENTS');
    console.log(`${'─'.repeat(80)}`);
    console.log(`  Where TOS and Current system point different directions:`);
    for (const d of disagreements.slice(0, 10)) {
      console.log(`\n  ${d.timeET} ET — $${d.price.toFixed(2)}`);
      console.log(`    Current: ${d.curDir} (conf ${(d.curConf*100).toFixed(0)}%)`);
      console.log(`    TOS:     ${d.tosDir} (RSI=${d.tosRsi.toFixed(1)}, MACD=${d.tosMACD.toFixed(4)}, Stoch %K=${d.tosStochK.toFixed(1)})`);
    }
  }

  // Missing TOS-standard signals analysis
  console.log(`\n${'─'.repeat(80)}`);
  console.log('  WHAT TOS INDICATORS WOULD ADD');
  console.log(`${'─'.repeat(80)}`);

  // Count how often TOS-specific signals fire
  const rsiOBEvents = ticks.filter(t => t.tosRsi > 70 || t.tosRsi < 30).length;
  const macdCrossEvents = ticks.filter((t, i) => i > 0 && Math.sign(t.tosMACD) !== Math.sign(ticks[i-1]!.tosMACD)).length;
  const stochExtremeEvents = ticks.filter(t => t.tosStochK > 80 || t.tosStochK < 20).length;

  console.log(`\n  RSI overbought/oversold events:  ${rsiOBEvents} ticks (${(rsiOBEvents/totalTicks*100).toFixed(1)}% of day)`);
  console.log(`  MACD histogram zero-crosses:     ${macdCrossEvents} events`);
  console.log(`  Stochastic extreme events:       ${stochExtremeEvents} ticks (${(stochExtremeEvents/totalTicks*100).toFixed(1)}% of day)`);

  console.log(`\n  KEY INSIGHT: The current system lacks:`)
  console.log(`    1. RSI — ${rsiOBEvents} overbought/oversold events that could filter bad entries`);
  console.log(`    2. MACD — ${macdCrossEvents} zero-crosses that signal momentum shifts`);
  console.log(`    3. Stochastic — ${stochExtremeEvents} extreme events for entry timing`);
  console.log(`    4. EMA crossovers — faster trend detection than 14-period Wilder's DMI`);
  console.log(`    5. Bollinger Bands — squeeze detection for breakout anticipation`);

  console.log(`\n${'═'.repeat(80)}\n`);
}

main().catch(console.error);
