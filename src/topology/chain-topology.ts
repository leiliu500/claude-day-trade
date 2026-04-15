/**
 * Option Chain Topology — topological analysis of the volume surface.
 *
 * The option chain is a 1D function V(K) — volume at each strike K.
 * Its topology reveals institutional activity that individual-contract
 * analysis misses:
 *
 *   Super-level set persistence of V(K):
 *     Each "peak" in volume gets a persistence value measuring how
 *     prominent it is.  Short-lived peaks = noise.  Long-lived peaks =
 *     real volume concentrations (blocks, sweeps, accumulation).
 *
 *   Connected components of high-volume regions:
 *     β₀ = 1  → single concentration (block trade or ATM activity)
 *     β₀ = 2  → two concentrations (vertical spread)
 *     β₀ = 3  → three concentrations (butterfly / risk reversal)
 *     Eccentricity of each component: 0 = point-like (block),
 *       close to 1 = elongated (sweep across strikes).
 *
 *   Put/call concentration:
 *     Whether volume is balanced across sides or concentrated on one.
 *     Topological measure: compare β₀ and total persistence between
 *     call and put volume surfaces.
 */

import { superLevelPersistence } from './persistent-homology.js';
import type { ChainContract, ChainTopology, VolumeCluster } from './types.js';

/**
 * Compute volume clusters from super-level persistence.
 *
 * Each significant peak in V(K) becomes a VolumeCluster with:
 *   - strikes: the contiguous run of strikes in this peak
 *   - persistence: how prominent the peak is
 *   - eccentricity: 0 = point-like, approaching 1 = sweep-like
 *   - centroid: volume-weighted center strike
 */
function extractClusters(
  contracts: ChainContract[],
  minPersistence: number,
): VolumeCluster[] {
  if (contracts.length === 0) return [];

  // Sort by strike
  const sorted = [...contracts].sort((a, b) => a.strike - b.strike);

  // Build the volume function V(K)
  const values = sorted.map(c => ({ position: c.strike, value: c.volume }));

  // Compute super-level persistence
  const pairs = superLevelPersistence(values);

  // Filter to significant peaks (persistence above threshold)
  const significantPeaks = pairs.filter(p => p.persistence >= minPersistence);

  if (significantPeaks.length === 0) return [];

  // For each significant peak, identify the strikes that belong to it.
  // A peak at height h (birth) persists down to height d (death).
  // The cluster includes all strikes whose volume is above the death level
  // and are contiguous around the peak location.
  const clusters: VolumeCluster[] = [];

  for (const peak of significantPeaks) {
    // Find the strike with volume closest to the peak birth value
    let peakIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const diff = Math.abs(sorted[i]!.volume - peak.birth);
      if (diff < bestDiff) {
        bestDiff = diff;
        peakIdx = i;
      }
    }

    // Expand outward from peak while volume > death threshold
    const threshold = peak.death;
    const clusterStrikes: number[] = [];
    let totalVolume = 0;
    let weightedSum = 0;

    // Include peak
    clusterStrikes.push(sorted[peakIdx]!.strike);
    totalVolume += sorted[peakIdx]!.volume;
    weightedSum += sorted[peakIdx]!.strike * sorted[peakIdx]!.volume;

    // Expand left
    for (let i = peakIdx - 1; i >= 0; i--) {
      if (sorted[i]!.volume > threshold) {
        clusterStrikes.unshift(sorted[i]!.strike);
        totalVolume += sorted[i]!.volume;
        weightedSum += sorted[i]!.strike * sorted[i]!.volume;
      } else break;
    }

    // Expand right
    for (let i = peakIdx + 1; i < sorted.length; i++) {
      if (sorted[i]!.volume > threshold) {
        clusterStrikes.push(sorted[i]!.strike);
        totalVolume += sorted[i]!.volume;
        weightedSum += sorted[i]!.strike * sorted[i]!.volume;
      } else break;
    }

    // Eccentricity: how spread out is this cluster?
    // 0 = single strike (block), approaches 1 = many strikes (sweep)
    const maxPossibleSpan = sorted[sorted.length - 1]!.strike - sorted[0]!.strike;
    const span = clusterStrikes.length > 1
      ? clusterStrikes[clusterStrikes.length - 1]! - clusterStrikes[0]!
      : 0;
    const eccentricity = maxPossibleSpan > 0
      ? Math.min(1, span / (maxPossibleSpan * 0.3))  // 30% of chain = max eccentricity
      : 0;

    clusters.push({
      strikes: clusterStrikes,
      totalVolume,
      persistence: peak.persistence,
      centroid: totalVolume > 0 ? weightedSum / totalVolume : sorted[peakIdx]!.strike,
      eccentricity,
      side: sorted[0]!.side,
    });
  }

  return clusters;
}

/**
 * Determine OI accumulation regime.
 *
 * Compares current OI across strikes to detect whether new positions
 * are being built (accumulation) or closed (unwinding).
 * Uses the topology of the OI surface: rising total OI with
 * increasing β₀ = new multi-strike positions being built.
 */
function classifyOIAccumulation(
  calls: ChainContract[],
  puts: ChainContract[],
): 'building' | 'unwinding' | 'neutral' {
  const totalOI = [...calls, ...puts].reduce((s, c) => s + c.openInterest, 0);
  const totalVol = [...calls, ...puts].reduce((s, c) => s + c.volume, 0);

  if (totalOI === 0) return 'neutral';

  // Volume/OI ratio: high ratio = new positions being opened
  // Low ratio = existing positions being exercised/closed
  const voRatio = totalVol / totalOI;

  if (voRatio > 0.5) return 'building';
  if (voRatio < 0.1) return 'unwinding';
  return 'neutral';
}

/**
 * Compute the full option chain topology.
 *
 * @param callChain  Call contracts sorted by strike (from option scanner).
 * @param putChain   Put contracts sorted by strike (from option scanner).
 * @param currentPrice  Current underlying price (for relative analysis).
 */
export function computeChainTopology(
  callChain: ChainContract[],
  putChain: ChainContract[],
  currentPrice: number,
): ChainTopology {
  // Minimum persistence threshold: ignore peaks smaller than 10% of max volume
  const maxVol = Math.max(
    ...callChain.map(c => c.volume),
    ...putChain.map(c => c.volume),
    1,
  );
  const minPersistence = maxVol * 0.10;

  // Extract volume clusters per side
  const callClusters = extractClusters(callChain, minPersistence);
  const putClusters = extractClusters(putChain, minPersistence);

  // β₀ = number of significant clusters
  const callBeta0 = callClusters.length;
  const putBeta0 = putClusters.length;

  // Put/call concentration: measure asymmetry of total volume
  const callVol = callChain.reduce((s, c) => s + c.volume, 0);
  const putVol = putChain.reduce((s, c) => s + c.volume, 0);
  const totalVol = callVol + putVol;
  const putCallConcentration = totalVol > 0
    ? Math.abs(callVol - putVol) / totalVol
    : 0;

  const oiAccumulation = classifyOIAccumulation(callChain, putChain);

  return {
    callClusters,
    putClusters,
    callBeta0,
    putBeta0,
    putCallConcentration,
    oiAccumulation,
    callChain,
    putChain,
  };
}
