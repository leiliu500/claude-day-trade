/**
 * Topology Engine — orchestrator that combines all topological analyses
 * and classifies detected option actions.
 *
 * This is the main entry point for the topology module.  It:
 *   1. Computes price topology (Takens embedding → persistent homology)
 *   2. Scans the option chain (strikes, volume, OI, IV, greeks)
 *   3. Computes chain topology (volume surface β₀, clusters, eccentricity)
 *   4. Computes IV topology (curvature, skew, anomalies)
 *   5. Classifies detected patterns into OptionAction types
 *   6. Computes an overall anomaly score
 *
 * The engine tracks invariants over time so it can fire on *changes*
 * rather than absolute levels.  A topology that's been stable for hours
 * is not anomalous even if β₀ = 3.  A topology that jumped from β₀ = 1
 * to β₀ = 3 in the last cycle is highly anomalous.
 */

import { computePriceTopology } from './price-topology.js';
import { computeChainTopology } from './chain-topology.js';
import { computeIVTopology } from './iv-topology.js';
import { scanOptionChain } from './option-scanner.js';
import type {
  TopologySignal,
  OptionAction,
  PriceTopology,
  ChainTopology,
  IVTopology,
  VolumeCluster,
} from './types.js';
import type { OHLCVBar } from '../types/market.js';

// ── Action classification ────────────────────────────────────────────────────

/**
 * Classify option actions from chain topology (volume surface analysis).
 */
function classifyChainActions(
  chain: ChainTopology,
  currentPrice: number,
): OptionAction[] {
  const actions: OptionAction[] = [];

  // Process each side
  for (const side of ['call', 'put'] as const) {
    const clusters = side === 'call' ? chain.callClusters : chain.putClusters;

    for (const cluster of clusters) {
      // Determine action type from cluster shape
      if (cluster.eccentricity > 0.5 && cluster.strikes.length >= 3) {
        // Sweep: elongated cluster across multiple strikes
        actions.push({
          type: 'sweep',
          direction: side === 'call' ? 'bullish' : 'bearish',
          strikes: cluster.strikes,
          sides: [side],
          confidence: Math.min(1, cluster.persistence / 1000) * 0.7 + cluster.eccentricity * 0.3,
          description: `${side.toUpperCase()} sweep across ${cluster.strikes.length} strikes ($${cluster.strikes[0]}–$${cluster.strikes[cluster.strikes.length - 1]}), vol=${cluster.totalVolume}`,
          invariants: ['volume_surface_β₀', 'cluster_eccentricity'],
        });
      } else if (cluster.strikes.length <= 2 && cluster.totalVolume > 500) {
        // Block: concentrated single-strike volume
        actions.push({
          type: 'block',
          direction: side === 'call' ? 'bullish' : 'bearish',
          strikes: cluster.strikes,
          sides: [side],
          confidence: Math.min(1, cluster.persistence / 500),
          description: `${side.toUpperCase()} block at $${cluster.centroid.toFixed(0)}, vol=${cluster.totalVolume}`,
          invariants: ['volume_surface_β₀', 'cluster_persistence'],
        });
      }
    }
  }

  // Multi-leg detection: look for correlated clusters across strikes
  const allClusters = [...chain.callClusters, ...chain.putClusters]
    .sort((a, b) => a.centroid - b.centroid);

  if (allClusters.length >= 2) {
    // Check for vertical spread pattern (2 clusters, same side, different strikes)
    const sameSidePairs = findSameSidePairs(allClusters);
    for (const [c1, c2] of sameSidePairs) {
      const strikeDiff = Math.abs(c1.centroid - c2.centroid);
      // Volume ratio close to 1:1 suggests a spread
      const volRatio = Math.min(c1.totalVolume, c2.totalVolume) /
                       Math.max(c1.totalVolume, c2.totalVolume);
      if (volRatio > 0.3 && strikeDiff > 0) {
        actions.push({
          type: 'complex_trade',
          direction: c1.side === 'call'
            ? (c1.centroid < c2.centroid ? 'bullish' : 'bearish')
            : (c1.centroid > c2.centroid ? 'bearish' : 'bullish'),
          strikes: [...c1.strikes, ...c2.strikes],
          sides: [c1.side],
          confidence: Math.min(1, volRatio * 0.5 + Math.min(c1.persistence, c2.persistence) / 500 * 0.5),
          description: `Vertical ${c1.side} spread: $${c1.centroid.toFixed(0)} / $${c2.centroid.toFixed(0)} (vol ratio ${volRatio.toFixed(2)})`,
          invariants: ['volume_surface_β₀', 'cluster_pair_correlation'],
        });
      }
    }

    // Check for butterfly (3 clusters: buy-sell-buy or sell-buy-sell)
    if (allClusters.length >= 3) {
      for (let i = 0; i < allClusters.length - 2; i++) {
        const [c1, c2, c3] = [allClusters[i]!, allClusters[i + 1]!, allClusters[i + 2]!];
        if (c1.side === c3.side && c1.side !== c2.side) {
          // Cross-side pattern: possible risk reversal or collar
          actions.push({
            type: 'complex_trade',
            direction: c1.side === 'call' ? 'bullish' : 'bearish',
            strikes: [...c1.strikes, ...c2.strikes, ...c3.strikes],
            sides: [c1.side, c2.side],
            confidence: 0.6,
            description: `Complex ${c1.side}/${c2.side} structure at $${c1.centroid.toFixed(0)}/$${c2.centroid.toFixed(0)}/$${c3.centroid.toFixed(0)}`,
            invariants: ['volume_surface_β₀', 'cross_side_topology'],
          });
        } else if (c1.side === c2.side && c2.side === c3.side) {
          // Same side, 3 strikes: butterfly or ladder
          const spacing1 = c2.centroid - c1.centroid;
          const spacing2 = c3.centroid - c2.centroid;
          const symmetry = Math.min(spacing1, spacing2) / Math.max(spacing1, spacing2);
          if (symmetry > 0.5) {
            actions.push({
              type: 'complex_trade',
              direction: 'neutral',
              strikes: [...c1.strikes, ...c2.strikes, ...c3.strikes],
              sides: [c1.side],
              confidence: Math.min(1, symmetry * 0.7 + 0.3),
              description: `Butterfly ${c1.side} at $${c1.centroid.toFixed(0)}/$${c2.centroid.toFixed(0)}/$${c3.centroid.toFixed(0)} (symmetry ${symmetry.toFixed(2)})`,
              invariants: ['volume_surface_β₀', 'cluster_symmetry'],
            });
          }
        }
      }
    }
  }

  // Accumulation detection from OI
  if (chain.oiAccumulation === 'building') {
    const highOICalls = chain.callChain.filter(c => c.openInterest > 1000 && c.volume > 100);
    const highOIPuts = chain.putChain.filter(c => c.openInterest > 1000 && c.volume > 100);

    for (const c of highOICalls) {
      if (c.volume / c.openInterest > 0.3) {
        actions.push({
          type: 'accumulation',
          direction: 'bullish',
          strikes: [c.strike],
          sides: ['call'],
          confidence: Math.min(1, c.volume / c.openInterest),
          description: `Call accumulation at $${c.strike}: OI=${c.openInterest}, vol=${c.volume}, V/OI=${(c.volume / c.openInterest).toFixed(2)}`,
          invariants: ['oi_accumulation_regime'],
        });
      }
    }
    for (const c of highOIPuts) {
      if (c.volume / c.openInterest > 0.3) {
        actions.push({
          type: 'accumulation',
          direction: 'bearish',
          strikes: [c.strike],
          sides: ['put'],
          confidence: Math.min(1, c.volume / c.openInterest),
          description: `Put accumulation at $${c.strike}: OI=${c.openInterest}, vol=${c.volume}, V/OI=${(c.volume / c.openInterest).toFixed(2)}`,
          invariants: ['oi_accumulation_regime'],
        });
      }
    }
  }

  return actions;
}

/**
 * Classify option actions from IV topology (curvature anomalies).
 */
function classifyIVActions(iv: IVTopology): OptionAction[] {
  const actions: OptionAction[] = [];

  for (const anomaly of iv.anomalies) {
    actions.push({
      type: 'iv_dislocation',
      direction: anomaly.direction === 'bid_up'
        ? (anomaly.side === 'call' ? 'bullish' : 'bearish')
        : anomaly.direction === 'offered_down'
          ? (anomaly.side === 'call' ? 'bearish' : 'bullish')
          : 'neutral',
      strikes: [anomaly.strike],
      sides: [anomaly.side],
      confidence: Math.min(1, Math.abs(anomaly.zScore) / 3),
      description: `IV ${anomaly.direction === 'bid_up' ? 'elevated' : 'depressed'} at $${anomaly.strike} ${anomaly.side} (z=${anomaly.zScore.toFixed(2)}, residual=${(anomaly.residual * 100).toFixed(1)}%)`,
      invariants: ['iv_curvature_anomaly', 'smile_residual_zscore'],
    });
  }

  return actions;
}

/**
 * Classify regime-break actions from price topology.
 */
function classifyPriceActions(price: PriceTopology): OptionAction[] {
  const actions: OptionAction[] = [];

  // Regime fragmentation
  if (price.regime === 'fragmented' || price.regime === 'transitioning') {
    actions.push({
      type: 'regime_break',
      direction: 'neutral',
      strikes: [],
      sides: [],
      confidence: 1 - price.regimeStability,
      description: `Price attractor ${price.regime}: β₀=${price.diagram.betti[0]}, stability=${price.regimeStability.toFixed(2)}, bottleneck=${price.bottleneckDistance.toFixed(3)}`,
      invariants: ['price_β₀', 'regime_stability', 'bottleneck_distance'],
    });
  }

  // Large bottleneck distance (structural break even without regime change label)
  if (price.bottleneckDistance > 0.5) {
    actions.push({
      type: 'regime_break',
      direction: 'neutral',
      strikes: [],
      sides: [],
      confidence: Math.min(1, price.bottleneckDistance / 2),
      description: `Topological structural break: bottleneck distance ${price.bottleneckDistance.toFixed(3)} (threshold 0.5)`,
      invariants: ['bottleneck_distance'],
    });
  }

  return actions;
}

/** Find pairs of clusters on the same side. */
function findSameSidePairs(clusters: VolumeCluster[]): [VolumeCluster, VolumeCluster][] {
  const pairs: [VolumeCluster, VolumeCluster][] = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (clusters[i]!.side === clusters[j]!.side) {
        pairs.push([clusters[i]!, clusters[j]!]);
      }
    }
  }
  return pairs;
}

/**
 * Compute overall anomaly score from all topological analyses.
 *
 * Combines:
 *   - Price regime instability
 *   - Bottleneck distance (structural change speed)
 *   - Number and confidence of detected option actions
 *   - IV curvature anomaly count
 *   - Chain topology complexity (β₀ > 1)
 */
function computeAnomalyScore(
  price: PriceTopology,
  chain: ChainTopology | null,
  iv: IVTopology | null,
  actions: OptionAction[],
): number {
  let score = 0;

  // Price contribution (0–0.3)
  score += (1 - price.regimeStability) * 0.15;
  score += Math.min(0.15, price.bottleneckDistance * 0.15);

  // Chain contribution (0–0.35)
  if (chain) {
    const totalBeta0 = chain.callBeta0 + chain.putBeta0;
    score += Math.min(0.15, (totalBeta0 - 1) * 0.05); // β₀ > 1 is unusual
    score += chain.putCallConcentration * 0.1;
    score += (chain.oiAccumulation === 'building' ? 0.1 : 0);
  }

  // IV contribution (0–0.15)
  if (iv) {
    score += Math.min(0.1, iv.anomalies.length * 0.03);
    score += Math.min(0.05, (iv.callIntegratedCurvature + iv.putIntegratedCurvature) * 0.001);
  }

  // Action count contribution (0–0.2)
  const highConfActions = actions.filter(a => a.confidence > 0.5);
  score += Math.min(0.2, highConfActions.length * 0.05);

  return Math.min(1, score);
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Compute the full topology signal for a ticker.
 *
 * This is the main entry point.  Call it each pipeline cycle (every 3 min)
 * with the latest bars and it will:
 *   1. Analyze price attractor topology
 *   2. Scan and analyze the option chain topology
 *   3. Classify detected option actions
 *   4. Return a TopologySignal with all results
 *
 * @param ticker  Underlying symbol.
 * @param bars  Recent OHLCV bars (1-min or 5-min, ≥50 bars).
 * @param currentPrice  Current underlying price.
 * @param scanOptions  Whether to scan the option chain (adds ~2s latency).
 * @param strikeRadius  How far from ATM to scan options (default 30).
 */
export async function computeTopologySignal(
  ticker: string,
  bars: OHLCVBar[],
  currentPrice: number,
  scanOptions = true,
  strikeRadius = 30,
): Promise<TopologySignal> {
  // 1. Price topology (synchronous, fast)
  const price = computePriceTopology(bars, ticker);

  // 2. Option chain scan + topology (async, ~1-2s)
  let chain: ChainTopology | null = null;
  let iv: IVTopology | null = null;

  if (scanOptions) {
    try {
      const { callChain, putChain } = await scanOptionChain(ticker, currentPrice, strikeRadius);

      if (callChain.length > 0 || putChain.length > 0) {
        chain = computeChainTopology(callChain, putChain, currentPrice);
        iv = computeIVTopology(callChain, putChain, currentPrice);
      }
    } catch (err) {
      console.warn(`[TopologyEngine] Option scan failed for ${ticker}: ${(err as Error).message}`);
    }
  }

  // 3. Classify actions from all analyses
  const actions: OptionAction[] = [
    ...classifyPriceActions(price),
    ...(chain ? classifyChainActions(chain, currentPrice) : []),
    ...(iv ? classifyIVActions(iv) : []),
  ];

  // Sort by confidence (highest first)
  actions.sort((a, b) => b.confidence - a.confidence);

  // 4. Overall anomaly score
  const anomalyScore = computeAnomalyScore(price, chain, iv, actions);

  return {
    ticker,
    timestamp: new Date().toISOString(),
    price,
    chain,
    iv,
    actions,
    anomalyScore,
  };
}

/**
 * Format a TopologySignal as a human-readable summary for logging/Telegram.
 */
export function formatTopologySignal(signal: TopologySignal): string {
  const lines: string[] = [];

  lines.push(`[Topology] ${signal.ticker} anomaly=${signal.anomalyScore.toFixed(2)}`);

  // Price
  const p = signal.price;
  lines.push(`  Price: regime=${p.regime} stability=${p.regimeStability.toFixed(2)} cyclical=${p.cyclicalStrength.toFixed(2)} dim=${p.effectiveDimension.toFixed(1)} β=[${p.diagram.betti[0]},${p.diagram.betti[1]}] bottleneck=${p.bottleneckDistance.toFixed(3)}`);

  // Chain
  if (signal.chain) {
    const c = signal.chain;
    lines.push(`  Chain: call_β₀=${c.callBeta0} put_β₀=${c.putBeta0} PC_conc=${c.putCallConcentration.toFixed(2)} OI=${c.oiAccumulation}`);
    for (const cluster of [...c.callClusters, ...c.putClusters]) {
      lines.push(`    Cluster: ${cluster.side} $${cluster.strikes[0]}–$${cluster.strikes[cluster.strikes.length - 1]} vol=${cluster.totalVolume} persist=${cluster.persistence.toFixed(0)} ecc=${cluster.eccentricity.toFixed(2)}`);
    }
  }

  // IV
  if (signal.iv) {
    lines.push(`  IV: call_curv=${signal.iv.callIntegratedCurvature.toFixed(4)} put_curv=${signal.iv.putIntegratedCurvature.toFixed(4)} call_skew=${signal.iv.callSkewSlope.toFixed(4)} put_skew=${signal.iv.putSkewSlope.toFixed(4)}`);
    for (const a of signal.iv.anomalies) {
      lines.push(`    Anomaly: $${a.strike} ${a.side} z=${a.zScore.toFixed(2)} ${a.direction}`);
    }
  }

  // Actions
  if (signal.actions.length > 0) {
    lines.push(`  Actions (${signal.actions.length}):`);
    for (const a of signal.actions.slice(0, 10)) {
      lines.push(`    [${a.confidence.toFixed(2)}] ${a.type}: ${a.description}`);
    }
  }

  return lines.join('\n');
}
