import { config } from '../config.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionContract, OptionCandidate, OptionEvaluation, OptionScore, OptionSide } from '../types/options.js';

// Alpaca option contract response shape
interface AlpacaOptionContract {
  id: string;
  symbol: string;
  underlying_symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
}

interface AlpacaOptionSnapshot {
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    rho?: number;
  };
  impliedVolatility?: number;
  latestQuote?: {
    ap?: number;  // ask
    bp?: number;  // bid
    as?: number;  // ask size
    bs?: number;  // bid size
    t?: string;   // timestamp
  };
  latestTrade?: {
    p?: number;  // price
    s?: number;  // size
    t?: string;
  };
  dailyBar?: {
    v?: number;  // volume
    o?: number;
  };
  openInterest?: number;
}

// ── Fill-failure blacklist ────────────────────────────────────────────────────
// Symbols that timed out waiting for fill are blacklisted for the session.
// Prevents the selector from re-picking a contract whose OPRA quote is stale
// (limit price consistently below the real ask → never fills).
const _fillBlacklist = new Map<string, number>(); // symbol → timestamp

/** Blacklist a symbol after fill timeout. Expires after 30 min. */
export function blacklistSymbol(symbol: string): void {
  _fillBlacklist.set(symbol, Date.now());
  console.log(`[OptionAgent] Blacklisted ${symbol} after fill timeout (30 min cooldown)`);
}

/** Check if a symbol is currently blacklisted. */
export function isBlacklisted(symbol: string): boolean {
  const ts = _fillBlacklist.get(symbol);
  if (!ts) return false;
  if (Date.now() - ts > 30 * 60_000) {
    _fillBlacklist.delete(symbol);
    return false;
  }
  return true;
}

/** Fetch next-business-day date */
function getNextBusinessDay(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  // Skip weekends
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split('T')[0]!;
}

/** Parse quote age in seconds */
function quoteAgeSeconds(timestamp?: string): number {
  if (!timestamp) return 999;
  return (Date.now() - new Date(timestamp).getTime()) / 1000;
}

/**
 * Dynamic stop/TP multipliers based on HTF ADX trend strength.
 *
 *   Strong trend  (ADX > 30): wider TP, standard stop  → higher R:R (~3.0)
 *     — trend has room to run; don't cap the upside too early.
 *   Moderate trend (ADX 20–30): standard multipliers   → balanced R:R (~2.0)
 *     — default behavior, reasonable in directional moves.
 *   Weak/range    (ADX < 20): tighter stop AND tighter TP → lower R:R (~1.6)
 *     — choppy market; take smaller wins, limit losses quickly.
 *
 * Returns { stopMult, tpMult } as multipliers of optionATR.
 */
function dynamicRRMultipliers(signal: SignalPayload): { stopMult: number; tpMult: number } {
  // Breakout mode: wider stop (room for retest), wide TP (catch the move)
  // R:R ≈ 2.5 — breakouts need room but have strong directional potential
  if (signal.signalMode === 'breakout') {
    return { stopMult: 0.7, tpMult: 1.8 };
  }

  const htf = signal.timeframes[signal.timeframes.length - 1];
  const adx = htf?.dmi.adx ?? 20;

  if (adx > 30) {
    // Strong trend: standard stop (0.8), wide TP (2.4) → R:R ≈ 3.0
    return { stopMult: 0.8, tpMult: 2.4 };
  }
  if (adx >= 20) {
    // Moderate trend: standard stop (0.8), standard TP (1.6) → R:R ≈ 2.0
    return { stopMult: 0.8, tpMult: 1.6 };
  }
  // Weak/range: tight stop (0.5), tight TP (0.8) → R:R ≈ 1.6
  return { stopMult: 0.5, tpMult: 0.8 };
}

export class OptionAgent {
  private headers: Record<string, string>;

  constructor() {
    this.headers = {
      'APCA-API-KEY-ID': config.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
    };
  }

  /**
   * Pre-fetch option contracts using an estimated ATM price.
   * Called in parallel with signal computation to reduce pipeline lag.
   * Uses a wider strike range (+/-15 vs +/-10) to account for ATM drift.
   */
  async prefetchContracts(
    ticker: string,
    estimatedAtm: number,
  ): Promise<{ callContracts: AlpacaOptionContract[]; putContracts: AlpacaOptionContract[] }> {
    const expiry = getNextBusinessDay();
    const strikeMin = estimatedAtm - 15;
    const strikeMax = estimatedAtm + 15;
    const [callContracts, putContracts] = await Promise.all([
      this.fetchContracts(ticker, 'call', expiry, strikeMin, strikeMax),
      this.fetchContracts(ticker, 'put', expiry, strikeMin, strikeMax),
    ]);
    return { callContracts, putContracts };
  }

  async run(
    signal: SignalPayload,
    prefetched?: { callContracts: AlpacaOptionContract[]; putContracts: AlpacaOptionContract[] },
  ): Promise<OptionEvaluation> {
    const desiredSide: OptionSide = signal.direction === 'bearish' ? 'put' : 'call';
    const expiry = getNextBusinessDay();
    const strikeMin = signal.atm - 10;
    const strikeMax = signal.atm + 10;

    // Use prefetched contracts if available, otherwise fetch now
    const [callContracts, putContracts] = prefetched
      ? [prefetched.callContracts, prefetched.putContracts]
      : await Promise.all([
          this.fetchContracts(signal.ticker, 'call', expiry, strikeMin, strikeMax),
          this.fetchContracts(signal.ticker, 'put', expiry, strikeMin, strikeMax),
        ]);

    // Shortlist: take up to 8 nearest ATM strikes per side
    const callShortlist = this.shortlistByATM(callContracts, signal.atm, 8);
    const putShortlist = this.shortlistByATM(putContracts, signal.atm, 8);

    // Fetch snapshots for shortlisted contracts
    const allSymbols = [
      ...callShortlist.map(c => c.symbol),
      ...putShortlist.map(c => c.symbol),
    ];

    const snapshots = allSymbols.length > 0
      ? await this.fetchSnapshots(allSymbols)
      : {};

    // Enrich contracts with snapshot data
    const callEnriched = callShortlist.map(c => this.enrichContract(c, snapshots[c.symbol]));
    const putEnriched = putShortlist.map(c => this.enrichContract(c, snapshots[c.symbol]));

    // Score and select best candidate per side
    const callCandidate = this.selectBestCandidate(callEnriched, signal, desiredSide);
    const putCandidate = this.selectBestCandidate(putEnriched, signal, desiredSide);

    // Compare candidates — prefer desired side if it passes filter
    const winner = this.pickWinner(callCandidate, putCandidate, desiredSide);

    return {
      signalId: signal.id,
      ticker: signal.ticker,
      evaluatedAt: new Date().toISOString(),
      desiredSide,
      callCandidate,
      putCandidate,
      winner: winner?.contract.side ?? null,
      winnerCandidate: winner,
      selectionReason: winner ? this.buildSelectionReason(callCandidate, putCandidate, winner) : 'No valid candidates found',
      liquidityOk: winner?.score.liquidityOk ?? false,
      candidatePass: winner !== null,
    };
  }

  private async fetchContracts(
    ticker: string,
    side: OptionSide,
    expiry: string,
    strikeMin: number,
    strikeMax: number
  ): Promise<AlpacaOptionContract[]> {
    const url = new URL(`${config.ALPACA_BASE_URL}/v2/options/contracts`);
    url.searchParams.set('underlying_symbols', ticker);
    url.searchParams.set('type', side);
    url.searchParams.set('expiration_date_gte', expiry);
    url.searchParams.set('expiration_date_lte', expiry);
    url.searchParams.set('strike_price_gte', String(strikeMin));
    url.searchParams.set('strike_price_lte', String(strikeMax));
    url.searchParams.set('limit', '50');

    try {
      const res = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { option_contracts?: AlpacaOptionContract[] };
      return data.option_contracts ?? [];
    } catch (err) {
      console.warn(`[OptionAgent] fetchContracts network error for ${ticker} ${side}: ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchSnapshots(symbols: string[]): Promise<Record<string, AlpacaOptionSnapshot>> {
    if (symbols.length === 0) return {};

    const url = new URL(`${config.ALPACA_DATA_URL}/v1beta1/options/snapshots`);
    url.searchParams.set('symbols', symbols.join(','));
    url.searchParams.set('feed', 'opra'); // real-time OPRA feed (Algo Trader Plus)

    try {
      const res = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return {};
      const data = (await res.json()) as { snapshots?: Record<string, AlpacaOptionSnapshot> };
      return data.snapshots ?? {};
    } catch (err) {
      console.warn(`[OptionAgent] fetchSnapshots network error (${symbols.length} symbols): ${(err as Error).message}`);
      return {};
    }
  }

  private shortlistByATM(
    contracts: AlpacaOptionContract[],
    atm: number,
    count: number
  ): AlpacaOptionContract[] {
    return contracts
      .sort((a, b) => Math.abs(parseFloat(a.strike_price) - atm) - Math.abs(parseFloat(b.strike_price) - atm))
      .slice(0, count);
  }

  private enrichContract(raw: AlpacaOptionContract, snap?: AlpacaOptionSnapshot): OptionContract {
    const bid = snap?.latestQuote?.bp ?? 0;
    const ask = snap?.latestQuote?.ap ?? 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const spread = ask - bid;
    const spreadPct = mid > 0 ? (spread / mid) * 100 : 999;

    return {
      symbol: raw.symbol,
      underlyingSymbol: raw.underlying_symbol,
      expiration: raw.expiration_date,
      strike: parseFloat(raw.strike_price),
      side: raw.type,
      bid,
      ask,
      mid,
      spread,
      spreadPct,
      openInterest: snap?.openInterest ?? 0,
      volume: snap?.dailyBar?.v ?? 0,
      delta: snap?.greeks?.delta,
      gamma: snap?.greeks?.gamma,
      theta: snap?.greeks?.theta,
      vega: snap?.greeks?.vega,
      impliedVolatility: snap?.impliedVolatility,
      lastTrade: snap?.latestTrade?.p,
      quoteAgeSeconds: quoteAgeSeconds(snap?.latestQuote?.t),
    };
  }

  private scoreContract(contract: OptionContract, signal: SignalPayload, desiredSide: OptionSide): OptionScore {
    // Basic filter
    const passesFilter = contract.mid > 0 && contract.quoteAgeSeconds! < 120;
    const liquidityOk = contract.spreadPct <= config.MAX_SPREAD_PCT * 100;
    const sideMatchOk = contract.side === desiredSide;

    // R:R computation using ATR scaled to option-premium units via delta.
    // Underlying ATR × |delta| converts the underlying move to an expected premium move.
    // Fallback delta = 0.5 (ATM assumption) when Greeks are unavailable.
    // Stop/TP multipliers adapt to HTF ADX trend strength (see dynamicRRMultipliers).
    const optionAtr = signal.atr * Math.abs(contract.delta ?? 0.5);
    const { stopMult, tpMult } = dynamicRRMultipliers(signal);
    let rrRatio = 0;
    if (optionAtr > 0 && contract.mid > 0) {
      // Use the same trailing-stop floor as buildCandidate so R:R reflects the real stop
      const atrStopDist = stopMult * optionAtr;
      const trailingStopDist = contract.mid * 0.13; // entry × 0.87 → distance = entry × 0.13
      const stopDist = Math.max(atrStopDist, trailingStopDist);
      const tpDist   = tpMult * optionAtr;
      rrRatio = stopDist > 0 ? tpDist / stopDist : 0;
      if (contract.mid - stopDist <= 0) rrRatio = 0;
    }

    // Leverage penalty: deep ITM options have high premium but low percentage moves,
    // making them poor day-trading candidates. Measure leverage as expected TP move
    // relative to premium paid — near-ATM options score much higher.
    // A $0.80 option with $0.40 expected move = 50% leverage; a $9.30 option with
    // $0.72 expected move = 7.7% leverage. Penalize low-leverage contracts heavily.
    const tpMove = tpMult * optionAtr;
    const leveragePct = contract.mid > 0 ? (tpMove / contract.mid) * 100 : 0;
    // Scale: 0-100 rank. Near-ATM with 30%+ leverage gets full marks; deep ITM <10% gets near-zero.
    const leverageRank = Math.min(Math.round(leveragePct * 3), 100);

    // Rank scores (lower raw value = higher rank score for spread/OI)
    const rrRank = Math.min(Math.round(rrRatio * 100), 9999);
    const spreadRank = Math.max(0, 100 - Math.round(contract.spreadPct * 10));
    const oiRank = Math.min(contract.openInterest, 9999);

    // Lexicographic composite score — leverage outweighs R:R and liquidity subcomponents
    const totalScore =
      (passesFilter ? 1_000_000 : 0) +
      (liquidityOk ? 100_000 : 0) +
      (sideMatchOk ? 10_000 : 0) +
      leverageRank * 100 +   // 0-10,000: dominates R:R/spread/OI within same tier
      rrRank +
      spreadRank +
      oiRank;

    const rejectionReason = !passesFilter
      ? (contract.mid === 0 ? 'No quote' : 'Quote too stale')
      : !liquidityOk
        ? `Spread ${contract.spreadPct.toFixed(2)}% > ${(config.MAX_SPREAD_PCT * 100).toFixed(0)}%`
        : undefined;

    return { passesFilter, liquidityOk, sideMatchOk, rrRatio, spreadPct: contract.spreadPct, openInterest: contract.openInterest, totalScore, rejectionReason };
  }

  private buildCandidate(contract: OptionContract, score: OptionScore, signal: SignalPayload): OptionCandidate {
    const entry = contract.mid;

    // Scale underlying ATR to option-premium units via |delta| (fallback 0.5 for ATM).
    // Stop/TP multipliers adapt to HTF ADX trend strength.
    const optionAtr = signal.atr * Math.abs(contract.delta ?? 0.5);
    const { stopMult, tpMult } = dynamicRRMultipliers(signal);
    // Floor: initial stop must never be tighter than the trailing stop's starting level
    // (entry × 0.87). Otherwise the DB stop overrides the trailing stop via Math.max()
    // in order-agent, causing hair-trigger exits on low-ATR entries.
    const atrStop = entry - stopMult * optionAtr;
    const trailingFloor = entry * 0.87;
    const stop = Math.max(0.01, Math.min(atrStop, trailingFloor));
    const tp   = entry + tpMult * optionAtr;

    const rrRatio = entry - stop > 0 ? (tp - entry) / (entry - stop) : 0;

    return { contract, score, entryPremium: entry, stopPremium: stop, tpPremium: tp, rrRatio };
  }

  private selectBestCandidate(
    contracts: OptionContract[],
    signal: SignalPayload,
    desiredSide: OptionSide
  ): OptionCandidate | null {
    // Filter out blacklisted symbols (fill timeout → stale OPRA data)
    const eligible = contracts.filter(c => !isBlacklisted(c.symbol));
    if (eligible.length === 0) return null;

    const scored = eligible.map(c => {
      const score = this.scoreContract(c, signal, desiredSide);
      return this.buildCandidate(c, score, signal);
    });

    scored.sort((a, b) => b.score.totalScore - a.score.totalScore);
    const best = scored[0];
    if (!best || !best.score.passesFilter) return null;
    return best;
  }

  private pickWinner(
    call: OptionCandidate | null,
    put: OptionCandidate | null,
    desiredSide: OptionSide,
  ): OptionCandidate | null {
    if (!call && !put) return null;
    if (!call) return put;
    if (!put) return call;

    // Always prefer the desired side if it passes the basic filter,
    // so liquidity on the wrong side can't override direction.
    const desired = desiredSide === 'call' ? call : put;
    const other = desiredSide === 'call' ? put : call;
    if (desired.score.passesFilter) return desired;
    return other;
  }

  private buildSelectionReason(
    call: OptionCandidate | null,
    put: OptionCandidate | null,
    winner: OptionCandidate
  ): string {
    const side = winner.contract.side.toUpperCase();
    if (!call || !put) return `Only ${side} candidate available`;
    return `Desired side is ${side} — preferred over score (liq: CALL=${call.score.liquidityOk ? 1 : 0} vs PUT=${put.score.liquidityOk ? 1 : 0})`;
  }
}
