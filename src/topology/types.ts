/**
 * Topological Data Analysis types for market data.
 *
 * Market data lives in multi-dimensional spaces whose *shape* (topology)
 * has global invariants — properties that don't depend on any threshold,
 * moving average period, or lookback window.  Changes in these invariants
 * signal structural regime shifts and institutional option activity that
 * point-wise indicators fundamentally cannot detect.
 */

// ── Persistent Homology ──────────────────────────────────────────────────────

/** A single birth-death pair in a persistence diagram. */
export interface PersistencePair {
  birth: number;       // filtration value where feature appears
  death: number;       // filtration value where feature disappears (Infinity = essential)
  dimension: number;   // 0 = connected component, 1 = loop/cycle
  persistence: number; // death - birth (lifetime of the feature)
}

/** Full persistence diagram — the complete topological fingerprint of a point cloud. */
export interface PersistenceDiagram {
  pairs: PersistencePair[];
  /** Betti numbers: β₀ = connected components, β₁ = loops (at a reference scale). */
  betti: [number, number];
  /** Total persistence = Σ(death - birth) for all finite pairs. Global complexity measure. */
  totalPersistence: number;
  /** Max single-feature persistence. Dominant structural feature scale. */
  maxPersistence: number;
  /** Number of essential features (never die) per dimension. */
  essentialCount: [number, number];
}

// ── Price Topology ───────────────────────────────────────────────────────────

export type PriceRegime = 'trending' | 'ranging' | 'transitioning' | 'fragmented';

export interface PriceTopology {
  /** Persistence diagram of the Takens-embedded price attractor. */
  diagram: PersistenceDiagram;
  /** Detected regime from topological invariants. */
  regime: PriceRegime;
  /** Regime stability: 0 = just changed, 1 = deeply stable. */
  regimeStability: number;
  /**
   * Bottleneck distance between current and prior persistence diagram.
   * Large values = structural break in the price attractor.
   */
  bottleneckDistance: number;
  /** H1 persistence ratio: total H1 persistence / total H0 persistence.
   *  High ratio → strong cyclical structure (ranging).
   *  Low ratio → no recurrence (trending or fragmented). */
  cyclicalStrength: number;
  /** Effective dimensionality of the price attractor (correlation dimension estimate). */
  effectiveDimension: number;
}

// ── Option Chain Topology ────────────────────────────────────────────────────

/** A single contract's snapshot for topology analysis. */
export interface ChainContract {
  strike: number;
  expiration: string;      // YYYY-MM-DD
  side: 'call' | 'put';
  volume: number;
  openInterest: number;
  iv: number;              // implied volatility
  delta: number;
  gamma: number;
  bid: number;
  ask: number;
  mid: number;
}

/** A cluster of volume activity detected in the option chain. */
export interface VolumeCluster {
  /** Strikes included in this cluster. */
  strikes: number[];
  /** Total volume in the cluster. */
  totalVolume: number;
  /** Persistence: how "prominent" this peak is (death - birth in super-level filtration). */
  persistence: number;
  /** Centroid strike (volume-weighted). */
  centroid: number;
  /** Eccentricity: 0 = point-like (block), 1 = elongated (sweep). */
  eccentricity: number;
  side: 'call' | 'put';
}

/** Topology of the option volume surface V(strike). */
export interface ChainTopology {
  /** Volume clusters detected via super-level set persistence. */
  callClusters: VolumeCluster[];
  putClusters: VolumeCluster[];
  /** β₀ of the high-volume super-level set (number of distinct volume peaks). */
  callBeta0: number;
  putBeta0: number;
  /** Put/call volume ratio topology: is volume concentrated or dispersed? */
  putCallConcentration: number;  // 0 = dispersed evenly, 1 = concentrated on one side
  /** OI change topology: new positions being built vs closed. */
  oiAccumulation: 'building' | 'unwinding' | 'neutral';
  /** Raw chain data used for analysis. */
  callChain: ChainContract[];
  putChain: ChainContract[];
}

// ── IV Surface Topology ──────────────────────────────────────────────────────

/** Curvature anomaly at a specific strike. */
export interface IVAnomaly {
  strike: number;
  side: 'call' | 'put';
  /** Observed IV minus model-fitted IV. Positive = locally elevated. */
  residual: number;
  /** Z-score of the residual relative to the smile. */
  zScore: number;
  /** Direction of the anomaly: demand-driven (buying) or supply-driven (selling). */
  direction: 'bid_up' | 'offered_down' | 'neutral';
}

export interface IVTopology {
  /** Discrete curvature at each strike (second derivative of smile). */
  callCurvature: { strike: number; curvature: number }[];
  putCurvature: { strike: number; curvature: number }[];
  /** Integrated absolute curvature — total "bumpiness" of the smile.
   *  Canonical smile has low integrated curvature. Flow creates bumps. */
  callIntegratedCurvature: number;
  putIntegratedCurvature: number;
  /** Skew slope: dσ/dK at ATM. Steepening = directional bets. */
  callSkewSlope: number;
  putSkewSlope: number;
  /** Anomalies: strikes where IV deviates significantly from the fitted smile. */
  anomalies: IVAnomaly[];
}

// ── Detected Option Actions ─────────────────────────────────────────────────

export type OptionActionType =
  | 'sweep'            // rapid buying across consecutive strikes
  | 'block'            // large single-strike volume concentration
  | 'accumulation'     // persistent OI buildup at specific strikes
  | 'complex_trade'    // multi-leg structure (spread, butterfly, condor)
  | 'iv_dislocation'   // IV surface deformation indicating hidden flow
  | 'regime_break';    // price topology structural change

export interface OptionAction {
  type: OptionActionType;
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Strikes involved. Single for block, multiple for sweep/complex. */
  strikes: number[];
  /** Side(s) involved. */
  sides: ('call' | 'put')[];
  /** Confidence 0-1 based on topological persistence (long-lived = high confidence). */
  confidence: number;
  /** Human-readable description of the detected action. */
  description: string;
  /** Which topological invariant(s) triggered this detection. */
  invariants: string[];
}

// ── Combined Topology Signal ─────────────────────────────────────────────────

export interface TopologySignal {
  ticker: string;
  timestamp: string;
  /** Price manifold topology. */
  price: PriceTopology;
  /** Option chain volume surface topology. */
  chain: ChainTopology | null;
  /** IV surface curvature topology. */
  iv: IVTopology | null;
  /** Detected option actions from all topological analyses. */
  actions: OptionAction[];
  /** Overall anomaly score: 0 = normal topology, 1 = extreme structural anomaly. */
  anomalyScore: number;
}
