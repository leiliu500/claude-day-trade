/**
 * Level Interaction Detector — the core decision engine.
 *
 * Replaces the indicator-based direction/confidence model with:
 *   1. Detect which level price is interacting with
 *   2. Classify the interaction (approaching, testing, rejecting, accepting)
 *   3. Combine with structure + context to produce a setup
 *
 * A setup has: direction, entry price, stop (other side of level),
 * target (next level), and risk:reward ratio.
 */

import type { OHLCVBar } from '../types/market.js';
import type {
  PriceLevel, LevelInteraction, InteractionType, LevelSetup, SetupType,
  StructureAnalysis, MarketContext,
} from '../types/levels.js';

// ── Configuration ────────────────────────────────────────────────────────────

/** ATR multiplier for interaction zones. */
const APPROACH_ZONE = 0.30;  // within 0.30 ATR = approaching
const TEST_ZONE = 0.15;      // within 0.15 ATR = testing
const BREAK_ZONE = 0.20;     // must close 0.20 ATR beyond = acceptance
const STOP_BUFFER = 0.50;    // stop placed 0.50 ATR beyond the level
const MAX_TARGET_ATR = 1.5;   // cap target at 1.5 ATR from entry (realistic for intraday)

// ── Interaction Detection ────────────────────────────────────────────────────

/**
 * Detect how price is interacting with the nearest levels.
 *
 * @param bars      Recent 1-min bars (last ~20)
 * @param levels    All active price levels
 * @param atr       Current ATR value
 * @returns         The most significant interaction, or null
 */
export function detectLevelInteraction(
  bars: OHLCVBar[],
  levels: PriceLevel[],
  atr: number,
): LevelInteraction | null {
  if (bars.length < 3 || levels.length === 0 || atr <= 0) return null;

  const currentBar = bars[bars.length - 1]!;
  const prevBar = bars[bars.length - 2]!;
  const currentPrice = currentBar.close;

  let bestInteraction: LevelInteraction | null = null;
  let bestScore = -1;

  for (const level of levels) {
    const distance = Math.abs(currentPrice - level.price);
    const distancePct = (distance / currentPrice) * 100;
    const distanceATR = distance / atr;

    // Determine approach direction
    const direction: LevelInteraction['direction'] =
      prevBar.close > level.price ? 'from_above' : 'from_below';

    // Classify interaction type
    let interaction: InteractionType = 'none';

    if (distanceATR <= TEST_ZONE) {
      // Price is at the level — is it rejecting or testing?
      const rejection = detectRejection(bars, level, atr);
      interaction = rejection ? 'rejecting' : 'testing';
    } else if (distanceATR <= APPROACH_ZONE) {
      // Price is near — check if it's approaching or has broken through
      const acceptance = detectAcceptance(bars, level, atr);
      interaction = acceptance ? 'accepting' : 'approaching';
    } else {
      continue; // too far from this level
    }

    // Volume assessment at the level
    const volumeAtLevel = assessVolumeAtLevel(bars);

    // Candle signal at the level
    const candleSignal = detectCandleSignalAtLevel(currentBar, prevBar, level);

    // Count bars at level
    const barsAtLevel = countBarsAtLevel(bars, level, atr * TEST_ZONE);

    const levelInteraction: LevelInteraction = {
      level,
      interaction,
      direction,
      distance,
      distancePct,
      distanceATR,
      volumeAtLevel,
      candleSignal,
      barsAtLevel,
    };

    // Score this interaction (stronger levels + clearer interactions rank higher)
    const score = scoreInteraction(levelInteraction);
    if (score > bestScore) {
      bestScore = score;
      bestInteraction = levelInteraction;
    }
  }

  return bestInteraction;
}

// ── Setup Generation ─────────────────────────────────────────────────────────

/**
 * Generate a trade setup from a level interaction + structure + context.
 *
 * Returns null if the interaction doesn't warrant a trade.
 */
export function generateSetup(
  interaction: LevelInteraction,
  structure: StructureAnalysis,
  context: MarketContext,
  nearestAbove: PriceLevel[],
  nearestBelow: PriceLevel[],
  atr: number,
  currentPrice: number,
): LevelSetup | null {
  const { level, interaction: iType, direction: approachDir } = interaction;

  // Only generate setups for rejections, acceptances, and failed breakouts
  if (iType !== 'rejecting' && iType !== 'accepting') return null;

  let setupType: SetupType;
  let tradeDirection: 'bullish' | 'bearish';
  let stopPrice: number;
  let targetPrice: number;
  let targetLevel: PriceLevel | undefined;

  // Minimum distance for a target (must be meaningfully further than the stop)
  const MIN_TARGET_DIST = atr * 0.50;

  if (iType === 'rejecting') {
    // Level rejection: trade the bounce
    if (approachDir === 'from_below') {
      // Price came from below, testing resistance, rejecting → bearish
      tradeDirection = 'bearish';
      stopPrice = level.price + atr * STOP_BUFFER;
      // Target: next support below (must be at least MIN_TARGET_DIST below current price)
      targetLevel = nearestBelow.find(l => currentPrice - l.price >= MIN_TARGET_DIST);
      targetPrice = targetLevel?.price ?? (currentPrice - atr * 1.5);
    } else {
      // Price came from above, testing support, rejecting → bullish
      tradeDirection = 'bullish';
      stopPrice = level.price - atr * STOP_BUFFER;
      // Target: next resistance above
      targetLevel = nearestAbove.find(l => l.price - currentPrice >= MIN_TARGET_DIST);
      targetPrice = targetLevel?.price ?? (currentPrice + atr * 1.5);
    }
    setupType = 'level_rejection';

    // Check for failed breakout (highest probability)
    if (structure.failedBreakout &&
        Math.abs(structure.failedBreakout.level.price - level.price) < atr * 0.30) {
      setupType = 'failed_breakout';
    }
  } else {
    // Acceptance: trade the breakout continuation
    if (approachDir === 'from_below') {
      // Broke above resistance → bullish
      tradeDirection = 'bullish';
      stopPrice = level.price - atr * STOP_BUFFER;
      targetLevel = nearestAbove.find(l => l.price - currentPrice >= MIN_TARGET_DIST);
      targetPrice = targetLevel?.price ?? (currentPrice + atr * 2.0);
    } else {
      // Broke below support → bearish
      tradeDirection = 'bearish';
      stopPrice = level.price + atr * STOP_BUFFER;
      targetLevel = nearestBelow.find(l => currentPrice - l.price >= MIN_TARGET_DIST);
      targetPrice = targetLevel?.price ?? (currentPrice - atr * 2.0);
    }
    setupType = 'breakout_acceptance';
  }

  // VWAP mean reversion: if price is extended from VWAP and at a level
  if (level.type.startsWith('vwap_') && iType === 'rejecting') {
    setupType = 'vwap_mean_reversion';
  }

  // Validate structure alignment
  if (!isStructureAligned(tradeDirection, structure, context)) {
    // Structure doesn't confirm — still return the setup but context matters
    // The analysis agent will penalize this
  }

  // Cap target distance at MAX_TARGET_ATR (unrealistically far targets never hit)
  const maxTargetDist = atr * MAX_TARGET_ATR;
  if (tradeDirection === 'bullish' && targetPrice > currentPrice + maxTargetDist) {
    targetPrice = currentPrice + maxTargetDist;
  } else if (tradeDirection === 'bearish' && targetPrice < currentPrice - maxTargetDist) {
    targetPrice = currentPrice - maxTargetDist;
  }

  const risk = Math.abs(currentPrice - stopPrice);
  const reward = Math.abs(targetPrice - currentPrice);
  const riskReward = risk > 0 ? reward / risk : 0;

  // ── Quality Gates ────────────────────────────────────────────────────────

  // Gate 1: Minimum R:R of 1.5 (don't take bad risk/reward trades)
  if (riskReward < 1.5) return null;

  // Gate 2: Require a candle signal or volume confirmation (not just proximity)
  if (interaction.candleSignal === 'none' && interaction.volumeAtLevel === 'normal') {
    // Only allow if the level is very strong (confluence >= 3)
    if (interaction.level.strength < 3) return null;
  }

  // Gate 3: Day type compatibility — block only the worst mismatches
  // Allow counter-trend level rejections (pullback trades) — they're valid on trend days
  // Only block breakout_acceptance on rotational days (breakouts fail in ranges)
  if (context.dayType === 'rotational' && setupType === 'breakout_acceptance') return null;

  return {
    type: setupType,
    direction: tradeDirection,
    entryPrice: currentPrice,
    stopPrice,
    targetPrice,
    riskReward,
    level,
    targetLevel,
    interaction,
    structure,
    context,
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/** Detect rejection: price touched level then reversed with a wick. */
function detectRejection(bars: OHLCVBar[], level: PriceLevel, atr: number): boolean {
  if (bars.length < 3) return false;

  const current = bars[bars.length - 1]!;
  const body = Math.abs(current.close - current.open);
  const upperWick = current.high - Math.max(current.close, current.open);
  const lowerWick = Math.min(current.close, current.open) - current.low;

  // Rejection from above (resistance): upper wick > body, close below level
  if (current.high >= level.price && current.close < level.price) {
    if (upperWick > body * 0.5) return true;
  }

  // Rejection from below (support): lower wick > body, close above level
  if (current.low <= level.price && current.close > level.price) {
    if (lowerWick > body * 0.5) return true;
  }

  // 2-bar rejection: previous bar tested, current bar moved away
  const prev = bars[bars.length - 2]!;
  const prevDistance = Math.abs(prev.close - level.price);
  const curDistance = Math.abs(current.close - level.price);
  if (prevDistance < atr * TEST_ZONE && curDistance > atr * TEST_ZONE) {
    // Moved away from level
    const movedAway = (prev.close > level.price && current.close > prev.close) ||
                      (prev.close < level.price && current.close < prev.close);
    if (movedAway) return true;
  }

  return false;
}

/** Detect acceptance: price broke through level and held for 3+ bars. */
function detectAcceptance(bars: OHLCVBar[], level: PriceLevel, atr: number): boolean {
  if (bars.length < 5) return false;

  const breakZone = atr * BREAK_ZONE;
  const last4 = bars.slice(-4);

  // Check if all last 4 bars closed on the same side beyond the level
  const allAbove = last4.every(b => b.close > level.price + breakZone);
  const allBelow = last4.every(b => b.close < level.price - breakZone);

  if (!allAbove && !allBelow) return false;

  // Must have earlier bars on the other side (actual breakout, not always beyond)
  if (bars.length >= 8) {
    const earlier = bars.slice(-8, -4);
    if (allAbove) return earlier.some(b => b.close <= level.price + breakZone);
    if (allBelow) return earlier.some(b => b.close >= level.price - breakZone);
  }

  return allAbove || allBelow;
}

/** Assess volume at the current bar vs recent average. */
function assessVolumeAtLevel(bars: OHLCVBar[]): LevelInteraction['volumeAtLevel'] {
  if (bars.length < 10) return 'normal';

  const current = bars[bars.length - 1]!;
  const recent = bars.slice(-10, -1);
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;

  if (avgVol === 0) return 'normal';
  const ratio = current.volume / avgVol;

  if (ratio > 1.5) return 'expanding';
  if (ratio < 0.6) return 'contracting';
  return 'normal';
}

/** Detect candle pattern at a level. */
function detectCandleSignalAtLevel(
  current: OHLCVBar,
  prev: OHLCVBar,
  level: PriceLevel,
): LevelInteraction['candleSignal'] {
  const body = Math.abs(current.close - current.open);
  const upperWick = current.high - Math.max(current.close, current.open);
  const lowerWick = Math.min(current.close, current.open) - current.low;
  const totalRange = current.high - current.low;

  if (totalRange === 0) return 'none';

  // Doji: body < 20% of total range
  if (body / totalRange < 0.20) return 'doji';

  // Rejection wick: one wick > 60% of range touching the level
  if (upperWick / totalRange > 0.60 && current.high >= level.price) return 'rejection_wick';
  if (lowerWick / totalRange > 0.60 && current.low <= level.price) return 'rejection_wick';

  // Engulfing: current body fully covers previous body
  const prevBody = Math.abs(prev.close - prev.open);
  if (body > prevBody * 1.5 && body / totalRange > 0.60) {
    const bullishEngulf = current.close > current.open && prev.close < prev.open;
    const bearishEngulf = current.close < current.open && prev.close > prev.open;
    if (bullishEngulf || bearishEngulf) return 'engulfing';
  }

  // Strong body: body > 70% of range (directional conviction)
  if (body / totalRange > 0.70) return 'strong_body';

  return 'none';
}

/** Count how many recent bars have been within the interaction zone. */
function countBarsAtLevel(bars: OHLCVBar[], level: PriceLevel, zone: number): number {
  let count = 0;
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 10); i--) {
    const dist = Math.abs(bars[i]!.close - level.price);
    if (dist <= zone) count++;
    else break; // stop at first bar outside the zone
  }
  return count;
}

/** Score an interaction for ranking (higher = more significant). */
function scoreInteraction(interaction: LevelInteraction): number {
  let score = 0;

  // Interaction type priority
  switch (interaction.interaction) {
    case 'rejecting': score += 5; break;
    case 'accepting': score += 4; break;
    case 'testing': score += 3; break;
    case 'approaching': score += 1; break;
  }

  // Level strength (confluence)
  score += interaction.level.strength;

  // Volume confirmation
  if (interaction.volumeAtLevel === 'expanding') score += 2;

  // Candle signal
  switch (interaction.candleSignal) {
    case 'rejection_wick': score += 3; break;
    case 'engulfing': score += 2; break;
    case 'doji': score += 1; break;
    case 'strong_body': score += 1; break;
  }

  // Freshness bonus (untested levels react more strongly)
  if (interaction.level.freshness === 'fresh') score += 2;
  if (interaction.level.touchCount === 0) score += 1;

  return score;
}

/** Check if structure supports the trade direction. */
function isStructureAligned(
  direction: 'bullish' | 'bearish',
  structure: StructureAnalysis,
  context: MarketContext,
): boolean {
  if (direction === 'bullish') {
    // Bullish: uptrend structure or range (buying at support)
    if (structure.state === 'uptrend') return true;
    if (structure.state === 'range') return true;
    // Downtrend but at key level with failed breakout = potential reversal
    if (structure.failedBreakout?.direction === 'bearish_fail') return true;
    return false;
  } else {
    if (structure.state === 'downtrend') return true;
    if (structure.state === 'range') return true;
    if (structure.failedBreakout?.direction === 'bullish_fail') return true;
    return false;
  }
}
