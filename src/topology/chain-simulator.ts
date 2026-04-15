/**
 * Option Chain Simulator — derives realistic option chain snapshots
 * from actual underlying price bars using Black-Scholes + flow dynamics.
 *
 * BEST PRACTICE: the simulated chain is causally driven by observed
 * price action, not random noise or fixed time rules.
 *
 *   1. IV from realized volatility — compute rolling realized vol from
 *      actual bars, then set IV at a realistic premium (IV/RV ratio ~1.1–1.3).
 *
 *   2. IV smile from Black-Scholes skew — OTM puts have higher IV (crash
 *      risk premium), OTM calls slightly lower (call overwriting supply).
 *      The smile curvature scales with realized vol.
 *
 *   3. Greeks from Black-Scholes — delta, gamma, theta, vega computed
 *      analytically.  These drive realistic volume distribution.
 *
 *   4. Volume from price dynamics — institutional flow follows price:
 *      - Sharp moves → directional sweeps (call volume on up-moves, put on down)
 *      - Consolidation → balanced volume, ATM-concentrated
 *      - Pullbacks in a trend → counter-trend hedging flow
 *      - Support/resistance touches → block trades at key strikes
 *
 *   5. OI from cumulative flow — open interest builds at strikes where
 *      volume has accumulated over the session.
 */

import type { OHLCVBar } from '../types/market.js';
import type { ChainContract } from './types.js';

// ── Black-Scholes ────────────────────────────────────────────────────────────

/** Standard normal CDF (Abramowitz & Stegun approximation). */
function normCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

interface BSResult {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/**
 * Black-Scholes pricing + greeks for European options.
 * @param S  Underlying price
 * @param K  Strike price
 * @param T  Time to expiry in years (e.g. 1/252 for 1 trading day)
 * @param r  Risk-free rate (annualized)
 * @param sigma  Implied volatility (annualized)
 * @param side  'call' or 'put'
 */
function blackScholes(S: number, K: number, T: number, r: number, sigma: number, side: 'call' | 'put'): BSResult {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    return { price: Math.max(0, side === 'call' ? S - K : K - S), delta: side === 'call' ? 1 : -1, gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const nd1 = normCDF(d1);
  const nd2 = normCDF(d2);
  const nNd1 = normCDF(-d1);
  const nNd2 = normCDF(-d2);
  const phiD1 = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI); // PDF at d1

  const discountFactor = Math.exp(-r * T);

  if (side === 'call') {
    return {
      price: S * nd1 - K * discountFactor * nd2,
      delta: nd1,
      gamma: phiD1 / (S * sigma * sqrtT),
      theta: (-(S * phiD1 * sigma) / (2 * sqrtT) - r * K * discountFactor * nd2) / 252,
      vega: S * phiD1 * sqrtT / 100, // per 1% IV change
    };
  } else {
    return {
      price: K * discountFactor * nNd2 - S * nNd1,
      delta: nd1 - 1,
      gamma: phiD1 / (S * sigma * sqrtT),
      theta: (-(S * phiD1 * sigma) / (2 * sqrtT) + r * K * discountFactor * nNd2) / 252,
      vega: S * phiD1 * sqrtT / 100,
    };
  }
}

// ── Realized volatility ──────────────────────────────────────────────────────

/** Compute annualized realized volatility from 1-min close prices. */
function realizedVol(bars: OHLCVBar[], lookback = 30): number {
  if (bars.length < lookback + 1) return 0.20; // default 20%
  const closes = bars.slice(-lookback - 1).map(b => b.close);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i]! / closes[i - 1]!));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  // Annualize: 1-min bars → sqrt(252 × 390) minutes per year
  return Math.sqrt(variance * 252 * 390);
}

// ── Price dynamics metrics ───────────────────────────────────────────────────

interface PriceDynamics {
  /** Price velocity: (close - close_N_bars_ago) / close, annualized-ish. */
  velocity: number;
  /** Absolute velocity — magnitude of move. */
  absVelocity: number;
  /** Direction: +1 bullish, -1 bearish, 0 flat. */
  direction: 1 | -1 | 0;
  /** Is price pulling back against the larger trend? */
  isPullback: boolean;
  /** Acceleration: velocity change (velocity now - velocity 5 bars ago). */
  acceleration: number;
  /** Nearest round-number strike (potential block level). */
  nearestRound: number;
  /** Distance to nearest round as fraction of ATR. */
  distToRound: number;
}

function computePriceDynamics(bars: OHLCVBar[], atr: number): PriceDynamics {
  const n = bars.length;
  const close = bars[n - 1]!.close;

  // Short-term velocity (5 bars)
  const shortLookback = Math.min(5, n - 1);
  const shortPrior = bars[n - 1 - shortLookback]!.close;
  const velocity = (close - shortPrior) / shortPrior;

  // Longer trend (30 bars)
  const longLookback = Math.min(30, n - 1);
  const longPrior = bars[n - 1 - longLookback]!.close;
  const trendDir = close > longPrior ? 1 : close < longPrior ? -1 : 0;

  // Pullback: short-term move opposes long-term trend
  const shortDir = velocity > 0.0005 ? 1 : velocity < -0.0005 ? -1 : 0;
  const isPullback = trendDir !== 0 && shortDir !== 0 && shortDir !== trendDir;

  // Acceleration
  const accelLookback = Math.min(5, n - 1 - shortLookback);
  let priorVelocity = 0;
  if (accelLookback > 0 && n > shortLookback + accelLookback) {
    const pClose = bars[n - 1 - shortLookback]!.close;
    const ppClose = bars[n - 1 - shortLookback - accelLookback]!.close;
    priorVelocity = (pClose - ppClose) / ppClose;
  }

  // Nearest round number ($5 increments for SPY-class)
  const roundInterval = close > 200 ? 5 : close > 50 ? 2 : 1;
  const nearestRound = Math.round(close / roundInterval) * roundInterval;
  const distToRound = atr > 0 ? Math.abs(close - nearestRound) / atr : 1;

  return {
    velocity,
    absVelocity: Math.abs(velocity),
    direction: shortDir as 1 | -1 | 0,
    isPullback,
    acceleration: velocity - priorVelocity,
    nearestRound,
    distToRound,
  };
}

// ── Volume model ─────────────────────────────────────────────────────────────

/**
 * Compute realistic volume distribution across strikes.
 *
 * Rules derived from market microstructure:
 *   - Base volume: gamma-weighted (ATM gets most volume — hedging activity)
 *   - Directional flow: sharp moves add volume in the move direction
 *     (calls on up-moves, puts on down-moves) at 1–5 OTM strikes
 *   - Pullback hedging: counter-trend puts/calls during pullbacks
 *   - Block trades: concentrated volume near round-number strikes
 *   - Acceleration: very fast moves create multi-strike sweeps
 */
function computeStrikeVolume(
  strike: number,
  side: 'call' | 'put',
  atm: number,
  dynamics: PriceDynamics,
  gamma: number,
  sessionVolume: number,
): number {
  const dist = strike - atm;
  const absDist = Math.abs(dist);

  // 1. Base: gamma-weighted (ATM peak, decay with distance)
  const gammaWeight = Math.max(0.05, gamma * 1000);
  let vol = sessionVolume * gammaWeight * Math.exp(-absDist * 0.15);

  // 2. Directional flow: fast moves → volume in the direction of the move
  if (dynamics.absVelocity > 0.001) {
    const isMoveDirection =
      (dynamics.direction > 0 && side === 'call' && dist > 0 && dist <= 8) ||
      (dynamics.direction < 0 && side === 'put' && dist < 0 && absDist <= 8);

    if (isMoveDirection) {
      // Scale: velocity 0.1% → 1x boost, 0.5% → 5x boost
      const boost = Math.min(5, dynamics.absVelocity * 5000);
      vol *= (1 + boost);

      // Acceleration → sweep across more strikes (wider boost)
      if (Math.abs(dynamics.acceleration) > 0.001 && absDist <= 5) {
        vol *= 1.5;
      }
    }
  }

  // 3. Pullback hedging: counter-trend flow at ATM±2
  if (dynamics.isPullback && absDist <= 2) {
    const hedgeSide = dynamics.direction > 0 ? 'put' : 'call'; // hedge against pullback
    if (side === hedgeSide) {
      vol *= 2.0;
    }
  }

  // 4. Block trades: round-number strikes get concentrated volume
  if (strike === dynamics.nearestRound && dynamics.distToRound < 0.5) {
    vol *= 2.5;
  }

  return Math.max(0, Math.round(vol));
}

// ── IV smile model ───────────────────────────────────────────────────────────

/**
 * Compute the IV for a specific strike.
 *
 * Model: ATM IV = realized vol × IV/RV ratio (1.1–1.3),
 * then apply the smile:
 *   - OTM puts: higher IV (crash risk premium), steeper when vol is high
 *   - OTM calls: slightly elevated (fat tails), less steep
 *   - Directional flow distortion: strikes with heavy flow get IV boost
 */
function computeStrikeIV(
  strike: number,
  side: 'call' | 'put',
  atm: number,
  atmIV: number,
  dynamics: PriceDynamics,
  strikeVolume: number,
  baseVolume: number,
): number {
  const moneyness = (strike - atm) / atm; // negative = OTM put / ITM call

  // Smile: quadratic + skew
  // Skew steepens with ATM IV (high vol = more crash fear)
  const skewCoeff = -0.15 * atmIV; // negative = puts more expensive
  const curvatureCoeff = 0.8 * atmIV; // smile curvature scales with vol
  let iv = atmIV + skewCoeff * moneyness + curvatureCoeff * moneyness * moneyness;

  // Flow-driven distortion: strikes with disproportionate volume get IV boost
  // This is the key mechanism — heavy buying pushes up IV at that strike
  if (baseVolume > 0 && strikeVolume > baseVolume * 2) {
    const flowPressure = Math.min(0.05, (strikeVolume / baseVolume - 2) * 0.01);
    iv += flowPressure;
  }

  // Pullback distortion: hedging demand elevates put IV during pullbacks
  if (dynamics.isPullback && side === 'put' && moneyness < 0) {
    iv += 0.02 * dynamics.absVelocity * 100;
  }

  return Math.max(0.05, iv);
}

// ── OI accumulation model ────────────────────────────────────────────────────

/** Persistent session OI state — accumulates across snapshots. */
const _sessionOI = new Map<string, Map<string, number>>();

function getSessionOI(ticker: string): Map<string, number> {
  let oi = _sessionOI.get(ticker);
  if (!oi) {
    oi = new Map();
    _sessionOI.set(ticker, oi);
  }
  return oi;
}

/** Reset session OI (call at start of new day). */
export function resetSessionOI(ticker: string): void {
  _sessionOI.delete(ticker);
}

// ── Main simulator ───────────────────────────────────────────────────────────

/**
 * Generate a realistic option chain snapshot from actual price bars.
 *
 * All data is derived from the observed bars — no random noise, no
 * fixed time rules.  The chain reflects what market microstructure
 * theory predicts given the observed price action.
 *
 * @param bars       Recent 1-min bars (need ≥50 for RV computation).
 * @param ticker     Ticker symbol (for session OI tracking).
 * @param expiry     Expiration date string (e.g. '2026-04-15').
 * @param strikeRange  Number of strikes above/below ATM (default 15).
 * @param riskFreeRate  Annualized risk-free rate (default 0.045 = 4.5%).
 */
export function simulateChain(
  bars: OHLCVBar[],
  ticker: string,
  expiry: string,
  strikeRange = 15,
  riskFreeRate = 0.045,
): { callChain: ChainContract[]; putChain: ChainContract[] } {
  const n = bars.length;
  const close = bars[n - 1]!.close;
  const atm = Math.round(close);

  // Realized vol → ATM IV (with typical IV/RV premium)
  const rv = realizedVol(bars, 30);
  const ivRvRatio = 1.15 + Math.min(0.15, rv * 0.3); // higher RV → higher premium
  const atmIV = rv * ivRvRatio;

  // Time to expiry (assuming next-day expiry, ~7 hours of trading left)
  const T = 1 / 252; // 1 trading day

  // ATR for scaling
  const atrBars = bars.slice(-14);
  let atrSum = 0;
  for (let i = 1; i < atrBars.length; i++) {
    const tr = Math.max(
      atrBars[i]!.high - atrBars[i]!.low,
      Math.abs(atrBars[i]!.high - atrBars[i - 1]!.close),
      Math.abs(atrBars[i]!.low - atrBars[i - 1]!.close),
    );
    atrSum += tr;
  }
  const atr = atrBars.length > 1 ? atrSum / (atrBars.length - 1) : close * 0.005;

  // Price dynamics
  const dynamics = computePriceDynamics(bars, atr);

  // Session volume baseline (scales with bar volume)
  const recentVol = bars.slice(-5).reduce((s, b) => s + b.volume, 0) / 5;
  const sessionVolume = recentVol * 0.001; // option vol is ~0.1% of equity vol

  // Session OI accumulator
  const oi = getSessionOI(ticker);

  const callChain: ChainContract[] = [];
  const putChain: ChainContract[] = [];

  // First pass: compute BS greeks and base volumes
  const strikeData: { strike: number; callBS: BSResult; putBS: BSResult; callVol: number; putVol: number }[] = [];

  for (let k = atm - strikeRange; k <= atm + strikeRange; k++) {
    const callIVGuess = computeStrikeIV(k, 'call', atm, atmIV, dynamics, 0, 1);
    const putIVGuess = computeStrikeIV(k, 'put', atm, atmIV, dynamics, 0, 1);

    const callBS = blackScholes(close, k, T, riskFreeRate, callIVGuess, 'call');
    const putBS = blackScholes(close, k, T, riskFreeRate, putIVGuess, 'put');

    const callVol = computeStrikeVolume(k, 'call', atm, dynamics, callBS.gamma, sessionVolume);
    const putVol = computeStrikeVolume(k, 'put', atm, dynamics, putBS.gamma, sessionVolume);

    strikeData.push({ strike: k, callBS, putBS, callVol, putVol });
  }

  // ATM base volume for IV distortion scaling
  const atmData = strikeData.find(d => d.strike === atm);
  const baseCallVol = atmData?.callVol ?? 1;
  const basePutVol = atmData?.putVol ?? 1;

  // Second pass: compute final IV (with flow distortion) and build contracts
  for (const sd of strikeData) {
    const callIV = computeStrikeIV(sd.strike, 'call', atm, atmIV, dynamics, sd.callVol, baseCallVol);
    const putIV = computeStrikeIV(sd.strike, 'put', atm, atmIV, dynamics, sd.putVol, basePutVol);

    // Reprice with distorted IV
    const callBS = blackScholes(close, sd.strike, T, riskFreeRate, callIV, 'call');
    const putBS = blackScholes(close, sd.strike, T, riskFreeRate, putIV, 'put');

    // Spread: tighter at ATM, wider OTM (proportional to 1/gamma)
    const callSpread = Math.max(0.01, 0.02 / Math.max(0.001, callBS.gamma * 100));
    const putSpread = Math.max(0.01, 0.02 / Math.max(0.001, putBS.gamma * 100));

    // Accumulate OI
    const callKey = `C${sd.strike}`;
    const putKey = `P${sd.strike}`;
    oi.set(callKey, (oi.get(callKey) ?? sd.callVol * 2) + Math.round(sd.callVol * 0.3));
    oi.set(putKey, (oi.get(putKey) ?? sd.putVol * 2) + Math.round(sd.putVol * 0.3));

    callChain.push({
      strike: sd.strike,
      expiration: expiry,
      side: 'call',
      volume: sd.callVol,
      openInterest: oi.get(callKey)!,
      iv: callIV,
      delta: callBS.delta,
      gamma: callBS.gamma,
      bid: Math.max(0, callBS.price - callSpread / 2),
      ask: callBS.price + callSpread / 2,
      mid: callBS.price,
    });

    putChain.push({
      strike: sd.strike,
      expiration: expiry,
      side: 'put',
      volume: sd.putVol,
      openInterest: oi.get(putKey)!,
      iv: putIV,
      delta: putBS.delta,
      gamma: putBS.gamma,
      bid: Math.max(0, putBS.price - putSpread / 2),
      ask: putBS.price + putSpread / 2,
      mid: putBS.price,
    });
  }

  return { callChain, putChain };
}
