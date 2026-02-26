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
    confirmationCount: number;
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
    grade: string;
    score: number;
    lessonsLearned: string;
    outcome: string;
    evaluatedAt: string;
  }>;
  accountBuyingPower: number;
  accountEquity: number;
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
