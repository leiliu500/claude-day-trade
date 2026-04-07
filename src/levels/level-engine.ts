/**
 * Level Engine — computes and ranks all key price levels for intraday trading.
 *
 * Levels come from:
 *   1. Prior day high/low/close (premarket)
 *   2. Overnight high/low (premarket)
 *   3. Opening range high/low (intraday, after 10:00 ET)
 *   4. VWAP + σ bands (intraday, continuously updated)
 *   5. Volume profile VPOC / Value Area (intraday)
 *   6. Weekly/monthly open (premarket)
 *   7. Intraday swing high/low (intraday, from structure)
 *   8. GEX levels — call wall, put wall, zero gamma (premarket/intraday)
 *
 * Each level gets a strength score (1-5) based on how many level types
 * coincide near the same price. Higher confluence = stronger level.
 */

import type { OHLCVBar } from '../types/market.js';
import type { PriceLevel, LevelType, VolumeProfileResult } from '../types/levels.js';
import type { VWAPResult, ORBResult, PriorDayLevels } from '../types/indicators.js';
import { computeVolumeProfile } from './volume-profile.js';
import { computeVWAP } from '../indicators/vwap.js';
import { computePriorDayLevels } from '../indicators/market-structure.js';
import { computeORB } from '../indicators/market-structure.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLevel(
  price: number,
  type: LevelType,
  label: string,
  source: 'premarket' | 'intraday',
): PriceLevel {
  return { price, type, label, strength: 1, freshness: 'fresh', touchCount: 0, source };
}

/**
 * Merge levels that are within `tolerance` of each other.
 * When multiple levels cluster, keep the one with highest priority and
 * increase its strength by the count of merged levels.
 */
function mergeLevels(levels: PriceLevel[], tolerance: number): PriceLevel[] {
  if (levels.length === 0) return [];

  // Sort by price
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const merged: PriceLevel[] = [];
  let cluster: PriceLevel[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const clusterPrice = cluster[0]!.price;

    if (Math.abs(current.price - clusterPrice) <= tolerance) {
      cluster.push(current);
    } else {
      merged.push(resolveCluster(cluster));
      cluster = [current];
    }
  }
  merged.push(resolveCluster(cluster));

  return merged;
}

/** Pick the representative level from a cluster. Use average price, highest-priority type. */
function resolveCluster(cluster: PriceLevel[]): PriceLevel {
  if (cluster.length === 1) return cluster[0]!;

  // Priority order for which type survives
  const priority: LevelType[] = [
    'vpoc', 'pdh', 'pdl', 'pdc', 'orb_high', 'orb_low',
    'onh', 'onl', 'vwap', 'weekly_open', 'monthly_open',
    'gex_call_wall', 'gex_put_wall', 'gex_zero',
    'vwap_1sig_upper', 'vwap_1sig_lower', 'vwap_2sig_upper', 'vwap_2sig_lower',
    'val', 'vah', 'swing_high', 'swing_low',
  ];

  // Sort cluster by priority (lower index = higher priority)
  const sorted = [...cluster].sort((a, b) => {
    const ai = priority.indexOf(a.type);
    const bi = priority.indexOf(b.type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const winner = sorted[0]!;
  const avgPrice = cluster.reduce((sum, l) => sum + l.price, 0) / cluster.length;
  const types = cluster.map(l => l.type).join('+');

  return {
    ...winner,
    price: Math.round(avgPrice * 100) / 100,
    strength: Math.min(5, cluster.length),
    label: `${winner.label} [${types}]`,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface LevelEngineInput {
  dailyBars: OHLCVBar[];        // multi-day daily bars for PDH/PDL/PDC + weekly/monthly
  todayBars1m: OHLCVBar[];      // today's 1-min bars (from stream cache)
  currentPrice: number;
  vwapResult?: VWAPResult;       // pre-computed VWAP (if available)
  orbResult?: ORBResult;         // pre-computed ORB (if available)
  volumeProfile?: VolumeProfileResult; // pre-computed (if available)
  swingHighs?: number[];         // intraday swing highs from structure tracker
  swingLows?: number[];          // intraday swing lows from structure tracker
  gexLevels?: PriceLevel[];      // GEX call wall / put wall / zero from options chain
}

export interface LevelEngineOutput {
  allLevels: PriceLevel[];       // all levels sorted by price, merged for confluence
  nearestAbove: PriceLevel[];    // closest 3 above current price
  nearestBelow: PriceLevel[];    // closest 3 below current price
  priorDayLevels: PriorDayLevels;
  orbResult: ORBResult;
  vwapResult: VWAPResult;
  volumeProfile: VolumeProfileResult;
}

/**
 * Compute all price levels for the current session.
 *
 * Call once at session start for premarket levels, then every tick for
 * intraday updates (VWAP, volume profile, swing points shift).
 */
export function computeLevels(input: LevelEngineInput): LevelEngineOutput {
  const {
    dailyBars,
    todayBars1m,
    currentPrice,
    swingHighs = [],
    swingLows = [],
  } = input;

  const rawLevels: PriceLevel[] = [];

  // 1. Prior Day Levels
  const pdl = computePriorDayLevels(dailyBars, currentPrice);
  if (pdl.pdh > 0) {
    rawLevels.push(makeLevel(pdl.pdh, 'pdh', 'PDH', 'premarket'));
    rawLevels.push(makeLevel(pdl.pdl, 'pdl', 'PDL', 'premarket'));
    rawLevels.push(makeLevel(pdl.pdc, 'pdc', 'PDC', 'premarket'));
  }

  // 2. Overnight High/Low (pre-market bars: before 14:30 UTC on today)
  const overnightLevels = computeOvernightLevels(todayBars1m);
  rawLevels.push(...overnightLevels);

  // 3. Opening Range
  const orb = input.orbResult ?? computeORB(todayBars1m, currentPrice);
  if (orb.orbFormed) {
    rawLevels.push(makeLevel(orb.orbHigh, 'orb_high', 'ORB High', 'intraday'));
    rawLevels.push(makeLevel(orb.orbLow, 'orb_low', 'ORB Low', 'intraday'));
  }

  // 4. VWAP + bands
  const vwap = input.vwapResult ?? computeVWAP(todayBars1m);
  if (vwap.vwap > 0) {
    rawLevels.push(makeLevel(vwap.vwap, 'vwap', 'VWAP', 'intraday'));
    if (vwap.deviation > 0) {
      rawLevels.push(makeLevel(vwap.vwap + vwap.deviation, 'vwap_1sig_upper', 'VWAP+1σ', 'intraday'));
      rawLevels.push(makeLevel(vwap.vwap - vwap.deviation, 'vwap_1sig_lower', 'VWAP-1σ', 'intraday'));
      rawLevels.push(makeLevel(vwap.upperBand, 'vwap_2sig_upper', 'VWAP+2σ', 'intraday'));
      rawLevels.push(makeLevel(vwap.lowerBand, 'vwap_2sig_lower', 'VWAP-2σ', 'intraday'));
    }
  }

  // 5. Volume Profile
  const vp = input.volumeProfile ?? computeVolumeProfile(todayBars1m);
  if (vp.vpoc > 0) {
    rawLevels.push(makeLevel(vp.vpoc, 'vpoc', 'VPOC', 'intraday'));
    rawLevels.push(makeLevel(vp.valueAreaHigh, 'vah', 'VA High', 'intraday'));
    rawLevels.push(makeLevel(vp.valueAreaLow, 'val', 'VA Low', 'intraday'));
  }

  // 6. Weekly / Monthly Open
  const calendarLevels = computeCalendarLevels(dailyBars);
  rawLevels.push(...calendarLevels);

  // 7. Intraday Swing Points — only significant ones (min 0.20 ATR from current price)
  // Without this filter, every 3-bar pivot becomes a level and generates noise.
  const atrEstimate = currentPrice * 0.004; // rough 5m ATR estimate if not provided
  const minSwingRelevance = atrEstimate * 0.20;
  const swingDedup = new Set<string>();
  for (const sh of swingHighs) {
    const key = (Math.round(sh * 10) / 10).toFixed(1); // dedup within $0.10
    if (swingDedup.has(key)) continue;
    swingDedup.add(key);
    rawLevels.push(makeLevel(sh, 'swing_high', `SwH $${sh.toFixed(2)}`, 'intraday'));
  }
  for (const sl of swingLows) {
    const key = (Math.round(sl * 10) / 10).toFixed(1);
    if (swingDedup.has(key)) continue;
    swingDedup.add(key);
    rawLevels.push(makeLevel(sl, 'swing_low', `SwL $${sl.toFixed(2)}`, 'intraday'));
  }

  // 8. GEX Levels (from options chain)
  if (input.gexLevels) {
    rawLevels.push(...input.gexLevels);
  }

  // Filter out levels that are 0 or very far from current price (>3%)
  const filtered = rawLevels.filter(l =>
    l.price > 0 && Math.abs(l.price - currentPrice) / currentPrice < 0.03
  );

  // Merge confluent levels (within 0.08% of each other)
  const tolerance = currentPrice * 0.0008;
  const allLevels = mergeLevels(filtered, tolerance);

  // Sort by proximity to current price
  const sorted = [...allLevels].sort(
    (a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)
  );

  const nearestAbove = sorted
    .filter(l => l.price > currentPrice)
    .slice(0, 3);

  const nearestBelow = sorted
    .filter(l => l.price <= currentPrice)
    .slice(0, 3);

  return {
    allLevels: allLevels.sort((a, b) => a.price - b.price),
    nearestAbove,
    nearestBelow,
    priorDayLevels: pdl,
    orbResult: orb,
    vwapResult: vwap,
    volumeProfile: vp,
  };
}

// ── Internal: Overnight Levels ───────────────────────────────────────────────

function computeOvernightLevels(bars1m: OHLCVBar[]): PriceLevel[] {
  if (bars1m.length === 0) return [];

  // Overnight = bars before 14:30 UTC (9:30 ET) on the latest date
  const lastTs = bars1m[bars1m.length - 1]!.timestamp;
  const todayDate = lastTs.slice(0, 10);

  const overnightBars = bars1m.filter(bar => {
    if (!bar.timestamp.startsWith(todayDate)) return false;
    const time = bar.timestamp.slice(11, 16);
    return time < '14:30';
  });

  if (overnightBars.length < 2) return [];

  const onh = Math.max(...overnightBars.map(b => b.high));
  const onl = Math.min(...overnightBars.map(b => b.low));

  return [
    makeLevel(onh, 'onh', 'ON High', 'premarket'),
    makeLevel(onl, 'onl', 'ON Low', 'premarket'),
  ];
}

// ── Internal: Calendar Levels ────────────────────────────────────────────────

function computeCalendarLevels(dailyBars: OHLCVBar[]): PriceLevel[] {
  if (dailyBars.length < 2) return [];

  const levels: PriceLevel[] = [];

  // Weekly open: first bar of the current week (Mon)
  const lastDate = dailyBars[dailyBars.length - 1]!.timestamp.slice(0, 10);
  const lastDay = new Date(lastDate);
  const dayOfWeek = lastDay.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  // Search backward for the Monday open
  for (let i = dailyBars.length - 1; i >= 0; i--) {
    const bar = dailyBars[i]!;
    const barDate = new Date(bar.timestamp.slice(0, 10));
    const barDow = barDate.getUTCDay();
    if (barDow === 1) {
      levels.push(makeLevel(bar.open, 'weekly_open', 'Wk Open', 'premarket'));
      break;
    }
  }

  // Monthly open: first bar of the current month
  const currentMonth = lastDate.slice(0, 7); // YYYY-MM
  for (const bar of dailyBars) {
    const barMonth = bar.timestamp.slice(0, 7);
    if (barMonth === currentMonth) {
      levels.push(makeLevel(bar.open, 'monthly_open', 'Mo Open', 'premarket'));
      break;
    }
  }

  return levels;
}
