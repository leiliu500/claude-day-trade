export type OptionSide = 'call' | 'put';

export interface OptionContract {
  symbol: string;           // OCC symbol e.g. SPY260223C00600000
  underlyingSymbol: string;
  expiration: string;       // YYYY-MM-DD
  strike: number;
  side: OptionSide;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  spreadPct: number;        // spread / mid * 100
  openInterest: number;
  volume: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  impliedVolatility?: number;
  lastTrade?: number;
  quoteAgeSeconds?: number;
}

export interface OptionScore {
  passesFilter: boolean;
  liquidityOk: boolean;
  sideMatchOk: boolean;
  rrRatio: number;
  spreadPct: number;
  openInterest: number;
  // Composite score: pass(1M) + liq(100K) + sideMatch(10K) + rrRank + spreadRank + oiRank
  totalScore: number;
  rejectionReason?: string;
}

export interface OptionCandidate {
  contract: OptionContract;
  score: OptionScore;
  entryPremium: number;     // mid at eval time
  stopPremium: number;      // entry - stopMult × optionATR (dynamic: 0.5–0.8 based on ADX)
  tpPremium: number;        // entry + tpMult × optionATR   (dynamic: 0.8–2.4 based on ADX)
  rrRatio: number;          // (tp - entry) / (entry - stop) — varies ~1.6–3.0 by trend strength
}

export interface OptionEvaluation {
  signalId: string;
  ticker: string;
  evaluatedAt: string;
  desiredSide: OptionSide | null;
  callCandidate: OptionCandidate | null;
  putCandidate: OptionCandidate | null;
  winner: OptionSide | null;
  winnerCandidate: OptionCandidate | null;
  selectionReason: string;
  liquidityOk: boolean;
  candidatePass: boolean;
}
