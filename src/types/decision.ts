export type DecisionType =
  | 'NEW_ENTRY'
  | 'CONFIRM_HOLD'
  | 'ADD_POSITION'
  | 'REDUCE_EXPOSURE'
  | 'REVERSE'
  | 'EXIT'
  | 'WAIT';

export interface OpenPositionSummary {
  id: string;
  optionSymbol: string;
  side: 'call' | 'put';
  qty: number;
  entryPrice: number;
  currentStop?: number;
  currentTp?: number;
  openedAt: string;
  confirmationCount: number;
}

export interface PositionContext {
  openPositions: OpenPositionSummary[];
  brokerPositions: unknown[];
  brokerOpenOrders: unknown[];
  recentDecisions: Array<{
    decisionType: DecisionType;
    ticker: string;
    direction: string | null;
    confirmationCount: number;
    orchestrationConfidence: number;
    createdAt: string;
    reasoning: string;
  }>;
  confirmationStreaks: Array<{
    decisionId: string;
    confirmCount: number;
    contradictCount: number;
    totalCount: number;
  }>;
  recentEvaluations: Array<{
    ticker: string;
    optionRight: string | null;
    grade: string;
    score: number;
    outcome: string;
    pnlTotal: number | null;
    holdDurationMin: number | null;
    signalQuality: string | null;
    timingQuality: string | null;
    riskManagementQuality: string | null;
    lessonsLearned: string;
    evaluatedAt: string;
  }>;
  accountBuyingPower: number;
  accountEquity: number;
  dailyRealizedPnl: number;
  /** Total option premium (entry_price × qty × 100) deployed today across all tickers. */
  dailyPremiumDeployed: number;
  /**
   * Most recent loss/profit-stop exit for this ticker, or null if none in the last 5 min.
   * Used by the entry gate to disqualify bypass paths on same-direction re-entries that
   * would otherwise fire seconds after a velocity-stop, trailing-stop, or stop-hit exit.
   * (Field name retained for compatibility — covers all suppression-eligible reasons.)
   */
  lastTrailingStopExit: {
    closedAt: string;
    direction: 'bullish' | 'bearish';
    closeReason: string;
  } | null;
}

export interface EntryStrategy {
  stage: 'OBSERVE' | 'BUILDING_CONVICTION' | 'CONFIRMED_ENTRY' | 'OVERRIDE_ENTRY' | 'NOT_APPLICABLE';
  confirmationCount: number;
  signalDirection: 'call' | 'put' | null;
  confirmationsNeeded: number;
  overrideTriggered: boolean;
  notes: string;
}

export interface DecisionResult {
  id: string;
  signalId: string;
  sessionId?: string;
  decisionType: DecisionType;
  ticker: string;
  profile: string;
  direction?: string;
  confirmationCount: number;
  orchestrationConfidence: number;
  reasoning: string;
  urgency: 'immediate' | 'standard' | 'low';
  shouldExecute: boolean;
  entryStrategy?: EntryStrategy;
  riskNotes?: string;
  streakContext?: string;
  createdAt: string;
}
