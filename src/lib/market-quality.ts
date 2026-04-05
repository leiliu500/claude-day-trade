/**
 * market-quality.ts — Session-level market quality scoring for adaptive thresholds.
 *
 * Instead of fixed confidence thresholds (0.65) that work on trending days but
 * cause zero-entry days on quiet markets, this module computes a "market quality"
 * score that adapts the entry threshold to the day's character.
 *
 * Quiet day (low ATR, low volatility) → lower threshold (more entries allowed)
 * Active day (high ATR, strong trends) → higher threshold (be selective)
 *
 * The score is computed from the first 30 minutes of data and updated every 30 minutes.
 */

import type { OHLCVBar } from '../types/market.js';

export interface MarketQuality {
  /** Today's ATR relative to recent average (0.5 = half, 1.0 = normal, 2.0 = double) */
  atrRatio: number;
  /** Fraction of recent bars where ADX > 20 (0 = no trend, 1 = always trending) */
  trendClarity: number;
  /** Direction stability: 0 = flipping constantly, 1 = stable direction */
  directionStability: number;
  /** Volume relative to recent average */
  volumeProfile: number;
  /** Composite quality score (0-1, higher = better trading conditions) */
  composite: number;
  /** Adaptive confidence threshold based on quality */
  adaptiveThreshold: number;
}

/**
 * Compute market quality from today's bars and a baseline ATR.
 *
 * @param todayBars - Today's 1m bars so far (at least 10 required)
 * @param baselineAtr - Average ATR from prior days (from HTF indicator)
 * @param baselineVolume - Average volume from prior days (0 = skip volume component)
 * @param baseThreshold - Base confidence threshold (e.g. 0.65)
 * @returns MarketQuality with adaptive threshold
 */
export function computeMarketQuality(
  todayBars: OHLCVBar[],
  baselineAtr: number,
  baselineVolume: number,
  baseThreshold: number,
): MarketQuality {
  if (todayBars.length < 10 || baselineAtr <= 0) {
    return {
      atrRatio: 1.0,
      trendClarity: 0.5,
      directionStability: 0.5,
      volumeProfile: 1.0,
      composite: 0.5,
      adaptiveThreshold: baseThreshold,
    };
  }

  // ── ATR ratio: today's realized volatility vs baseline ──
  let todayRange = 0;
  for (let i = 1; i < todayBars.length; i++) {
    const bar = todayBars[i]!;
    const prevClose = todayBars[i - 1]!.close;
    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );
    todayRange += tr;
  }
  const todayAvgTR = todayRange / (todayBars.length - 1);
  const atrRatio = Math.min(3.0, todayAvgTR / baselineAtr);

  // ── Direction stability: count direction changes ──
  let dirChanges = 0;
  let prevDir: 'up' | 'down' | null = null;
  for (let i = 1; i < todayBars.length; i++) {
    const dir = todayBars[i]!.close > todayBars[i - 1]!.close ? 'up' : 'down';
    if (prevDir && dir !== prevDir) dirChanges++;
    prevDir = dir;
  }
  // Expected flips in random walk: ~50% of bars. Stability = how far below that.
  const expectedFlips = (todayBars.length - 1) * 0.5;
  const directionStability = Math.max(0, Math.min(1, 1 - (dirChanges / expectedFlips)));

  // ── Trend clarity: is there a dominant direction? ──
  const dayOpen = todayBars[0]!.open;
  const dayClose = todayBars[todayBars.length - 1]!.close;
  const dayMovePct = Math.abs(dayClose - dayOpen) / dayOpen * 100;
  const dayRangePct = (Math.max(...todayBars.map(b => b.high)) - Math.min(...todayBars.map(b => b.low))) / dayOpen * 100;
  // Efficiency: how much of the range is directional move (0 = choppy, 1 = straight line)
  const trendClarity = dayRangePct > 0 ? Math.min(1, dayMovePct / dayRangePct) : 0;

  // ── Volume profile ──
  const avgVolume = baselineVolume > 0
    ? todayBars.reduce((s, b) => s + b.volume, 0) / todayBars.length / baselineVolume
    : 1.0;
  const volumeProfile = Math.min(3.0, avgVolume);

  // ── Composite score (0-1, higher = better market for trading) ──
  // Weights: ATR ratio matters most (is the market moving?), then direction stability
  const composite = Math.min(1, Math.max(0,
    0.35 * Math.min(1, atrRatio) +         // ATR: more movement = better
    0.25 * directionStability +              // Stability: trending = better
    0.25 * trendClarity +                    // Clarity: directional = better
    0.15 * Math.min(1, volumeProfile),       // Volume: participation = better
  ));

  // ── Adaptive threshold ──
  // Quality 0.2 (dead quiet) → threshold drops 0.04 (e.g. 0.65 → 0.61)
  // Quality 0.5 (average) → threshold unchanged
  // Quality 0.8+ (strong trend) → threshold rises 0.02 (e.g. 0.65 → 0.67)
  const thresholdAdjust = (composite - 0.5) * 0.08; // ±0.04 range
  const adaptiveThreshold = Math.max(0.55, Math.min(0.75, baseThreshold + thresholdAdjust));

  return {
    atrRatio,
    trendClarity,
    directionStability,
    volumeProfile,
    composite,
    adaptiveThreshold,
  };
}

/**
 * Session-level market quality tracker.
 * Updated periodically (every 30 min) during the trading session.
 */
export class MarketQualityTracker {
  private _quality: MarketQuality | null = null;
  private _lastUpdateTs = 0;
  private static readonly UPDATE_INTERVAL_MS = 15 * 60_000; // update every 15 min

  /** Get current market quality (may be null if not yet computed) */
  get quality(): MarketQuality | null {
    return this._quality;
  }

  /** Get adaptive threshold (falls back to base if not yet computed) */
  getAdaptiveThreshold(baseThreshold: number): number {
    return this._quality?.adaptiveThreshold ?? baseThreshold;
  }

  /**
   * Update quality if enough time has passed.
   * @returns true if quality was updated, false if skipped (too soon)
   */
  update(
    todayBars: OHLCVBar[],
    baselineAtr: number,
    baselineVolume: number,
    baseThreshold: number,
    nowTs: number,
  ): boolean {
    if (nowTs - this._lastUpdateTs < MarketQualityTracker.UPDATE_INTERVAL_MS && this._quality) {
      return false;
    }
    this._quality = computeMarketQuality(todayBars, baselineAtr, baselineVolume, baseThreshold);
    this._lastUpdateTs = nowTs;
    return true;
  }

  /** Reset for new session */
  reset(): void {
    this._quality = null;
    this._lastUpdateTs = 0;
  }
}

// ── Singleton per ticker ──────────────────────────────────────────────────────
const trackers = new Map<string, MarketQualityTracker>();

export function getMarketQualityTracker(ticker: string): MarketQualityTracker {
  let tracker = trackers.get(ticker);
  if (!tracker) {
    tracker = new MarketQualityTracker();
    trackers.set(ticker, tracker);
  }
  return tracker;
}
