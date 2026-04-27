export interface ConfidenceBreakdown {
  base: number;                    // 0.38 starting point (direction-neutral)
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
  recentPriceActionBonus: number;  // -0.15..+0.08 — last 3 LTF bars confirm or contradict signal direction (latest bar weighted heavily for reversal detection)
  trContractionPenalty: number;    // -0.08..0 — penalty when recent LTF True Range is contracting (momentum drying up)
  lowVolPenalty: number;           // -0.10..0 — penalty when HTF ADX is very low (no real trend, theta trap)
  moveExhaustionPenalty: number;   // -0.15..0 — penalty when a large directional move has already played out (chasing)
  consolidationPenalty: number;    // -0.10..0 — penalty when recent bars show sideways chop (high overlap, no trend)
  nearLevelPenalty: number;        // -0.10..0 — penalty for buying puts near support or calls near resistance
  thetaDecayPenalty: number;       // -0.10..0 — penalty for 0DTE entries late in the day when theta accelerates
  narrowRangePenalty: number;      // -0.12..0 — penalty when intraday range is small relative to ATR (choppy/range-bound day)
  candlePatternBonus: number;      // -0.08..+0.08 — leading: engulfing/hammer patterns at key levels (instant, no lag)
  priceVelocityBonus: number;      // -0.06..+0.08 — leading: raw price ROC + directional velocity (no smoothing)
  volumeSurgeBonus: number;        // 0..+0.06 — leading: volume surge detection (institutional activity)
  macdBonus: number;               // -0.06..+0.05 — MACD histogram alignment, crossover timing, divergence detection
  convergenceDurationBonus: number; // -0.04..+0.04 — convergence/divergence across MACD+OBV (price vs histogram agreement)
  trendPersistenceBonus: number;   // 0..+0.12 — consecutive same-direction aligned signals boost (market self-confirming)
  orderFlowBonus: number;          // -0.25..+0.25 — primary: order flow imbalance (causal, real-time); suppresses lagging penalties when confirming
  total: number;                   // clamped 0..1
}

/** Per-mode confidence scores — all 4 computed every tick for transparency. */
export interface ModeConfidences {
  trend: number;
  range: number;
  breakout: number;
  vwap_reversion: number;
}

export interface AnalysisResult {
  signalId: string;
  confidence: number;              // 0..1 deterministic (winning mode's score)
  confidenceBreakdown: ConfidenceBreakdown;
  /** All 4 mode confidences computed independently — for dashboard transparency. */
  allModeConfidences?: ModeConfidences;
  /** Which mode was selected by detectMode. */
  selectedMode?: string;
  meetsEntryThreshold: boolean;    // confidence >= 0.65
  /** Why entry was blocked — set when meetsEntryThreshold is false despite confidence >= threshold. */
  entryBlockReason?: string;
  aiExplanation: string;
  keyFactors: string[];
  risks: string[];
  desiredRight: 'call' | 'put' | null;
  rangeExhaustion?: number;        // (dayHigh - dayLow) / htfATR — how much of daily range is consumed
  /** True when LTF bars show a tight consolidation breakout in signal direction. */
  trendConsolidationBreakout?: boolean;
  /** ATR(5)/ATR(20) on 1-min LTF bars — fast vol-expansion indicator. */
  atrRatio?: number;
  createdAt: string;
}
