/**
 * Topology Entry Model — regime-conditional entry/exit decisions
 * from topological invariants.
 *
 * WHY THIS IS BETTER THAN THE ADDITIVE CONFIDENCE MODEL:
 *
 * The confidence model computes 30+ bonuses/penalties and sums them.
 * This has three structural flaws:
 *
 *   1. REGIME-BLIND: the same bonuses apply in trending, ranging, and
 *      fragmented markets.  A VWAP bonus helps in ranges, hurts in trends.
 *      An ADX bonus helps in trends, is noise in ranges.
 *
 *   2. DOUBLE-COUNTING: correlated indicators (DMI + MACD + OBV) each
 *      contribute independent bonuses.  When they agree, the model over-
 *      counts.  When they disagree, the model averages to mush.
 *
 *   3. THRESHOLD-BRITTLE: every bonus has a hand-tuned threshold.
 *      ADX > 25? MACD cross within 3 bars?  These break on regime change.
 *
 * The topology model fixes all three:
 *
 *   1. REGIME-CONDITIONAL: topology first classifies the regime (trending,
 *      ranging, transitioning, fragmented), then applies a DIFFERENT model
 *      per regime.  Each model only uses the factors that matter for that regime.
 *
 *   2. INDEPENDENT SIGNALS: topology uses structurally independent information:
 *      - Price manifold shape (persistence diagram) — pure geometry
 *      - Option flow topology (volume surface β₀) — causal institutional signal
 *      - IV curvature — supply/demand equilibrium deformation
 *      These cannot double-count because they measure different things.
 *
 *   3. SCALE-FREE: persistent homology measures significance by persistence
 *      (how long a feature survives across scales), not by crossing a threshold.
 *      A feature is significant because it persists, period.
 *
 * DECISION ARCHITECTURE:
 *
 *   ┌──────────────┐
 *   │ REGIME GATE  │  Topology determines WHICH model runs.
 *   │ (must pass)  │  Fragmented → NO ENTRY.
 *   └──────┬───────┘
 *          │
 *   ┌──────▼───────┐
 *   │ STRUCTURE    │  Is the regime confirmed / breaking?
 *   │ GATE         │  (stability, bottleneck, dimension)
 *   └──────┬───────┘
 *          │
 *   ┌──────▼───────┐
 *   │ FLOW GATE    │  Does institutional flow confirm direction?
 *   │ (optional)   │  (option sweeps, blocks, accumulation)
 *   └──────┬───────┘
 *          │
 *   ┌──────▼───────┐
 *   │ IV GATE      │  Is anyone positioning against us?
 *   │ (optional)   │  (IV curvature anomalies)
 *   └──────┬───────┘
 *          │
 *   ┌──────▼───────┐
 *   │ ENTRY SCORE  │  Multiplicative (not additive) score.
 *   │ + DIRECTION  │  Gate strengths combine as product.
 *   └──────────────┘
 */

import type {
  TopologySignal,
  PriceTopology,
  ChainTopology,
  IVTopology,
  OptionAction,
  PriceRegime,
} from './types.js';

// ── Output types ─────────────────────────────────────────────────────────────

export interface TopologyEntrySignal {
  /** Whether to enter. */
  action: 'ENTER' | 'WAIT' | 'EXIT';
  /** Direction for entry, or current-position direction for exit. */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Entry conviction: 0–1.  Product of gate strengths, not a sum. */
  conviction: number;
  /** Which regime model produced this signal. */
  regime: PriceRegime;
  /** Gate results — each gate either passes or blocks with a reason. */
  gates: GateResult[];
  /** Detected option actions supporting this signal. */
  supportingActions: OptionAction[];
  /** Human-readable reasoning. */
  reasoning: string;
}

export interface GateResult {
  name: string;
  passed: boolean;
  strength: number;   // 0–1: how strongly this gate supports entry
  reason: string;
}

// ── Gate implementations ─────────────────────────────────────────────────────

/**
 * REGIME GATE — determines which model to apply.
 * Fragmented = no entry (unclear structure, high dimension, no cycles).
 */
function regimeGate(price: PriceTopology): GateResult {
  if (price.regime === 'fragmented') {
    return {
      name: 'REGIME',
      passed: false,
      strength: 0,
      reason: `Fragmented attractor (dim=${price.effectiveDimension.toFixed(1)}, cyclic=${price.cyclicalStrength.toFixed(3)}) — no identifiable structure to trade`,
    };
  }
  // Strength varies by regime clarity
  const strength = price.regime === 'trending'
    ? 0.6 + Math.min(0.4, (1.8 - price.effectiveDimension) * 0.5)  // lower dim = cleaner trend
    : price.regime === 'ranging'
      ? 0.5 + Math.min(0.5, price.cyclicalStrength * 2)  // stronger cycles = cleaner range
      : 0.4; // transitioning: moderate base
  return {
    name: 'REGIME',
    passed: true,
    strength: Math.max(0, Math.min(1, strength)),
    reason: `${price.regime} (dim=${price.effectiveDimension.toFixed(1)}, cyclic=${price.cyclicalStrength.toFixed(3)})`,
  };
}

/**
 * STRUCTURE GATE — is the regime confirmed or just forming?
 *
 * Trending:      stability > 0.05 OR bottleneck spike (new trend forming)
 * Ranging:       stability > 0.15 (range confirmed, not about to break)
 * Transitioning: bottleneck > 0.3 (real structural break, not noise)
 */
function structureGate(price: PriceTopology): GateResult {
  const { regime, regimeStability, bottleneckDistance: bn } = price;

  switch (regime) {
    case 'trending': {
      // Three ways to confirm a trend:
      //   1. Bottleneck spike (structural break — new trend forming)
      //   2. Stability gap (dominant H0 feature well-separated)
      //   3. Low effective dimension (attractor is nearly 1D = clean trend line)
      //      dim < 1.0 is strong directional evidence even when stability is low
      const isNewTrend = bn > 0.3;
      const isConfirmed = regimeStability > 0.10;
      const isLowDim = price.effectiveDimension <= 1.0;
      if (!isNewTrend && !isConfirmed && !isLowDim) {
        return { name: 'STRUCTURE', passed: false, strength: 0,
          reason: `Trend not confirmed (stability=${regimeStability.toFixed(2)} < 0.10, bn=${bn.toFixed(3)} < 0.30, dim=${price.effectiveDimension.toFixed(1)} > 1.0)` };
      }
      // Compute strength based on which condition fired
      let strength: number;
      let reason: string;
      if (isNewTrend) {
        strength = 0.5 + Math.min(0.5, bn * 0.5);
        reason = `Structural break (bn=${bn.toFixed(3)}) — new trend forming`;
      } else if (isLowDim) {
        // Lower dimension = cleaner trend → higher strength
        strength = 0.5 + Math.min(0.4, (1.0 - price.effectiveDimension) * 4);
        reason = `Low-dimensional trend (dim=${price.effectiveDimension.toFixed(2)}, stability=${regimeStability.toFixed(2)})`;
      } else {
        strength = 0.4 + Math.min(0.5, regimeStability * 2);
        reason = `Trend confirmed (stability=${regimeStability.toFixed(2)})`;
      }
      return { name: 'STRUCTURE', passed: true, strength: Math.min(1, strength), reason };
    }

    case 'ranging': {
      if (regimeStability < 0.15) {
        return { name: 'STRUCTURE', passed: false, strength: 0,
          reason: `Range not stable enough (stability=${regimeStability.toFixed(2)} < 0.15)` };
      }
      // Stable range: good for mean-reversion
      return { name: 'STRUCTURE', passed: true,
        strength: 0.5 + Math.min(0.5, regimeStability),
        reason: `Stable range (stability=${regimeStability.toFixed(2)})` };
    }

    case 'transitioning': {
      if (bn < 0.3) {
        return { name: 'STRUCTURE', passed: false, strength: 0,
          reason: `Transition too weak (bn=${bn.toFixed(3)} < 0.3)` };
      }
      return { name: 'STRUCTURE', passed: true,
        strength: 0.4 + Math.min(0.6, bn * 0.6),
        reason: `Regime transition underway (bn=${bn.toFixed(3)})` };
    }

    default:
      return { name: 'STRUCTURE', passed: false, strength: 0,
        reason: `Unknown regime: ${regime}` };
  }
}

/**
 * FLOW GATE — does institutional option flow confirm the direction?
 *
 * This gate uses the CAUSAL signal: institutions move markets through
 * aggressive order flow (sweeps, blocks), not through indicator crossovers.
 *
 * When flow data is available:
 *   - Confirming flow → pass with high strength
 *   - Opposing flow → BLOCK (strongest possible veto)
 *   - No significant flow → pass with moderate strength (neutral)
 *
 * When flow data is absent (no option scan): pass with reduced strength.
 */
function flowGate(
  chain: ChainTopology | null,
  actions: OptionAction[],
  direction: 'bullish' | 'bearish',
): GateResult {
  if (!chain) {
    return { name: 'FLOW', passed: true, strength: 0.5,
      reason: 'No option chain data — flow-neutral' };
  }

  // Find directional actions (sweeps, blocks, accumulation)
  const directionalActions = actions.filter(a =>
    (a.type === 'sweep' || a.type === 'block' || a.type === 'accumulation') &&
    a.confidence > 0.3
  );

  if (directionalActions.length === 0) {
    return { name: 'FLOW', passed: true, strength: 0.5,
      reason: 'No significant option flow detected — neutral' };
  }

  // Check if flow confirms or opposes our direction
  const confirming = directionalActions.filter(a => a.direction === direction);
  const opposing = directionalActions.filter(a =>
    a.direction !== 'neutral' && a.direction !== direction
  );

  if (opposing.length > 0 && confirming.length === 0) {
    // Strong opposing flow = veto
    const bestOpposing = opposing.reduce((best, a) => a.confidence > best.confidence ? a : best, opposing[0]!);
    return { name: 'FLOW', passed: false, strength: 0,
      reason: `Opposing flow: ${bestOpposing.description}` };
  }

  if (confirming.length > 0) {
    // Confirming flow = boost
    const bestConfirming = confirming.reduce((best, a) => a.confidence > best.confidence ? a : best, confirming[0]!);
    const strength = 0.6 + Math.min(0.4, bestConfirming.confidence * 0.5);
    return { name: 'FLOW', passed: true, strength,
      reason: `Confirming flow: ${bestConfirming.description}` };
  }

  // Mixed flow: both confirming and opposing
  const netConfidence = confirming.reduce((s, a) => s + a.confidence, 0) -
                        opposing.reduce((s, a) => s + a.confidence, 0);
  if (netConfidence < 0) {
    return { name: 'FLOW', passed: false, strength: 0,
      reason: `Net opposing flow (confirming=${confirming.length}, opposing=${opposing.length})` };
  }

  return { name: 'FLOW', passed: true, strength: 0.5 + Math.min(0.3, netConfidence * 0.3),
    reason: `Mixed flow net-confirming (${confirming.length} confirm, ${opposing.length} oppose)` };
}

/**
 * IV GATE — is anyone positioning against us?
 *
 * IV curvature anomalies at strikes near our entry reveal hidden
 * institutional positioning.  If someone is aggressively buying puts
 * while we're going long, that's a warning.
 *
 * This gate rarely blocks — it's a soft modifier.  Only blocks when
 * there are strong opposing IV anomalies with no supporting ones.
 */
function ivGate(
  iv: IVTopology | null,
  direction: 'bullish' | 'bearish',
): GateResult {
  if (!iv) {
    return { name: 'IV', passed: true, strength: 0.5,
      reason: 'No IV data — neutral' };
  }

  if (iv.anomalies.length === 0) {
    return { name: 'IV', passed: true, strength: 0.6,
      reason: 'Clean IV smile — no hidden positioning detected' };
  }

  // Classify anomalies by what they imply
  const bullishAnomalies = iv.anomalies.filter(a =>
    (a.side === 'call' && a.direction === 'bid_up') ||
    (a.side === 'put' && a.direction === 'offered_down')
  );
  const bearishAnomalies = iv.anomalies.filter(a =>
    (a.side === 'put' && a.direction === 'bid_up') ||
    (a.side === 'call' && a.direction === 'offered_down')
  );

  const confirming = direction === 'bullish' ? bullishAnomalies : bearishAnomalies;
  const opposing = direction === 'bullish' ? bearishAnomalies : bullishAnomalies;

  if (opposing.length > 0 && confirming.length === 0) {
    const avgZ = opposing.reduce((s, a) => s + Math.abs(a.zScore), 0) / opposing.length;
    if (avgZ > 2.5) {
      return { name: 'IV', passed: false, strength: 0,
        reason: `Strong opposing IV positioning: ${opposing.length} anomalies (avg z=${avgZ.toFixed(1)})` };
    }
    return { name: 'IV', passed: true, strength: 0.3,
      reason: `Mild opposing IV (avg z=${avgZ.toFixed(1)}) — proceed with caution` };
  }

  if (confirming.length > 0) {
    return { name: 'IV', passed: true, strength: 0.7 + Math.min(0.3, confirming.length * 0.1),
      reason: `IV confirms: ${confirming.length} anomalies support ${direction} direction` };
  }

  return { name: 'IV', passed: true, strength: 0.5,
    reason: `${iv.anomalies.length} IV anomalies but direction ambiguous` };
}

// ── Direction inference from topology ────────────────────────────────────────

/**
 * Infer trade direction from topological signals.
 *
 * Priority order (causal first):
 *   1. Option flow consensus (sweeps/blocks are institutional footprints)
 *   2. IV anomaly consensus (market-maker positioning)
 *   3. Price topology (trend direction from the attractor shape)
 *
 * Returns neutral if signals conflict.
 */
function inferDirection(
  signal: TopologySignal,
  priceDirection: 'bullish' | 'bearish' | 'neutral',
): 'bullish' | 'bearish' | 'neutral' {
  // 1. Option flow consensus
  const directionalActions = signal.actions.filter(a =>
    (a.type === 'sweep' || a.type === 'block') &&
    a.direction !== 'neutral' &&
    a.confidence > 0.4
  );

  if (directionalActions.length > 0) {
    const bullish = directionalActions.filter(a => a.direction === 'bullish');
    const bearish = directionalActions.filter(a => a.direction === 'bearish');
    const bullishConf = bullish.reduce((s, a) => s + a.confidence, 0);
    const bearishConf = bearish.reduce((s, a) => s + a.confidence, 0);

    if (bullishConf > bearishConf * 1.5) return 'bullish';
    if (bearishConf > bullishConf * 1.5) return 'bearish';
  }

  // 2. IV anomaly consensus
  if (signal.iv && signal.iv.anomalies.length > 0) {
    const callBidUp = signal.iv.anomalies.filter(a => a.side === 'call' && a.direction === 'bid_up').length;
    const putBidUp = signal.iv.anomalies.filter(a => a.side === 'put' && a.direction === 'bid_up').length;
    if (callBidUp > putBidUp + 1) return 'bullish';
    if (putBidUp > callBidUp + 1) return 'bearish';
  }

  // 3. Fall back to price direction from the signal pipeline
  return priceDirection;
}

// ── Main entry model ─────────────────────────────────────────────────────────

// ── Time gate ────────────────────────────────────────────────────────────────

/**
 * TIME GATE — only allow new entries 30 min after market open and
 * stop 30 min before market close.
 *
 * Market hours: 09:30–16:00 ET.
 * Entry window: 10:00–15:30 ET.
 *
 * Reasoning:
 *   First 30 min: opening auction noise, gap fills, fake breakouts.
 *   The attractor hasn't formed yet — topology needs data to stabilize.
 *   Last 30 min: closing auction, EOD rebalancing, theta acceleration.
 *   Entering here has no room to run and maximum time-decay risk.
 */
function timeGate(timestamp: string): GateResult {
  const ts = new Date(timestamp);
  if (isNaN(ts.getTime())) {
    return { name: 'TIME', passed: false, strength: 0,
      reason: 'Invalid timestamp — blocking entry' };
  }
  // Convert to ET using Intl (handles EDT/EST automatically, locale-independent)
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(ts);
  const hour = parseInt(etParts.find(p => p.type === 'hour')!.value, 10);
  const minute = parseInt(etParts.find(p => p.type === 'minute')!.value, 10);
  const minutesSinceMidnight = hour * 60 + minute;

  const entryOpen = 10 * 60;       // 10:00 ET
  const entryClose = 15 * 60 + 30; // 15:30 ET

  if (minutesSinceMidnight < entryOpen) {
    return { name: 'TIME', passed: false, strength: 0,
      reason: `Before entry window (${hour}:${String(minute).padStart(2, '0')} ET < 10:00 ET) — opening auction noise` };
  }
  if (minutesSinceMidnight > entryClose) {
    return { name: 'TIME', passed: false, strength: 0,
      reason: `After entry window (${hour}:${String(minute).padStart(2, '0')} ET > 15:30 ET) — theta acceleration, no room to run` };
  }

  // Within the window: full strength
  return { name: 'TIME', passed: true, strength: 1.0,
    reason: `Within entry window (10:00–15:30 ET)` };
}

/**
 * Compute the topology entry signal.
 *
 * This replaces the additive confidence model with a regime-conditional
 * gate architecture.  Each gate either passes (with a strength) or blocks
 * (with a reason).  The final conviction is the PRODUCT of gate strengths,
 * not a sum — so a single failed gate produces zero conviction.
 *
 * @param topology  Full topology signal from computeTopologySignal().
 * @param priceDirection  Direction from the existing signal pipeline
 *                        (used as fallback when topology can't infer direction).
 * @param lastExitWasStop  True if the previous trade was stopped out.
 *                         When true, the STRUCTURE gate requires a fresh
 *                         structural break (bottleneck > 0.3) instead of
 *                         just stability — the attractor must prove a new
 *                         move has started before we re-enter.
 */
export function computeTopologyEntry(
  topology: TopologySignal,
  priceDirection: 'bullish' | 'bearish' | 'neutral' = 'neutral',
  consecutiveStops = 0,
): TopologyEntrySignal {
  const gates: GateResult[] = [];

  // Gate 0: Time — must be within entry window (10:00–15:30 ET)
  const tGate = timeGate(topology.timestamp);
  gates.push(tGate);
  if (!tGate.passed) {
    return {
      action: 'WAIT',
      direction: 'neutral',
      conviction: 0,
      regime: topology.price.regime,
      gates,
      supportingActions: [],
      reasoning: `BLOCKED by ${tGate.name}: ${tGate.reason}`,
    };
  }

  // Gate 1: Regime
  const rGate = regimeGate(topology.price);
  gates.push(rGate);
  if (!rGate.passed) {
    return {
      action: 'WAIT',
      direction: 'neutral',
      conviction: 0,
      regime: topology.price.regime,
      gates,
      supportingActions: [],
      reasoning: `BLOCKED by ${rGate.name}: ${rGate.reason}`,
    };
  }

  // Gate 2: Structure
  const sGate = structureGate(topology.price);
  gates.push(sGate);
  if (!sGate.passed) {
    return {
      action: 'WAIT',
      direction: 'neutral',
      conviction: 0,
      regime: topology.price.regime,
      gates,
      supportingActions: [],
      reasoning: `BLOCKED by ${sGate.name}: ${sGate.reason}`,
    };
  }

  // Gate 2b: CHOP GUARD — escalating re-entry bar after consecutive stops.
  //
  // Each stop-loss is evidence that the topology isn't predicting well.
  // Rather than an arbitrary cooldown, we require progressively stronger
  // topological confirmation:
  //   1 stop:  need bottleneck > 0.25 (clear structural change)
  //   2+ stops: BLOCKED — topology has failed for this session, stop trading
  //
  // This uses the topology's own signal (bottleneck) to gate re-entry,
  // not an arbitrary timer.  A strong structural break resets the count
  // because it means the attractor genuinely changed.
  // Gate 2b: CHOP GUARD — after consecutive stop-losses, require
  // progressively stronger topology confirmation before re-entering.
  //
  //   1 stop:  require bottleneck > 0.25 (clear structural change)
  //   2+ stops: HALT — topology not predictive, stop entering
  //
  // A winning trade resets the counter (the topology worked).
  if (consecutiveStops > 0) {
    if (consecutiveStops >= 2) {
      const chopGate: GateResult = {
        name: 'CHOP_GUARD',
        passed: false,
        strength: 0,
        reason: `${consecutiveStops} consecutive stops — halting entries for session`,
      };
      gates.push(chopGate);
      return {
        action: 'WAIT',
        direction: 'neutral',
        conviction: 0,
        regime: topology.price.regime,
        gates,
        supportingActions: [],
        reasoning: `BLOCKED by ${chopGate.name}: ${chopGate.reason}`,
      };
    }

    const requiredBn = 0.25;
    if (topology.price.bottleneckDistance < requiredBn) {
      const chopGate: GateResult = {
        name: 'CHOP_GUARD',
        passed: false,
        strength: 0,
        reason: `${consecutiveStops} stop(s) — need bn > ${requiredBn.toFixed(2)} (got ${topology.price.bottleneckDistance.toFixed(3)})`,
      };
      gates.push(chopGate);
      return {
        action: 'WAIT',
        direction: 'neutral',
        conviction: 0,
        regime: topology.price.regime,
        gates,
        supportingActions: [],
        reasoning: `BLOCKED by ${chopGate.name}: ${chopGate.reason}`,
      };
    }
  }

  // Infer direction before flow/IV gates need it
  const direction = inferDirection(topology, priceDirection);
  if (direction === 'neutral') {
    return {
      action: 'WAIT',
      direction: 'neutral',
      conviction: 0,
      regime: topology.price.regime,
      gates,
      supportingActions: [],
      reasoning: 'No directional consensus from topology — flow, IV, and price signals conflict',
    };
  }

  // Direction conflict gate: if topology infers a different direction than
  // price momentum, that's a conflict — don't enter.  On reversal days the
  // simulated flow lags the price turn, causing whipsaw entries.
  if (priceDirection !== 'neutral' && direction !== priceDirection) {
    return {
      action: 'WAIT',
      direction: 'neutral',
      conviction: 0,
      regime: topology.price.regime,
      gates,
      supportingActions: [],
      reasoning: `Direction conflict: price=${priceDirection} vs topology=${direction} — waiting for alignment`,
    };
  }

  // Gate 3: Flow (optional — doesn't block if data absent)
  const fGate = flowGate(topology.chain, topology.actions, direction);
  gates.push(fGate);
  if (!fGate.passed) {
    return {
      action: 'WAIT',
      direction,
      conviction: 0,
      regime: topology.price.regime,
      gates,
      supportingActions: [],
      reasoning: `BLOCKED by ${fGate.name}: ${fGate.reason}`,
    };
  }

  // Gate 4: IV (optional — soft modifier)
  const iGate = ivGate(topology.iv, direction);
  gates.push(iGate);
  if (!iGate.passed) {
    return {
      action: 'WAIT',
      direction,
      conviction: 0,
      regime: topology.price.regime,
      gates,
      supportingActions: [],
      reasoning: `BLOCKED by ${iGate.name}: ${iGate.reason}`,
    };
  }

  // All gates passed — compute conviction as PRODUCT of strengths
  const conviction = gates.reduce((prod, g) => prod * g.strength, 1);

  // Collect supporting actions
  const supportingActions = topology.actions.filter(a =>
    a.direction === direction && a.confidence > 0.3
  );

  // Build reasoning
  const gateReasons = gates.map(g => `${g.name}(${g.strength.toFixed(2)}): ${g.reason}`);
  const reasoning = `ENTER ${direction.toUpperCase()} — conviction=${conviction.toFixed(3)} ` +
    `[${topology.price.regime}]\n  ${gateReasons.join('\n  ')}`;

  return {
    action: 'ENTER',
    direction,
    conviction,
    regime: topology.price.regime,
    gates,
    supportingActions,
    reasoning,
  };
}

// ── Exit model ───────────────────────────────────────────────────────────────

/**
 * Compute topology exit signal for an active position.
 *
 * Topology detects exits that no P&L-based stop can:
 *
 *   1. REGIME BREAK: the price attractor changed structure.
 *      A trending position in a now-fragmented market should exit
 *      even if P&L is positive (the trend no longer exists).
 *
 *   2. FLOW REVERSAL: institutional flow reversed direction.
 *      A bullish position seeing bearish sweeps should exit
 *      before the price catches up to the flow.
 *
 *   3. IV OPPOSITION: someone is aggressively positioning against us.
 *      IV anomalies at our strike in the opposing direction signal
 *      smart money expects our position to lose.
 *
 * @param topology  Current topology signal.
 * @param positionDirection  Direction of the active position.
 * @param entryRegime  Regime when the position was entered.
 */
export function computeTopologyExit(
  topology: TopologySignal,
  positionDirection: 'bullish' | 'bearish',
  entryRegime: PriceRegime,
): TopologyEntrySignal {
  const gates: GateResult[] = [];
  const exitReasons: string[] = [];

  // Check 1: Regime break
  const currentRegime = topology.price.regime;
  const regimeBroke = (entryRegime === 'trending' && currentRegime === 'fragmented') ||
                      (entryRegime === 'ranging' && (currentRegime === 'trending' || currentRegime === 'fragmented'));

  if (regimeBroke) {
    exitReasons.push(`Regime changed: ${entryRegime} → ${currentRegime}`);
    gates.push({
      name: 'REGIME_BREAK',
      passed: true,
      strength: 0.8,
      reason: `Entry regime (${entryRegime}) no longer holds — now ${currentRegime}`,
    });
  }

  // Check 2: Large bottleneck spike (structural break while in position)
  // Regime-aware threshold: trending regimes naturally produce bottleneck noise
  // as the attractor stretches.  Only exit on extreme spikes (> 1.0).
  // Ranging/transitioning regimes use a lower threshold (> 0.5) because
  // any structural change threatens the premise of the trade.
  const bnThreshold = entryRegime === 'trending' ? 1.0 : 0.5;
  if (topology.price.bottleneckDistance > bnThreshold) {
    exitReasons.push(`Structural break: bottleneck=${topology.price.bottleneckDistance.toFixed(3)} > ${bnThreshold}`);
    gates.push({
      name: 'STRUCTURAL_BREAK',
      passed: true,
      strength: Math.min(1, topology.price.bottleneckDistance / (bnThreshold * 2)),
      reason: `Attractor shape changed (bn=${topology.price.bottleneckDistance.toFixed(3)}, threshold=${bnThreshold} for ${entryRegime})`,
    });
  }

  // Check 3: Opposing flow — requires opposing to DOMINATE confirming flow.
  // ATM puts always have volume on an up-trending day (hedging).  Only exit
  // when opposing flow is significantly stronger than confirming flow,
  // meaning institutions are actively reversing, not just hedging.
  const opposingDir = positionDirection === 'bullish' ? 'bearish' : 'bullish';
  const confirmingDir = positionDirection;
  const opposingFlow = topology.actions.filter(a =>
    (a.type === 'sweep' || a.type === 'block') &&
    a.direction === opposingDir &&
    a.confidence > 0.5
  );
  const confirmingFlow = topology.actions.filter(a =>
    (a.type === 'sweep' || a.type === 'block') &&
    a.direction === confirmingDir &&
    a.confidence > 0.3
  );

  if (opposingFlow.length > 0) {
    const opposingStrength = opposingFlow.reduce((s, a) => s + a.confidence, 0);
    const confirmingStrength = confirmingFlow.reduce((s, a) => s + a.confidence, 0);

    // Only trigger exit when opposing flow dominates (> 2× confirming)
    if (opposingStrength > confirmingStrength * 2) {
      const strongest = opposingFlow.reduce((best, a) => a.confidence > best.confidence ? a : best, opposingFlow[0]!);
      const ratio = confirmingStrength > 0 ? opposingStrength / confirmingStrength : 10;
      exitReasons.push(`Opposing flow dominates: ${strongest.description} (opp/conf ratio=${ratio.toFixed(1)})`);
      gates.push({
        name: 'FLOW_REVERSAL',
        passed: true,
        strength: Math.min(1, strongest.confidence * (ratio / 5)),
        reason: `${strongest.description} — opposing ${opposingStrength.toFixed(2)} vs confirming ${confirmingStrength.toFixed(2)}`,
      });
    }
  }

  // Check 4: IV opposition at our strikes
  if (topology.iv) {
    const opposingIV = topology.iv.anomalies.filter(a => {
      if (positionDirection === 'bullish') {
        return (a.side === 'put' && a.direction === 'bid_up') ||
               (a.side === 'call' && a.direction === 'offered_down');
      }
      return (a.side === 'call' && a.direction === 'bid_up') ||
             (a.side === 'put' && a.direction === 'offered_down');
    });

    if (opposingIV.length >= 2) {
      const avgZ = opposingIV.reduce((s, a) => s + Math.abs(a.zScore), 0) / opposingIV.length;
      if (avgZ > 2.0) {
        exitReasons.push(`IV opposition: ${opposingIV.length} anomalies (avg z=${avgZ.toFixed(1)})`);
        gates.push({
          name: 'IV_OPPOSITION',
          passed: true,
          strength: Math.min(1, avgZ / 4),
          reason: `${opposingIV.length} opposing IV anomalies (avg z=${avgZ.toFixed(1)})`,
        });
      }
    }
  }

  // No exit signals → hold
  if (exitReasons.length === 0) {
    return {
      action: 'WAIT',
      direction: positionDirection,
      conviction: 0,
      regime: currentRegime,
      gates: [{
        name: 'NO_EXIT_SIGNAL',
        passed: false,
        strength: 0,
        reason: 'No topological exit conditions met — hold',
      }],
      supportingActions: [],
      reasoning: 'HOLD — no topological exit signals',
    };
  }

  // Exit conviction = max gate strength (not product — any single strong reason suffices)
  const exitConviction = Math.max(...gates.map(g => g.strength));

  return {
    action: 'EXIT',
    direction: positionDirection,
    conviction: exitConviction,
    regime: currentRegime,
    gates,
    supportingActions: opposingFlow,
    reasoning: `EXIT ${positionDirection.toUpperCase()} — conviction=${exitConviction.toFixed(3)}\n  ${exitReasons.join('\n  ')}`,
  };
}

/**
 * Format a topology entry/exit signal as a human-readable string.
 */
export function formatEntrySignal(signal: TopologyEntrySignal): string {
  const lines: string[] = [];
  lines.push(`[Topology ${signal.action}] ${signal.direction} conviction=${signal.conviction.toFixed(3)} regime=${signal.regime}`);
  for (const g of signal.gates) {
    const icon = g.passed ? '+' : 'x';
    lines.push(`  ${icon} ${g.name}(${g.strength.toFixed(2)}): ${g.reason}`);
  }
  if (signal.supportingActions.length > 0) {
    lines.push(`  Supporting actions:`);
    for (const a of signal.supportingActions.slice(0, 5)) {
      lines.push(`    [${a.confidence.toFixed(2)}] ${a.type}: ${a.description}`);
    }
  }
  return lines.join('\n');
}
