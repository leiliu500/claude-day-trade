import type { OHLCVBar } from '../types/market.js';

export interface RSIResult {
  value: number;                              // 0–100
  trend: 'bullish' | 'bearish' | 'neutral';  // >55 bullish, <45 bearish
  overbought: boolean;                        // > 70
  oversold: boolean;                          // < 30
  divergence: 'bullish' | 'bearish' | 'none'; // price/RSI divergence over last N bars
}

/**
 * Wilder's smoothed RSI (same smoothing used by DMI/ATR).
 * Requires at least period+1 bars; returns neutral result if insufficient data.
 */
export function computeRSI(bars: OHLCVBar[], period = 14): RSIResult {
  const neutral: RSIResult = {
    value: 50,
    trend: 'neutral',
    overbought: false,
    oversold: false,
    divergence: 'none',
  };

  if (bars.length < period + 1) return neutral;

  // Compute changes
  const changes: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    changes.push((bars[i].close - bars[i - 1].close));
  }

  // Seed: simple average of first `period` gains/losses
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i];
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining bars
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? Math.abs(c) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const value = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);

  const trend: RSIResult['trend'] =
    value > 55 ? 'bullish' :
    value < 45 ? 'bearish' : 'neutral';

  // Divergence: compare RSI direction vs price direction over last 5 bars
  // (only computed when we have enough bars)
  let divergence: RSIResult['divergence'] = 'none';
  const lookback = Math.min(5, Math.floor(bars.length / 2));
  if (bars.length >= lookback + period + 1) {
    const recentBars = bars.slice(-lookback - 1);
    const pastBars = bars.slice(-(lookback * 2) - 1, -lookback);

    // Compute RSI at lookback point using Wilder's on pastBars
    let pGain = 0, pLoss = 0;
    const pastChanges: number[] = [];
    for (let i = 1; i < pastBars.length; i++) {
      pastChanges.push(pastBars[i].close - pastBars[i - 1].close);
    }
    if (pastChanges.length >= period) {
      for (let i = 0; i < period; i++) {
        const c = pastChanges[i];
        if (c > 0) pGain += c; else pLoss += Math.abs(c);
      }
      pGain /= period; pLoss /= period;
      for (let i = period; i < pastChanges.length; i++) {
        const c = pastChanges[i];
        pGain = (pGain * (period - 1) + (c > 0 ? c : 0)) / period;
        pLoss = (pLoss * (period - 1) + (c < 0 ? Math.abs(c) : 0)) / period;
      }
      const pastRSI = pLoss === 0 ? 100 : 100 - 100 / (1 + pGain / pLoss);

      const priceUp = recentBars[recentBars.length - 1].close > pastBars[pastBars.length - 1].close;
      const rsiUp = value > pastRSI;

      if (priceUp && !rsiUp) divergence = 'bearish';      // price up, RSI down
      else if (!priceUp && rsiUp) divergence = 'bullish'; // price down, RSI up
    }
  }

  return {
    value: parseFloat(value.toFixed(2)),
    trend,
    overbought: value > 70,
    oversold: value < 30,
    divergence,
  };
}
