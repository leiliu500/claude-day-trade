/**
 * Level Cache — stateful per-ticker level tracking across ticks.
 *
 * Tracks touch count, freshness transitions, and last-tested time for each
 * level. The level engine computes raw levels each tick; this cache layer
 * maintains their lifecycle state.
 */

import type { PriceLevel } from '../types/levels.js';

const TOUCH_ZONE_ATR_MULT = 0.15; // within 0.15 ATR = "touching" a level

export class LevelCache {
  private levels: Map<string, PriceLevel> = new Map();
  private atr: number = 0;

  /** Unique key for a level (type + price rounded to avoid float noise). */
  private key(level: PriceLevel): string {
    return `${level.type}:${level.price.toFixed(2)}`;
  }

  /**
   * Update the cache with newly computed levels. Preserves touch count and
   * freshness from prior ticks for levels that still exist.
   */
  updateLevels(newLevels: PriceLevel[], currentPrice: number, atr: number): PriceLevel[] {
    this.atr = atr;
    const touchZone = atr * TOUCH_ZONE_ATR_MULT;
    const updated: PriceLevel[] = [];

    for (const level of newLevels) {
      const k = this.key(level);
      const existing = this.levels.get(k);

      const distance = Math.abs(currentPrice - level.price);
      const isTouching = distance <= touchZone;

      let freshness = level.freshness;
      let touchCount = existing?.touchCount ?? 0;
      let lastTestedAt = existing?.lastTestedAt;

      if (isTouching) {
        // Price is at this level
        if (!existing || existing.freshness === 'fresh') {
          freshness = 'tested';
          touchCount++;
          lastTestedAt = new Date().toISOString();
        } else {
          freshness = existing.freshness;
        }
      } else if (existing) {
        // Price moved away — check if level was broken
        const wasAbove = existing.freshness === 'tested' || existing.freshness === 'fresh';
        const brokeThrough =
          (currentPrice > level.price + touchZone && existing.freshness === 'tested') ||
          (currentPrice < level.price - touchZone && existing.freshness === 'tested');

        if (brokeThrough) {
          freshness = 'broken';
        } else {
          freshness = existing.freshness;
        }
        touchCount = existing.touchCount;
        lastTestedAt = existing.lastTestedAt;
      }

      const updatedLevel: PriceLevel = {
        ...level,
        freshness,
        touchCount,
        lastTestedAt,
      };

      this.levels.set(k, updatedLevel);
      updated.push(updatedLevel);
    }

    // Remove stale levels that no longer appear in the new set
    const newKeys = new Set(newLevels.map(l => this.key(l)));
    for (const k of this.levels.keys()) {
      if (!newKeys.has(k)) this.levels.delete(k);
    }

    return updated;
  }

  /** Get all cached levels. */
  getLevels(): PriceLevel[] {
    return Array.from(this.levels.values());
  }

  /** Reset cache (e.g. at start of new session). */
  clear(): void {
    this.levels.clear();
    this.atr = 0;
  }
}
