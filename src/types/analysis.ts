export interface ConfidenceBreakdown {
  base: number;                    // 0.40-0.45 starting point
  diSpreadBonus: number;           // 0..0.25
  adxBonus: number;                // 0 or +0.05
  diCrossBonus: number;            // -0.06..+0.06 — fresh DI crossover timing signal (HTF ±0.05, MTF ±0.03)
  alignmentBonus: number;          // 0, +0.02, +0.04, or +0.08
  tdAdjustment: number;            // -0.04..+0.05 — TD setup scoring (secondary: late-stage bonus, mild exhaustion penalty)
  obvBonus: number;                // -0.10..+0.10 — OBV trend confirmation or divergence penalty
  vwapBonus: number;               // -0.12..+0.10 — VWAP alignment + band extension penalty (ATR-adjusted in strong trends)
  oiVolumeBonus: number;           // 0..0.05 — triggered when option volume is extremely high
  pricePositionAdjustment: number; // -0.08..0 — penalty for trading against range position
  adxMaturityPenalty: number;      // -0.08..0 — penalty when HTF ADX has been above 25 for many bars
  trendPhaseBonus: number;         // -0.08..+0.06 — ADX slope: rising=growth phase bonus, falling=late phase penalty
  momentumAccelBonus: number;      // -0.06..+0.05 — DI spread velocity: widening=accelerating, narrowing=decelerating
  structureBonus: number;          // -0.08..+0.06 — prior day levels (PDH/PDL) alignment bonus/penalty
  orbBonus: number;                // -0.08..+0.06 — opening range breakout direction alignment
  total: number;                   // clamped 0..1
}

export interface AnalysisResult {
  signalId: string;
  confidence: number;              // 0..1 deterministic
  confidenceBreakdown: ConfidenceBreakdown;
  meetsEntryThreshold: boolean;    // confidence >= 0.65
  aiExplanation: string;
  keyFactors: string[];
  risks: string[];
  desiredRight: 'call' | 'put' | null;
  createdAt: string;
}
