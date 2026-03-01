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
    implied_volatility?: number;
  };
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

export class OptionAgent {
  private headers: Record<string, string>;

  constructor() {
    this.headers = {
      'APCA-API-KEY-ID': config.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
    };
  }

  async run(signal: SignalPayload): Promise<OptionEvaluation> {
    const desiredSide: OptionSide = signal.direction === 'bearish' ? 'put' : 'call';
    const expiry = getNextBusinessDay();
    const strikeMin = signal.atm - 10;
    const strikeMax = signal.atm + 10;

    // Fetch CALL + PUT contracts in parallel
    const [callContracts, putContracts] = await Promise.all([
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

    // Compare candidates — pick winner by total score
    const winner = this.pickWinner(callCandidate, putCandidate);

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

    const res = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];

    const data = (await res.json()) as { option_contracts?: AlpacaOptionContract[] };
    return data.option_contracts ?? [];
  }

  private async fetchSnapshots(symbols: string[]): Promise<Record<string, AlpacaOptionSnapshot>> {
    if (symbols.length === 0) return {};

    const url = new URL(`${config.ALPACA_DATA_URL}/v1beta1/options/snapshots`);
    url.searchParams.set('symbols', symbols.join(','));
    url.searchParams.set('feed', 'indicative');

    const res = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return {};

    const data = (await res.json()) as { snapshots?: Record<string, AlpacaOptionSnapshot> };
    return data.snapshots ?? {};
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
      impliedVolatility: snap?.greeks?.implied_volatility,
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
    const optionAtr = signal.atr * Math.abs(contract.delta ?? 0.5);
    let rrRatio = 0;
    if (optionAtr > 0 && contract.mid > 0) {
      const stopDist = 0.8 * optionAtr;
      const tpDist   = 1.6 * optionAtr;
      rrRatio = tpDist / stopDist; // = 2.0 (fixed ratio, sanity check vs premium)
      if (contract.mid - stopDist <= 0) rrRatio = 0;
    }

    // Rank scores (lower raw value = higher rank score for spread/OI)
    const rrRank = Math.min(Math.round(rrRatio * 100), 9999);
    const spreadRank = Math.max(0, 100 - Math.round(contract.spreadPct * 10));
    const oiRank = Math.min(contract.openInterest, 9999);

    // Lexicographic composite score
    const totalScore =
      (passesFilter ? 1_000_000 : 0) +
      (liquidityOk ? 100_000 : 0) +
      (sideMatchOk ? 10_000 : 0) +
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
    const optionAtr = signal.atr * Math.abs(contract.delta ?? 0.5);
    const stop = Math.max(0.01, entry - 0.8 * optionAtr);
    const tp   = entry + 1.6 * optionAtr;

    const rrRatio = entry - stop > 0 ? (tp - entry) / (entry - stop) : 0;

    return { contract, score, entryPremium: entry, stopPremium: stop, tpPremium: tp, rrRatio };
  }

  private selectBestCandidate(
    contracts: OptionContract[],
    signal: SignalPayload,
    desiredSide: OptionSide
  ): OptionCandidate | null {
    if (contracts.length === 0) return null;

    const scored = contracts.map(c => {
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
  ): OptionCandidate | null {
    if (!call && !put) return null;
    if (!call) return put;
    if (!put) return call;

    // Winner: higher totalScore (desiredSide match is already baked in)
    return call.score.totalScore >= put.score.totalScore ? call : put;
  }

  private buildSelectionReason(
    call: OptionCandidate | null,
    put: OptionCandidate | null,
    winner: OptionCandidate
  ): string {
    const side = winner.contract.side.toUpperCase();
    if (!call || !put) return `Only ${side} candidate available`;

    if (call.score.totalScore > put.score.totalScore) {
      return `CALL score ${call.score.totalScore} > PUT score ${put.score.totalScore} — CALL wins`;
    }
    return `PUT score ${put.score.totalScore} >= CALL score ${call.score.totalScore} — PUT wins`;
  }
}
