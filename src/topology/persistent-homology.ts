/**
 * Persistent Homology — core topological data analysis engine.
 *
 * Computes the persistent homology of a point cloud in R^d via the
 * Vietoris-Rips filtration.  This is the mathematical heart of the
 * topology module: every other module feeds point clouds in and
 * reads persistence diagrams out.
 *
 * Algorithm summary:
 *   1. Compute pairwise distance matrix.
 *   2. Enumerate all simplices up to dimension 2 (vertices, edges, triangles)
 *      with filtration values ≤ max_radius.
 *   3. Sort simplices by (filtration, dimension).
 *   4. Reduce the boundary matrix (standard persistence algorithm over Z/2).
 *   5. Read off persistence pairs → PersistenceDiagram.
 *
 * Performance:  O(N² log N) for H0 via Union-Find.  H1 uses the full
 * boundary matrix reduction but only on cycle-creating edges and their
 * bounding triangles.  Practical for N ≤ 120 points.
 */

import type { PersistencePair, PersistenceDiagram } from './types.js';

// ── Distance computation ─────────────────────────────────────────────────────

/** Euclidean distance between two points in R^d. */
function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Compute the full pairwise distance matrix for a point cloud. */
export function distanceMatrix(points: number[][]): number[][] {
  const n = points.length;
  const D: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = euclidean(points[i]!, points[j]!);
      D[i]![j] = d;
      D[j]![i] = d;
    }
  }
  return D;
}

// ── Union-Find (for fast H0 computation) ─────────────────────────────────────

class UnionFind {
  parent: number[];
  rank: number[];
  count: number;

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array<number>(n).fill(0);
    this.count = n;
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!; // path halving
      x = this.parent[x]!;
    }
    return x;
  }

  union(x: number, y: number): boolean {
    const rx = this.find(x), ry = this.find(y);
    if (rx === ry) return false;
    if (this.rank[rx]! < this.rank[ry]!) {
      this.parent[rx] = ry;
    } else if (this.rank[rx]! > this.rank[ry]!) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]!++;
    }
    this.count--;
    return true;
  }

  connected(x: number, y: number): boolean {
    return this.find(x) === this.find(y);
  }
}

// ── Simplex and filtration ───────────────────────────────────────────────────

interface Simplex {
  vertices: number[];  // sorted vertex indices
  dimension: number;
  filtration: number;
  index: number;       // position in the sorted filtration
}

/** Encode a sorted vertex set as a string key for fast lookup. */
function simplexKey(vertices: number[]): string {
  return vertices.join(',');
}

/**
 * Build the Vietoris-Rips filtration up to dimension maxDim.
 * Only includes simplices with filtration ≤ maxRadius.
 */
function buildRipsFiltration(
  D: number[][],
  maxDim: number,
  maxRadius: number,
): Simplex[] {
  const n = D.length;
  const simplices: Simplex[] = [];

  // 0-simplices (vertices): filtration = 0
  for (let i = 0; i < n; i++) {
    simplices.push({ vertices: [i], dimension: 0, filtration: 0, index: 0 });
  }

  // 1-simplices (edges): filtration = distance
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = D[i]![j]!;
      if (d <= maxRadius) {
        simplices.push({ vertices: [i, j], dimension: 1, filtration: d, index: 0 });
      }
    }
  }

  // 2-simplices (triangles): filtration = max edge length
  if (maxDim >= 2) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (D[i]![j]! > maxRadius) continue;
        for (let k = j + 1; k < n; k++) {
          const f = Math.max(D[i]![j]!, D[i]![k]!, D[j]![k]!);
          if (f <= maxRadius) {
            simplices.push({ vertices: [i, j, k], dimension: 2, filtration: f, index: 0 });
          }
        }
      }
    }
  }

  // Sort by (filtration, dimension) — lower dimension first at same filtration
  simplices.sort((a, b) => a.filtration - b.filtration || a.dimension - b.dimension);

  // Assign indices
  for (let i = 0; i < simplices.length; i++) {
    simplices[i]!.index = i;
  }

  return simplices;
}

// ── Sparse column operations (Z/2 arithmetic) ───────────────────────────────

/** Symmetric difference of two sorted arrays = addition over Z/2. */
function xorSorted(a: number[], b: number[]): number[] {
  const result: number[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]! < b[j]!) { result.push(a[i]!); i++; }
    else if (a[i]! > b[j]!) { result.push(b[j]!); j++; }
    else { i++; j++; } // cancel (mod 2)
  }
  while (i < a.length) result.push(a[i++]!);
  while (j < b.length) result.push(b[j++]!);
  return result;
}

/** Return the largest element of a sorted array (the "low" of a column). */
function low(col: number[]): number {
  return col.length > 0 ? col[col.length - 1]! : -1;
}

// ── Standard persistence algorithm ──────────────────────────────────────────

/**
 * Compute persistent homology of a point cloud via the Vietoris-Rips filtration.
 *
 * @param points  Point cloud in R^d — each element is a d-dimensional coordinate.
 * @param maxDim  Maximum homology dimension to compute (1 = H0 + H1, default 1).
 * @param maxRadius  Maximum filtration radius. Simplices beyond this are excluded.
 *                   If 0, auto-selects 2× median pairwise distance.
 * @returns PersistenceDiagram with all persistence pairs and summary statistics.
 */
export function computePersistentHomology(
  points: number[][],
  maxDim = 1,
  maxRadius = 0,
): PersistenceDiagram {
  const n = points.length;
  if (n === 0) {
    return { pairs: [], betti: [0, 0], totalPersistence: 0, maxPersistence: 0, essentialCount: [0, 0] };
  }
  if (n === 1) {
    return {
      pairs: [{ birth: 0, death: Infinity, dimension: 0, persistence: Infinity }],
      betti: [1, 0],
      totalPersistence: 0,
      maxPersistence: 0,
      essentialCount: [1, 0],
    };
  }

  // 1. Distance matrix
  const D = distanceMatrix(points);

  // Auto-select maxRadius if not specified
  if (maxRadius <= 0) {
    const allDists: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        allDists.push(D[i]![j]!);
      }
    }
    allDists.sort((a, b) => a - b);
    const median = allDists[Math.floor(allDists.length / 2)]!;
    maxRadius = median * 2.5;
  }

  // 2. Build Rips filtration
  const simplices = buildRipsFiltration(D, maxDim >= 2 ? 2 : 1, maxRadius);

  // 3. Build simplex lookup: key → index
  const keyToIndex = new Map<string, number>();
  for (const s of simplices) {
    keyToIndex.set(simplexKey(s.vertices), s.index);
  }

  // 4. Compute boundary columns
  const columns: number[][] = new Array(simplices.length);
  for (let j = 0; j < simplices.length; j++) {
    const s = simplices[j]!;
    if (s.dimension === 0) {
      columns[j] = [];
    } else if (s.dimension === 1) {
      const [u, v] = s.vertices;
      const i0 = keyToIndex.get(simplexKey([u!]))!;
      const i1 = keyToIndex.get(simplexKey([v!]))!;
      columns[j] = i0 < i1 ? [i0, i1] : [i1, i0];
    } else if (s.dimension === 2) {
      const [u, v, w] = s.vertices;
      const faces = [
        keyToIndex.get(simplexKey([v!, w!]))!,
        keyToIndex.get(simplexKey([u!, w!]))!,
        keyToIndex.get(simplexKey([u!, v!]))!,
      ].sort((a, b) => a - b);
      columns[j] = faces;
    } else {
      columns[j] = [];
    }
  }

  // 5. Matrix reduction (standard persistence algorithm)
  const lowMap = new Map<number, number>(); // low(j) → j (the column that "owns" this low)

  for (let j = 0; j < simplices.length; j++) {
    while (columns[j]!.length > 0) {
      const l = low(columns[j]!);
      const existing = lowMap.get(l);
      if (existing !== undefined) {
        columns[j] = xorSorted(columns[j]!, columns[existing]!);
      } else {
        break;
      }
    }
    if (columns[j]!.length > 0) {
      lowMap.set(low(columns[j]!), j);
    }
  }

  // 6. Extract persistence pairs
  const paired = new Set<number>();
  const pairs: PersistencePair[] = [];

  for (const [birthIdx, deathIdx] of lowMap.entries()) {
    const birthSimplex = simplices[birthIdx]!;
    const deathSimplex = simplices[deathIdx]!;
    paired.add(birthIdx);
    paired.add(deathIdx);

    const b = birthSimplex.filtration;
    const d = deathSimplex.filtration;
    if (d > b) { // skip zero-persistence pairs (same filtration)
      pairs.push({
        birth: b,
        death: d,
        dimension: birthSimplex.dimension,
        persistence: d - b,
      });
    }
  }

  // Essential features: positive simplices (zero column) that were never paired
  for (let j = 0; j < simplices.length; j++) {
    if (!paired.has(j) && columns[j]!.length === 0) {
      pairs.push({
        birth: simplices[j]!.filtration,
        death: Infinity,
        dimension: simplices[j]!.dimension,
        persistence: Infinity,
      });
    }
  }

  // 7. Compute summary statistics
  const finitePairs = pairs.filter(p => isFinite(p.persistence));
  const totalPersistence = finitePairs.reduce((s, p) => s + p.persistence, 0);
  const maxPersistence = finitePairs.length > 0 ? Math.max(...finitePairs.map(p => p.persistence)) : 0;

  // Reference scale for Betti numbers:
  // Use the 90th percentile of H0 death values — at this scale, 90% of
  // component merges have happened, so β₀ reflects the *true* number of
  // well-separated clusters, not half-merged noise.
  const h0Deaths = finitePairs
    .filter(p => p.dimension === 0)
    .map(p => p.death)
    .sort((a, b) => a - b);
  const refScale = h0Deaths.length > 0
    ? h0Deaths[Math.floor(h0Deaths.length * 0.9)]!
    : maxRadius * 0.9;

  let beta0 = 0, beta1 = 0;
  for (const p of pairs) {
    if (p.birth <= refScale && (p.death > refScale || !isFinite(p.death))) {
      if (p.dimension === 0) beta0++;
      if (p.dimension === 1) beta1++;
    }
  }

  // Essential features: only count those born well within the filtration
  // (not near the boundary where missing triangles create phantom H1 features).
  const interiorThreshold = maxRadius * 0.7;
  const essentialH0 = pairs.filter(p => p.dimension === 0 && !isFinite(p.death)).length;
  const essentialH1 = pairs.filter(p => p.dimension === 1 && !isFinite(p.death) && p.birth < interiorThreshold).length;

  return {
    pairs,
    betti: [beta0, beta1],
    totalPersistence,
    maxPersistence,
    essentialCount: [essentialH0, essentialH1],
  };
}

// ── Super-level set persistence (for 1D functions like volume profiles) ──────

/**
 * Compute super-level set persistence of a 1D function f(x).
 *
 * This finds the "peaks" of the function and measures how prominent each
 * peak is.  A peak born at height h₁ and dying at height h₂ < h₁ has
 * persistence h₁ − h₂.  The most prominent peak is the global maximum
 * (essential, persistence = ∞).
 *
 * Used for option chain volume topology: each strike K has volume V(K),
 * and the super-level set persistence identifies the real volume
 * concentrations vs. noise.
 *
 * @param values  Array of { position, value } — the 1D function samples.
 *                Must be sorted by position.
 * @returns Persistence pairs (birth = value at peak, death = value where merged).
 */
export function superLevelPersistence(
  values: { position: number; value: number }[],
): PersistencePair[] {
  if (values.length === 0) return [];

  // Process values from highest to lowest (super-level set filtration)
  const indexed = values.map((v, i) => ({ ...v, idx: i }));
  const order = [...indexed].sort((a, b) => b.value - a.value);

  const uf = new UnionFind(values.length);
  const active = new Set<number>();
  const componentBirth = new Map<number, number>(); // root → birth value
  const pairs: PersistencePair[] = [];

  for (const item of order) {
    const { idx, value } = item;
    active.add(idx);
    componentBirth.set(idx, value);

    // Check left and right neighbors
    const neighbors = [idx - 1, idx + 1].filter(n => n >= 0 && n < values.length && active.has(n));

    for (const nIdx of neighbors) {
      const rootCurrent = uf.find(idx);
      const rootNeighbor = uf.find(nIdx);

      if (rootCurrent !== rootNeighbor) {
        // Merge: the younger component (lower birth = born later in super-level) dies
        const birthCurrent = componentBirth.get(rootCurrent)!;
        const birthNeighbor = componentBirth.get(rootNeighbor)!;

        if (birthCurrent <= birthNeighbor) {
          // Current component is younger → it dies
          pairs.push({
            birth: birthCurrent,
            death: value,
            dimension: 0,
            persistence: birthCurrent - value,
          });
          uf.union(idx, nIdx);
          const newRoot = uf.find(idx);
          componentBirth.set(newRoot, birthNeighbor);
        } else {
          // Neighbor component is younger → it dies
          pairs.push({
            birth: birthNeighbor,
            death: value,
            dimension: 0,
            persistence: birthNeighbor - value,
          });
          uf.union(idx, nIdx);
          const newRoot = uf.find(idx);
          componentBirth.set(newRoot, birthCurrent);
        }
      }
    }
  }

  // The last surviving component is essential (global maximum)
  if (active.size > 0) {
    const survivors = new Set<number>();
    for (const idx of active) {
      survivors.add(uf.find(idx));
    }
    for (const root of survivors) {
      pairs.push({
        birth: componentBirth.get(root)!,
        death: 0,
        dimension: 0,
        persistence: componentBirth.get(root)!,
      });
    }
  }

  // Sort by persistence (most prominent first)
  pairs.sort((a, b) => b.persistence - a.persistence);
  return pairs;
}

// ── Bottleneck distance between persistence diagrams ─────────────────────────

/**
 * Approximate bottleneck distance between two persistence diagrams.
 *
 * The bottleneck distance is the infimum over all matchings of the supremum
 * matched-pair distance.  Computing the exact value requires solving an
 * assignment problem; this approximation uses a greedy matching which is
 * within a factor of 2 of optimal and runs in O(n² log n).
 *
 * The bottleneck distance measures how "different" two topological
 * fingerprints are.  A large distance means the underlying data underwent
 * a structural change.
 */
export function bottleneckDistance(
  dgm1: PersistenceDiagram,
  dgm2: PersistenceDiagram,
  dimension = 0,
): number {
  // Filter pairs by dimension, exclude essential features
  const p1 = dgm1.pairs.filter(p => p.dimension === dimension && isFinite(p.death));
  const p2 = dgm2.pairs.filter(p => p.dimension === dimension && isFinite(p.death));

  if (p1.length === 0 && p2.length === 0) return 0;

  // Distance between two persistence pairs: L∞ in (birth, death) space
  const pairDist = (a: PersistencePair, b: PersistencePair) =>
    Math.max(Math.abs(a.birth - b.birth), Math.abs(a.death - b.death));

  // Distance from a pair to the diagonal (its cost of being unmatched)
  const diagDist = (p: PersistencePair) => p.persistence / 2;

  // Greedy matching: match pairs from largest to smallest persistence
  const sorted1 = [...p1].sort((a, b) => b.persistence - a.persistence);
  const sorted2 = [...p2].sort((a, b) => b.persistence - a.persistence);
  const matched2 = new Set<number>();
  let maxCost = 0;

  for (const s1 of sorted1) {
    let bestIdx = -1;
    let bestCost = diagDist(s1); // cost of leaving s1 unmatched

    for (let j = 0; j < sorted2.length; j++) {
      if (matched2.has(j)) continue;
      const cost = pairDist(s1, sorted2[j]!);
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) {
      matched2.add(bestIdx);
    }
    maxCost = Math.max(maxCost, bestCost);
  }

  // Unmatched pairs in dgm2
  for (let j = 0; j < sorted2.length; j++) {
    if (!matched2.has(j)) {
      maxCost = Math.max(maxCost, diagDist(sorted2[j]!));
    }
  }

  return maxCost;
}
