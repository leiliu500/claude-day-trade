import type { OHLCVBar } from '../types/market.js';
import type { CandlePattern } from '../types/indicators.js';

const BODY_THRESHOLD = 0.35;   // body ≤ 35% of range → small body
const WICK_RATIO = 2.0;         // wick ≥ 2× body → significant wick

function candleMetrics(bar: OHLCVBar) {
  const range = bar.high - bar.low;
  if (range === 0) return null;

  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const body = bodyTop - bodyBottom;
  const upperWick = bar.high - bodyTop;
  const lowerWick = bodyBottom - bar.low;

  return {
    range,
    body,
    upperWick,
    lowerWick,
    bodyRatio: body / range,
    bodyPct: (body / range) * 100,
    upperWickPct: (upperWick / range) * 100,
    lowerWickPct: (lowerWick / range) * 100,
  };
}

/** Hammer: small body at top, long lower wick, bullish bias */
function isHammer(bar: OHLCVBar): boolean {
  const m = candleMetrics(bar);
  if (!m) return false;
  return (
    m.bodyRatio <= BODY_THRESHOLD &&
    m.lowerWick >= WICK_RATIO * m.body &&
    m.upperWick <= m.body
  );
}

/** Shooting Star: small body at bottom, long upper wick, bearish bias */
function isShootingStar(bar: OHLCVBar): boolean {
  const m = candleMetrics(bar);
  if (!m) return false;
  return (
    m.bodyRatio <= BODY_THRESHOLD &&
    m.upperWick >= WICK_RATIO * m.body &&
    m.lowerWick <= m.body
  );
}

/** Bullish Engulfing: prev bearish candle fully engulfed by current bullish */
function isBullishEngulfing(prev: OHLCVBar, curr: OHLCVBar): boolean {
  const prevBearish = prev.close < prev.open;
  const currBullish = curr.close > curr.open;
  if (!prevBearish || !currBullish) return false;
  return curr.open <= prev.close && curr.close >= prev.open;
}

/** Bearish Engulfing: prev bullish candle fully engulfed by current bearish */
function isBearishEngulfing(prev: OHLCVBar, curr: OHLCVBar): boolean {
  const prevBullish = prev.close > prev.open;
  const currBearish = curr.close < curr.open;
  if (!prevBullish || !currBearish) return false;
  return curr.open >= prev.close && curr.close <= prev.open;
}

/** Doji: open ≈ close (within 10% of range) */
function isDoji(bar: OHLCVBar): boolean {
  const m = candleMetrics(bar);
  if (!m) return false;
  return m.bodyRatio <= 0.10;
}

/** Rich candle pattern detail — body/wick percentages for analysis context */
export interface CandlePatternDetail {
  present: boolean;
  bodyPct: number | null;       // body size as % of candle range (0-100)
  lowerWickPct: number | null;  // lower wick as % of range (0-100)
  upperWickPct: number | null;  // upper wick as % of range (0-100)
}

export interface AllCandlePatterns {
  hammer: CandlePatternDetail;
  shootingStar: CandlePatternDetail;
  bullishEngulfing: CandlePatternDetail;
  bearishEngulfing: CandlePatternDetail;
}

/**
 * Detect all 4 candlestick patterns independently on the last 1-2 bars.
 * Returns rich detail (bodyPct, wickPct) for each pattern.
 */
export function detectAllPatterns(bars: OHLCVBar[]): AllCandlePatterns {
  const absent: CandlePatternDetail = { present: false, bodyPct: null, lowerWickPct: null, upperWickPct: null };

  if (bars.length === 0) {
    return { hammer: absent, shootingStar: absent, bullishEngulfing: absent, bearishEngulfing: absent };
  }

  const curr = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2];
  const mc = candleMetrics(curr);

  function singleBarDetail(present: boolean): CandlePatternDetail {
    if (!present || !mc) return absent;
    return { present: true, bodyPct: mc.bodyPct, lowerWickPct: mc.lowerWickPct, upperWickPct: mc.upperWickPct };
  }

  function twoBarDetail(present: boolean): CandlePatternDetail {
    if (!present || !mc) return absent;
    return { present: true, bodyPct: mc.bodyPct, lowerWickPct: mc.lowerWickPct, upperWickPct: mc.upperWickPct };
  }

  return {
    hammer:           singleBarDetail(isHammer(curr)),
    shootingStar:     singleBarDetail(isShootingStar(curr)),
    bullishEngulfing: twoBarDetail(prev ? isBullishEngulfing(prev, curr) : false),
    bearishEngulfing: twoBarDetail(prev ? isBearishEngulfing(prev, curr) : false),
  };
}

/**
 * Detect the most significant candlestick pattern in the last 1-2 bars.
 * Priority: engulfing > hammer/star > doji
 */
export function detectCandlePattern(bars: OHLCVBar[]): CandlePattern {
  if (bars.length === 0) return 'none';

  const curr = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2];

  // Engulfing requires 2 bars
  if (prev) {
    if (isBullishEngulfing(prev, curr)) return 'bullish_engulfing';
    if (isBearishEngulfing(prev, curr)) return 'bearish_engulfing';
  }

  if (isHammer(curr)) return 'hammer';
  if (isShootingStar(curr)) return 'shooting_star';
  if (isDoji(curr)) return 'doji';

  return 'none';
}
