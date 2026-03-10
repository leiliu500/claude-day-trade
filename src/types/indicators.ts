import type { OHLCVBar, Timeframe } from './market.js';
import type { AllCandlePatterns } from '../indicators/candle-patterns.js';

export interface DMIResult {
  plusDI: number;
  minusDI: number;
  adx: number;
  trend: 'bullish' | 'bearish' | 'neutral';
  adxStrength: 'strong' | 'moderate' | 'weak'; // >30 strong, >20 moderate
  crossedUp: boolean;    // DI+ crossed above DI- on last bar
  crossedDown: boolean;  // DI- crossed above DI+ on last bar
  adxBarsAbove25: number; // consecutive recent bars where ADX > 25 (trend maturity)
  adxSlope: number;       // ADX change over last 3 bars (positive = strengthening trend)
  diSpreadSlope: number;  // directional DI spread change over last 3 bars (positive = widening)
}

export interface ATRResult {
  atr: number;
  atrPct: number;  // ATR as % of last close
}

export interface OBVResult {
  value: number;                            // current OBV (cumulative)
  trend: 'bullish' | 'bearish' | 'neutral'; // direction over last N bars
  divergence: 'bullish' | 'bearish' | 'none'; // OBV vs price divergence
}

export interface TDSetup {
  direction: 'buy' | 'sell' | 'none';       // current in-progress setup direction
  count: number;                              // 0-9 (in-progress count)
  completed: boolean;                         // a 9-bar setup was completed
  completedDirection: 'buy' | 'sell' | 'none'; // direction of the most-recently completed setup
}

export interface TDCountdown {
  direction: 'buy' | 'sell' | 'none';
  count: number;       // 0-13
  completed: boolean;
}

export interface TDResult {
  setup: TDSetup;
  countdown: TDCountdown;
}

export type CandlePattern =
  | 'hammer'
  | 'shooting_star'
  | 'bullish_engulfing'
  | 'bearish_engulfing'
  | 'doji'
  | 'none';

export interface VWAPResult {
  vwap: number;        // cumulative VWAP since last day reset
  upperBand: number;   // vwap + 2σ
  lowerBand: number;   // vwap − 2σ
  deviation: number;   // σ (volume-weighted standard deviation)
  priceVsVwap: number; // (currentPrice − vwap) / vwap × 100 (%)
}

export interface PriceStructure {
  swingHigh: number;           // highest high in last N bars
  swingLow: number;            // lowest low in last N bars
  currentPrice: number;        // last close
  priceVsSwingHigh: number;    // (current - swingHigh) / swingHigh * 100
  priceVsSwingLow: number;     // (current - swingLow) / swingLow * 100
  swingHighBarsAgo: number;    // how many bars ago the swing high occurred
  swingLowBarsAgo: number;     // how many bars ago the swing low occurred
  atrValue: number;            // ATR at last bar (same lookback as swing)
  // Direction-aware underlying levels (set externally based on signal direction)
  triggerPrice: number;        // = currentPrice (entry trigger)
  invalidationLevel: number;   // swing low (bullish) or swing high (bearish)
  targetLevel: number;         // swing high (bullish) or swing low (bearish)
  underlyingRR: number;        // (target - trigger) / (trigger - invalidation)
  // Price position within the swing range
  rangePosition: number;       // 0.0 (at swingLow) → 1.0 (at swingHigh)
  priceHalf: 'upper' | 'lower'; // whether price is above or below swing midpoint
}

export interface TimeframeIndicators {
  timeframe: Timeframe;
  bars: OHLCVBar[];
  dmi: DMIResult;
  atr: ATRResult;
  obv: OBVResult;
  td: TDResult;
  vwap: VWAPResult;
  candlePattern: CandlePattern;
  allCandlePatterns: AllCandlePatterns;  // all 4 patterns checked independently
  priceStructure: PriceStructure;
  currentPrice: number;
}

/**
 * Prior Day High / Low / Close — structural reference levels for intraday context.
 * Derived from the most recently completed daily session.
 */
export interface PriorDayLevels {
  pdh: number;               // prior day high
  pdl: number;               // prior day low
  pdc: number;               // prior day close
  priceVsPDH: number;        // (currentPrice − pdh) / pdh × 100 (%)
  priceVsPDL: number;        // (currentPrice − pdl) / pdl × 100 (%)
  abovePDH: boolean;         // price broke above prior day high
  belowPDL: boolean;         // price broke below prior day low
  structureBias: 'bullish' | 'bearish' | 'neutral';
}

/**
 * Opening Range Breakout — first 30-minute range (9:30–10:00 ET) and current breakout state.
 */
export interface ORBResult {
  orbHigh: number;           // opening range high
  orbLow: number;            // opening range low
  orbMidpoint: number;       // midpoint of the range
  rangeSizePct: number;      // (orbHigh − orbLow) / orbLow × 100 — range magnitude
  breakoutDirection: 'bullish' | 'bearish' | 'none'; // current price vs ORB
  breakoutStrength: number;  // 0–1: how far price has moved beyond the ORB boundary (as fraction of range)
  orbFormed: boolean;        // false if before 10:00 ET or no bars in the window
}

export type { AllCandlePatterns };
