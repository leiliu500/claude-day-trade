/**
 * Market Topology Module — topological data analysis for option action detection.
 *
 * Entry points:
 *   computeTopologySignal()  — full analysis (price + options + IV)
 *   formatTopologySignal()   — human-readable summary
 *   computePriceTopology()   — price-only analysis (no API calls)
 */

export { computeTopologySignal, formatTopologySignal } from './topology-engine.js';
export { computeTopologyEntry, computeTopologyExit, formatEntrySignal } from './entry-model.js';
export { computePriceTopology } from './price-topology.js';
export { computeChainTopology } from './chain-topology.js';
export { computeIVTopology } from './iv-topology.js';
export { computePersistentHomology, superLevelPersistence, bottleneckDistance } from './persistent-homology.js';
export { scanOptionChain } from './option-scanner.js';
export type { TopologyEntrySignal, GateResult } from './entry-model.js';
export type {
  TopologySignal,
  OptionAction,
  OptionActionType,
  PriceTopology,
  PriceRegime,
  ChainTopology,
  ChainContract,
  VolumeCluster,
  IVTopology,
  IVAnomaly,
  PersistenceDiagram,
  PersistencePair,
} from './types.js';
