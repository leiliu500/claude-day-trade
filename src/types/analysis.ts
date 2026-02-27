export interface ConfidenceBreakdown {
  base: number;           // 0.40-0.45 starting point
  diSpreadBonus: number;  // 0..0.25
  adxBonus: number;       // 0 or +0.05
  alignmentBonus: number; // 0, +0.02, +0.05, or +0.10
  tdAdjustment: number;   // -0.05..+0.03
  oiVolumeBonus: number;  // 0..0.05 — triggered when option volume is extremely high
  total: number;          // clamped 0..1
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
