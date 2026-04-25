/**
 * backtest-cache.ts — Shared content-hash cache for backtest scripts.
 *
 * Used by validate-change.ts (per-window aggregate), backtest-day.ts (per-day
 * stdout), and backtest-signal-quality.ts (optional aggregate). The cache key
 * is a SHA1 of the content of STASH_PATHS — i.e. the files that actually
 * affect backtest behavior. Reruns at the same code state replay instantly.
 *
 * Cache directory: .validate-cache/ (gitignored)
 *
 * Two file naming schemes share the dir:
 *   backtest-{TICKER}-{START}-{END}-{HASH}.json   (window aggregate)
 *   day-{TICKER}-{DATE}-{HASH}.json               (per-day stdout)
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join as pathJoin } from 'path';
import { createHash } from 'crypto';

export const AUTO_CACHE_DIR = '.validate-cache';

// Only paths that actually affect backtest behavior. The harness and
// signal-quality script live in src/scripts/ but must remain present in both
// baseline and candidate runs, so they're excluded.
export const STASH_PATHS = [
  'src/strategies/', 'src/lib/', 'src/agents/',
  'src/types/', 'src/ticker-configs.ts',
  'src/scripts/backtest-day.ts', 'src/scripts/backtest-configs/',
];

function sh(cmd: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** SHA1 of HEAD's STASH_PATHS tree — invalidates on commit. */
export function hashStashPathsAtHead(): string {
  const out = sh(`git ls-tree -r HEAD -- ${STASH_PATHS.join(' ')}`);
  return createHash('sha1').update(out).digest('hex').slice(0, 12);
}

/** SHA1 of STASH_PATHS in the working tree (tracked + untracked, gitignore-respecting). */
export function hashStashPathsInWorkingTree(): string {
  const files = sh(`git ls-files -c -o --exclude-standard -- ${STASH_PATHS.join(' ')}`)
    .trim().split('\n').filter(Boolean).sort();
  const h = createHash('sha1');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    try { h.update(readFileSync(f)); } catch { /* deleted file — just record path */ }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

export function windowCachePathFor(ticker: string, start: string, end: string, hash: string): string {
  return pathJoin(AUTO_CACHE_DIR, `backtest-${ticker}-${start}-${end}-${hash}.json`);
}

export function dayCachePathFor(ticker: string, date: string, hash: string): string {
  return pathJoin(AUTO_CACHE_DIR, `day-${ticker}-${date}-${hash}.json`);
}

export function loadCachedJSON<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function saveCachedJSON(path: string, data: unknown): void {
  mkdirSync(AUTO_CACHE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

/**
 * Drop window caches for {ticker, start, end} whose hash is not in keepHashes.
 * Other windows / tickers are untouched.
 */
export function pruneStaleWindowCaches(
  ticker: string, start: string, end: string, keepHashes: ReadonlyArray<string>,
): number {
  if (!existsSync(AUTO_CACHE_DIR)) return 0;
  const prefix = `backtest-${ticker}-${start}-${end}-`;
  let removed = 0;
  for (const f of readdirSync(AUTO_CACHE_DIR)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    const hash = f.slice(prefix.length, -'.json'.length);
    if (keepHashes.includes(hash)) continue;
    try { unlinkSync(pathJoin(AUTO_CACHE_DIR, f)); removed++; } catch { /* ignore */ }
  }
  return removed;
}

/**
 * Drop per-day caches for {ticker} whose hash is not in keepHashes.
 * Used by validate-change to keep day-* files bounded at ≤2 hashes per ticker.
 */
export function pruneStaleDayCaches(ticker: string, keepHashes: ReadonlyArray<string>): number {
  if (!existsSync(AUTO_CACHE_DIR)) return 0;
  const prefix = `day-${ticker}-`;
  let removed = 0;
  for (const f of readdirSync(AUTO_CACHE_DIR)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    // file: day-{TICKER}-{DATE}-{HASH}.json — hash is the last dash-sep token before .json
    const stem = f.slice(0, -'.json'.length);
    const lastDash = stem.lastIndexOf('-');
    if (lastDash < 0) continue;
    const hash = stem.slice(lastDash + 1);
    if (keepHashes.includes(hash)) continue;
    try { unlinkSync(pathJoin(AUTO_CACHE_DIR, f)); removed++; } catch { /* ignore */ }
  }
  return removed;
}
