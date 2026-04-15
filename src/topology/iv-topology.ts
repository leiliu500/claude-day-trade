/**
 * IV Surface Topology — curvature analysis of the implied volatility smile.
 *
 * The IV smile σ(K) is a 1D function of strike K for a given expiration.
 * It has a canonical shape (quadratic + skew) determined by supply/demand
 * equilibrium.  When institutional flow occurs at specific strikes, it
 * locally distorts the smile, creating curvature anomalies.
 *
 * Key invariants:
 *
 *   Discrete curvature κ(K):
 *     Second discrete derivative of σ(K).  The canonical smile has smooth,
 *     slowly-varying curvature.  Spikes in κ indicate flow at that strike.
 *
 *   Integrated absolute curvature:
 *     ∫|κ(K)| dK — total "bumpiness".  Low = canonical smile.
 *     High = multiple strikes with distorted IV = multi-point flow.
 *     This is a discrete analog of the Gauss-Bonnet theorem:
 *     total curvature is a topological invariant of the IV curve.
 *
 *   Skew slope:
 *     dσ/dK at ATM.  Steepening skew = directional hedging demand.
 *     Flattening = vol selling across strikes.
 *
 *   Residual Z-scores:
 *     Fit a smooth model (quadratic) to the smile.  Residuals at each
 *     strike measure how much the local IV deviates from the model.
 *     Large residuals = localized flow.  The direction (bid-side vs
 *     offer-side) distinguishes buying from selling.
 */

import type { ChainContract, IVTopology, IVAnomaly } from './types.js';

/**
 * Fit a quadratic smile model: σ(K) = a(K - K₀)² + b(K - K₀) + c
 * where K₀ is the ATM strike.  Returns coefficients [a, b, c].
 *
 * Uses least-squares regression.  The quadratic captures the smile shape;
 * the linear term captures the skew; the constant is ATM vol.
 */
function fitQuadraticSmile(
  strikes: number[],
  ivs: number[],
  atmStrike: number,
): [number, number, number] {
  const n = strikes.length;
  if (n < 3) return [0, 0, ivs[0] ?? 0];

  // Centered strikes: x = K - K₀
  const x = strikes.map(k => k - atmStrike);

  // Normal equations for y = ax² + bx + c
  let S0 = 0, Sx = 0, Sx2 = 0, Sx3 = 0, Sx4 = 0;
  let Sy = 0, Sxy = 0, Sx2y = 0;

  for (let i = 0; i < n; i++) {
    const xi = x[i]!, yi = ivs[i]!;
    const x2 = xi * xi;
    S0 += 1;
    Sx += xi;
    Sx2 += x2;
    Sx3 += x2 * xi;
    Sx4 += x2 * x2;
    Sy += yi;
    Sxy += xi * yi;
    Sx2y += x2 * yi;
  }

  // Solve 3×3 linear system via Cramer's rule
  //  | Sx4 Sx3 Sx2 |   | a |   | Sx2y |
  //  | Sx3 Sx2 Sx  | × | b | = | Sxy  |
  //  | Sx2 Sx  S0  |   | c |   | Sy   |
  const det =
    Sx4 * (Sx2 * S0 - Sx * Sx) -
    Sx3 * (Sx3 * S0 - Sx * Sx2) +
    Sx2 * (Sx3 * Sx - Sx2 * Sx2);

  if (Math.abs(det) < 1e-15) return [0, 0, Sy / S0];

  const a = (
    Sx2y * (Sx2 * S0 - Sx * Sx) -
    Sx3 * (Sxy * S0 - Sx * Sy) +
    Sx2 * (Sxy * Sx - Sx2 * Sy)
  ) / det;

  const b = (
    Sx4 * (Sxy * S0 - Sx * Sy) -
    Sx2y * (Sx3 * S0 - Sx * Sx2) +
    Sx2 * (Sx3 * Sy - Sxy * Sx2)
  ) / det;

  const c = (
    Sx4 * (Sx2 * Sy - Sx * Sxy) -
    Sx3 * (Sx3 * Sy - Sx * Sx2y) +
    Sx2y * (Sx3 * Sx - Sx2 * Sx2)
  ) / det;

  return [a, b, c];
}

/**
 * Compute discrete curvature at each interior strike.
 * κ(Kᵢ) = (σ(Kᵢ₊₁) - 2σ(Kᵢ) + σ(Kᵢ₋₁)) / (ΔK)²
 */
function discreteCurvature(
  strikes: number[],
  ivs: number[],
): { strike: number; curvature: number }[] {
  const result: { strike: number; curvature: number }[] = [];

  for (let i = 1; i < strikes.length - 1; i++) {
    const dk1 = strikes[i]! - strikes[i - 1]!;
    const dk2 = strikes[i + 1]! - strikes[i]!;
    const avgDk = (dk1 + dk2) / 2;
    if (avgDk <= 0) continue;

    const curvature = (ivs[i + 1]! - 2 * ivs[i]! + ivs[i - 1]!) / (avgDk * avgDk);
    result.push({ strike: strikes[i]!, curvature });
  }

  return result;
}

/**
 * Compute IV anomalies: strikes where IV deviates from the fitted smile.
 */
function detectAnomalies(
  contracts: ChainContract[],
  atmStrike: number,
  zThreshold = 1.5,
): IVAnomaly[] {
  if (contracts.length < 4) return [];

  const strikes = contracts.map(c => c.strike);
  const ivs = contracts.map(c => c.iv);

  // Fit quadratic smile
  const [a, b, c] = fitQuadraticSmile(strikes, ivs, atmStrike);

  // Compute residuals
  const residuals = contracts.map(contract => {
    const x = contract.strike - atmStrike;
    const modelIV = a * x * x + b * x + c;
    return {
      strike: contract.strike,
      side: contract.side,
      residual: contract.iv - modelIV,
      bid: contract.bid,
      ask: contract.ask,
      mid: contract.mid,
    };
  });

  // Compute standard deviation of residuals
  const mean = residuals.reduce((s, r) => s + r.residual, 0) / residuals.length;
  const variance = residuals.reduce((s, r) => s + (r.residual - mean) ** 2, 0) / residuals.length;
  const std = Math.sqrt(variance);
  if (std < 1e-10) return [];

  // Flag anomalies beyond z-threshold
  const anomalies: IVAnomaly[] = [];
  for (const r of residuals) {
    const zScore = (r.residual - mean) / std;
    if (Math.abs(zScore) >= zThreshold) {
      // Determine direction from bid-ask dynamics
      // If residual is positive (IV higher than model), it's demand-driven (buying)
      // If residual is negative (IV lower than model), it's supply-driven (selling)
      const direction: IVAnomaly['direction'] =
        r.residual > 0 ? 'bid_up' : r.residual < 0 ? 'offered_down' : 'neutral';

      anomalies.push({
        strike: r.strike,
        side: r.side,
        residual: r.residual,
        zScore,
        direction,
      });
    }
  }

  return anomalies;
}

/**
 * Compute the full IV surface topology.
 *
 * @param callChain  Call contracts sorted by strike.
 * @param putChain   Put contracts sorted by strike.
 * @param currentPrice  Current underlying price (for ATM reference).
 */
export function computeIVTopology(
  callChain: ChainContract[],
  putChain: ChainContract[],
  currentPrice: number,
): IVTopology {
  const atmStrike = Math.round(currentPrice);

  // Filter to contracts with valid IV
  const validCalls = callChain.filter(c => c.iv > 0 && c.iv < 5);
  const validPuts = putChain.filter(c => c.iv > 0 && c.iv < 5);

  // Discrete curvature per side
  const callStrikes = validCalls.map(c => c.strike);
  const callIVs = validCalls.map(c => c.iv);
  const putStrikes = validPuts.map(c => c.strike);
  const putIVs = validPuts.map(c => c.iv);

  const callCurvature = discreteCurvature(callStrikes, callIVs);
  const putCurvature = discreteCurvature(putStrikes, putIVs);

  // Integrated absolute curvature (total bumpiness)
  const callIntegratedCurvature = callCurvature.reduce(
    (s, c) => s + Math.abs(c.curvature), 0,
  );
  const putIntegratedCurvature = putCurvature.reduce(
    (s, c) => s + Math.abs(c.curvature), 0,
  );

  // Skew slope at ATM: dσ/dK using the two contracts nearest to ATM
  const callSkewSlope = computeSkewSlope(validCalls, atmStrike);
  const putSkewSlope = computeSkewSlope(validPuts, atmStrike);

  // Detect anomalies
  const callAnomalies = detectAnomalies(validCalls, atmStrike);
  const putAnomalies = detectAnomalies(validPuts, atmStrike);
  const anomalies = [...callAnomalies, ...putAnomalies];

  return {
    callCurvature,
    putCurvature,
    callIntegratedCurvature,
    putIntegratedCurvature,
    callSkewSlope,
    putSkewSlope,
    anomalies,
  };
}

/**
 * Compute the skew slope dσ/dK at the ATM strike using finite differences.
 */
function computeSkewSlope(contracts: ChainContract[], atmStrike: number): number {
  if (contracts.length < 2) return 0;

  // Find the two contracts nearest to ATM
  const sorted = [...contracts].sort(
    (a, b) => Math.abs(a.strike - atmStrike) - Math.abs(b.strike - atmStrike),
  );

  const c1 = sorted[0]!;
  const c2 = sorted[1]!;
  const dk = c2.strike - c1.strike;
  if (Math.abs(dk) < 0.01) return 0;

  return (c2.iv - c1.iv) / dk;
}
