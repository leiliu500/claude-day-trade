export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected' | 'accepted';
export type TradeLetter = 'A' | 'B' | 'C' | 'D' | 'F';
export type ConvictionTier = 'REGULAR' | 'SIZABLE' | 'MAX_CONVICTION';

export interface OrderRecord {
  id: string;
  positionId?: string;
  decisionId?: string;   // optional — monitor-triggered exits have no decision
  ticker: string;
  optionSymbol: string;
  alpacaOrderId?: string;
  alpacaStatus?: string;
  orderSide: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  positionIntent?: string;
  submittedQty: number;
  filledQty: number;
  submittedPrice?: number;
  fillPrice?: number;
  errorMessage?: string;
  submittedAt: string;
  filledAt?: string;
}

export interface SizeResult {
  qty: number;
  convictionScore: number;
  convictionTier: ConvictionTier;
  baseRiskUsd: number;
  effectiveRiskUsd: number;
  riskPerContract: number;
  limitPrice: number;
}

export interface EvaluationRecord {
  id: string;
  positionId?: string;
  decisionId?: string;
  ticker: string;
  optionSymbol: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlTotal: number;
  pnlPerContract: number;
  pnlPct: number;
  holdDurationMin: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  grade: TradeLetter;
  score: number;
  outcomeSummary?: string;
  signalQuality: string;
  timingQuality: string;
  riskManagementQuality: string;
  critique?: string;
  lessonsLearned: string;
  whatWentRight: string[];   // maps to what_went_well from AI prompt
  whatWentWrong: string[];
  wouldTakeAgain?: boolean;
  improvementSuggestions?: string[];
  evaluatedAt: string;
}
