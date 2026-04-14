import type { TradingProfile, Timeframe } from './market.js';
import type { TimeframeIndicators, PriorDayLevels, ORBResult, OrderFlowResult } from './indicators.js';

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';
export type AlignmentType = 'all_aligned' | 'htf_mtf_aligned' | 'mtf_ltf_aligned' | 'mixed';

export interface SignalPayload {
  id: string;
  ticker: string;
  profile: TradingProfile;
  timeframes: TimeframeIndicators[];  // [LTF, MTF, HTF]
  ltf: Timeframe;
  mtf: Timeframe;
  htf: Timeframe;

  // Synthesized across all TFs
  direction: SignalDirection;
  alignment: AlignmentType;
  currentPrice: number;
  atr: number;                // ATR from HTF (for stop/TP sizing)
  atm: number;                // ATM strike (rounded to nearest 1.0)
  strengthScore: number;      // 0–100 numeric trend strength (ADX-based, for Telegram display)

  // Market structure signals
  priorDayLevels: PriorDayLevels;   // PDH / PDL / PDC from yesterday's completed session
  orb: ORBResult;                   // Opening range breakout (9:30–10:00 ET)

  // Early reversal override: LTF crossed opposite to majority while HTF fading + range extreme.
  reversalOverride?: boolean;

  // Leading signal override: direction was determined (or confirmed) by leading indicators
  // (price velocity + volume-confirmed candle patterns) rather than lagged DMI alone.
  // When true, the analysis agent lowers the entry threshold from 0.65 to 0.60.
  leadingSignalOverride?: boolean;

  // Signal mode: trend (default), range (mean-reversion), breakout (squeeze), or vwap_reversion.
  signalMode?: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none';
  rangeSupport?: number;     // identified support level for range trade
  rangeResistance?: number;  // identified resistance level for range trade
  breakoutLevel?: number;    // swing high/low that price broke through
  breakoutBeyond?: number;   // how far price is beyond breakout level (% of price)
  vwapReversionTarget?: number;  // VWAP price (target for reversion)
  vwapDistance?: number;         // % distance from VWAP at entry

  // Order flow microstructure (from SIP trade + quote streams)
  orderFlow?: OrderFlowResult;

  triggeredBy: 'AUTO' | 'MANUAL';
  sessionId?: string;
  createdAt: string;
}
