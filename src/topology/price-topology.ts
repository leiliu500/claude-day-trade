/**
 * Price Topology — topological analysis of the price attractor.
 *
 * Uses Takens' delay embedding theorem to reconstruct the dynamical
 * attractor of the price process from scalar observations (closes),
 * then computes persistent homology to extract regime-invariant
 * structural features:
 *
 *   H0 (connected components):
 *     β₀ = 1  → single regime (trending or ranging)
 *     β₀ ≥ 2  → price attractor has fragmented (regime transition)
 *     Persistence of H0 features → regime stability
 *
 *   H1 (loops / cycles):
 *     Large H1 persistence → strong cyclical structure (mean reversion)
 *     No H1 features → no recurrence (trending or random walk)
 *     H1 birth scale → cycle amplitude; H1 death scale → noise threshold
 *
 * The persistence diagram is a complete topological invariant:
 * it captures all structural features at all scales simultaneously,
 * unlike any fixed-window indicator.
 */

import { computePersistentHomology, bottleneckDistance } from './persistent-homology.js';
import type { PriceTopology, PriceRegime, PersistenceDiagram, PersistencePair } from './types.js';
import type { OHLCVBar } from '../types/market.js';

// ── Takens delay embedding ──────────────────────────────────────────────────

/**
 * Embed a scalar time series into R^d via Takens' delay coordinates.
 *
 * Given series x(t), produces points:
 *   p(t) = [x(t), x(t-τ), x(t-2τ), ..., x(t-(d-1)τ)]
 *
 * By Whitney's embedding theorem, d = 2n+1 suffices where n is the
 * fractal dimension of the attractor.  Financial time series have
 * n ≈ 1.2–1.8, so d = 3 or 4 is sufficient.
 *
 * @param series  Scalar time series (e.g., close prices).
 * @param dim     Embedding dimension (default 3).
 * @param tau     Delay in time steps (default 1).
 * @returns Point cloud in R^d.
 */
export function takensEmbedding(
  series: number[],
  dim = 3,
  tau = 1,
): number[][] {
  const n = series.length;
  const offset = (dim - 1) * tau;
  if (n <= offset) return [];

  const points: number[][] = [];
  for (let t = offset; t < n; t++) {
    const point: number[] = [];
    for (let d = 0; d < dim; d++) {
      point.push(series[t - d * tau]!);
    }
    points.push(point);
  }
  return points;
}

/**
 * Normalize a point cloud to zero mean, unit variance per coordinate.
 * Makes topology scale-invariant and comparable across tickers/periods.
 */
function normalizePointCloud(points: number[][]): number[][] {
  if (points.length === 0) return [];
  const d = points[0]!.length;

  // Compute mean and std per dimension
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);

  for (const p of points) {
    for (let i = 0; i < d; i++) mean[i] += p[i]!;
  }
  for (let i = 0; i < d; i++) mean[i] /= points.length;

  for (const p of points) {
    for (let i = 0; i < d; i++) {
      const diff = p[i]! - mean[i]!;
      std[i] += diff * diff;
    }
  }
  for (let i = 0; i < d; i++) {
    std[i] = Math.sqrt(std[i]! / points.length);
    if (std[i]! < 1e-10) std[i] = 1; // avoid division by zero
  }

  return points.map(p => p.map((v, i) => (v - mean[i]!) / std[i]!));
}

/**
 * Subsample a point cloud to at most maxN points using farthest-point sampling.
 * Preserves the topological structure better than random sampling.
 */
function farthestPointSample(points: number[][], maxN: number): number[][] {
  if (points.length <= maxN) return points;

  const n = points.length;
  const selected: number[] = [0]; // start with first point
  const minDist = new Array<number>(n).fill(Infinity);

  for (let k = 1; k < maxN; k++) {
    const last = selected[selected.length - 1]!;
    // Update minimum distances
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let j = 0; j < points[0]!.length; j++) {
        const diff = points[i]![j]! - points[last]![j]!;
        d += diff * diff;
      }
      d = Math.sqrt(d);
      if (d < minDist[i]!) minDist[i] = d;
    }
    // Select the point with maximum minimum distance
    let bestIdx = 0, bestDist = -1;
    for (let i = 0; i < n; i++) {
      if (!selected.includes(i) && minDist[i]! > bestDist) {
        bestDist = minDist[i]!;
        bestIdx = i;
      }
    }
    selected.push(bestIdx);
  }

  return selected.map(i => points[i]!);
}

/**
 * Estimate the correlation dimension of a point cloud.
 *
 * Uses the Grassberger-Procaccia algorithm: count pairs within distance ε
 * for multiple ε, then fit the slope of log(C(ε)) vs log(ε).
 * The slope approximates the correlation dimension.
 *
 * Low dimension (< 2) → price moves are highly constrained (trending).
 * High dimension (> 3) → price moves are complex / multi-regime.
 */
function estimateCorrelationDimension(points: number[][]): number {
  const n = points.length;
  if (n < 10) return 1;

  // Compute all pairwise distances
  const dists: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let d = 0;
      for (let k = 0; k < points[0]!.length; k++) {
        const diff = points[i]![k]! - points[j]![k]!;
        d += diff * diff;
      }
      dists.push(Math.sqrt(d));
    }
  }
  dists.sort((a, b) => a - b);

  // Compute correlation integral at multiple radii
  const totalPairs = dists.length;
  const numRadii = 20;
  const minR = dists[Math.floor(totalPairs * 0.05)]!;
  const maxR = dists[Math.floor(totalPairs * 0.80)]!;
  if (minR <= 0 || maxR <= minR) return 1;

  const logR: number[] = [];
  const logC: number[] = [];

  for (let i = 0; i < numRadii; i++) {
    const r = minR * Math.pow(maxR / minR, i / (numRadii - 1));
    // Count pairs within distance r (binary search since dists is sorted)
    let lo = 0, hi = dists.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (dists[mid]! <= r) lo = mid + 1;
      else hi = mid;
    }
    const count = lo;
    if (count > 0) {
      logR.push(Math.log(r));
      logC.push(Math.log(count / totalPairs));
    }
  }

  // Linear regression: log(C) = d × log(r) + b  →  slope = correlation dimension
  if (logR.length < 5) return 1;
  const nPts = logR.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < nPts; i++) {
    sumX += logR[i]!;
    sumY += logC[i]!;
    sumXY += logR[i]! * logC[i]!;
    sumXX += logR[i]! * logR[i]!;
  }
  const slope = (nPts * sumXY - sumX * sumY) / (nPts * sumXX - sumX * sumX);

  return Math.max(0.5, Math.min(slope, 6)); // clamp to reasonable range
}

// ── Regime classification from topological invariants ────────────────────────

/**
 * Classify the price regime from topological invariants.
 *
 * Key insight: for trending days, the Takens attractor is an elongated
 * 1D tube — it naturally has gaps (high β₀) even though the regime is
 * a clean trend.  So β₀ alone cannot distinguish trending from fragmented.
 *
 * Primary classifiers:
 *   - Effective dimension < 1.8  → trending (1D manifold)
 *   - Cyclical strength > 0.15  → ranging (attractor has loops)
 *   - H0 gap ratio < 0.3       → fragmented (many similar-sized gaps, no dominant structure)
 *   - Otherwise                 → transitioning
 */
function classifyRegime(
  diagram: PersistenceDiagram,
  cyclicalStrength: number,
  effectiveDimension: number,
): PriceRegime {
  // Ranging: attractor has significant cyclical (loop) structure
  if (cyclicalStrength > 0.15) return 'ranging';

  // Trending: attractor is low-dimensional (≈1D path)
  // A clean trend traces a 1D manifold regardless of gaps along it.
  if (effectiveDimension < 1.8) return 'trending';

  // For higher-dimensional attractors, check if the H0 persistence
  // has a clear dominant structure (one big gap >> rest) or not.
  const h0Sorted = diagram.pairs
    .filter(p => p.dimension === 0 && isFinite(p.persistence))
    .sort((a, b) => b.persistence - a.persistence);

  if (h0Sorted.length >= 2) {
    const gapRatio = 1 - h0Sorted[1]!.persistence / h0Sorted[0]!.persistence;
    // High gap ratio: one dominant structure, the rest is noise → transitioning
    if (gapRatio > 0.5) return 'transitioning';
  }

  // High dimension + no dominant structure → fragmented
  return 'fragmented';
}

function computeRegimeStability(
  diagram: PersistenceDiagram,
  regime: PriceRegime,
): number {
  // Stability = how dominant the leading H0 feature is relative to others
  const h0Pairs = diagram.pairs
    .filter(p => p.dimension === 0 && isFinite(p.persistence))
    .sort((a, b) => b.persistence - a.persistence);

  if (h0Pairs.length <= 1) return 1.0; // single component, fully stable

  // Gap ratio: how much more persistent is the dominant feature vs the next?
  const dominant = h0Pairs[0]!.persistence;
  const second = h0Pairs[1]!.persistence;
  if (dominant <= 0) return 0;

  const gapRatio = 1 - second / dominant;
  return Math.max(0, Math.min(1, gapRatio));
}

// ── Main API ─────────────────────────────────────────────────────────────────

/** Previous diagram for bottleneck distance computation. */
let _prevDiagram: PersistenceDiagram | null = null;
const _prevDiagrams = new Map<string, PersistenceDiagram>();

/**
 * Compute the full price topology from OHLCV bars.
 *
 * @param bars  OHLCV bars (newest at end). Needs ≥ 30 bars.
 * @param ticker  Ticker symbol (for per-ticker diagram history).
 * @param embeddingDim  Takens embedding dimension (default 3).
 * @param embeddingTau  Takens delay (default 2 for 1-min bars, 1 for 5-min+).
 * @param maxPoints  Maximum points after subsampling (default 60).
 */
export function computePriceTopology(
  bars: OHLCVBar[],
  ticker = 'unknown',
  embeddingDim = 3,
  embeddingTau = 2,
  maxPoints = 60,
): PriceTopology {
  // Extract close prices
  const closes = bars.map(b => b.close);

  // Takens embedding
  const rawCloud = takensEmbedding(closes, embeddingDim, embeddingTau);

  // Normalize to zero mean, unit variance
  const normalized = normalizePointCloud(rawCloud);

  // Subsample if too large
  const cloud = farthestPointSample(normalized, maxPoints);

  // Compute persistent homology (H0 + H1)
  const diagram = computePersistentHomology(cloud, 1);

  // H1 / H0 persistence ratio → cyclical strength
  const h0Persistence = diagram.pairs
    .filter(p => p.dimension === 0 && isFinite(p.persistence))
    .reduce((s, p) => s + p.persistence, 0);
  const h1Persistence = diagram.pairs
    .filter(p => p.dimension === 1 && isFinite(p.persistence))
    .reduce((s, p) => s + p.persistence, 0);
  const cyclicalStrength = h0Persistence > 0 ? h1Persistence / h0Persistence : 0;

  // Effective dimension of the attractor (needed by regime classifier)
  const effectiveDimension = cloud.length >= 10 ? estimateCorrelationDimension(cloud) : 1;

  // Regime classification
  const regime = classifyRegime(diagram, cyclicalStrength, effectiveDimension);
  const regimeStability = computeRegimeStability(diagram, regime);

  // Bottleneck distance from previous computation (per-ticker)
  const prevDiagram = _prevDiagrams.get(ticker) ?? null;
  const bDist = prevDiagram
    ? Math.max(
        bottleneckDistance(prevDiagram, diagram, 0),
        bottleneckDistance(prevDiagram, diagram, 1),
      )
    : 0;
  _prevDiagrams.set(ticker, diagram);

  return {
    diagram,
    regime,
    regimeStability,
    bottleneckDistance: bDist,
    cyclicalStrength,
    effectiveDimension,
  };
}
