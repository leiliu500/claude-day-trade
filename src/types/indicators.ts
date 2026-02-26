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
}

export interface ATRResult {
  atr: number;
  atrPct: number;  // ATR as % of last close
}

export interface TDSetup {
  direction: 'buy' | 'sell' | 'none';
  count: number;       // 0-9
  completed: boolean;  // count reached 9
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
}

export interface TimeframeIndicators {
  timeframe: Timeframe;
  bars: OHLCVBar[];
  dmi: DMIResult;
  atr: ATRResult;
  td: TDResult;
  candlePattern: CandlePattern;
  allCandlePatterns: AllCandlePatterns;  // all 4 patterns checked independently
  priceStructure: PriceStructure;
  currentPrice: number;
}

export type { AllCandlePatterns };
