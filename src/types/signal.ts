import type { TradingProfile, Timeframe } from './market.js';
import type { TimeframeIndicators } from './indicators.js';

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

  triggeredBy: 'AUTO' | 'MANUAL';
  sessionId?: string;
  createdAt: string;
}
