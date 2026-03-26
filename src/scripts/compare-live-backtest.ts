/**
 * compare-live-backtest.ts — Compare live trading decisions against backtest predictions.
 *
 * Queries the DB for live decisions on a given date, runs the backtest for the same day,
 * and outputs a side-by-side comparison showing alignment and divergence.
 *
 * Usage:
 *   npx tsx src/scripts/compare-live-backtest.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: today (ET), SPY
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { getPool, closePool } from '../db/client.js';

// ── Config ────────────────────────────────────────────────────────────────────

const now = new Date();
const etNow = new Date(now.getTime() - 4 * 60 * 60_000);
const DEFAULT_DATE = etNow.toISOString().slice(0, 10);

const TARGET_DATE = process.argv[2] || DEFAULT_DATE;
const TICKER = process.argv[3] || 'SPY';

// ── Helpers ───────────────────────────────────────────────────────────────────

function utcToET(utcTime: string): string {
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4); // EDT
  return d.toISOString().slice(11, 16);
}

function etToMinutes(et: string): number {
  const [h, m] = et.split(':').map(Number);
  return h! * 60 + m!;
}

interface LiveDecision {
  id: string;
  decision_type: string;
  direction: string | null;
  confirmation_count: number;
  orchestration_confidence: number;
  reasoning: string;
  should_execute: boolean;
  entry_strategy: {
    stage?: string;
    confirmation_count?: number;
    notes?: string;
  } | null;
  created_at: string;
  position_id: string | null;
  entry_price: number | null;
  exit_price: number | null;
  close_reason: string | null;
  realized_pnl: number | null;
}

interface BacktestEntry {
  timeET: string;
  timeUTC: string;
  direction: string;
  alignment: string;
  confidence: number;
  price: number;
  maxFavorable: number;
  maxAdverse: number;
  outcome: string;
  gateResult: string;
  stage1Conf?: number;
  signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion';
}

// ── Parse backtest output ─────────────────────────────────────────────────────

function parseBacktestOutput(output: string): BacktestEntry[] {
  const entries: BacktestEntry[] = [];
  const lines = output.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Match: "  Entry #N: ✅ GOOD | 🟢 CONFIRMED [RANGE]"
    const entryMatch = line.match(/Entry #\d+:\s+(?:✅|❌|⚠️)\s*\s*(GOOD|BAD|MARGINAL)\s*\|\s*(?:🟢|🔵|🔴|🟡|⚡)\s*(.+?)(?:\s*←.*)?$/);
    if (entryMatch) {
      const outcome = entryMatch[1]!;
      const gateRaw = entryMatch[2]!.trim();

      // Parse subsequent lines for this entry
      let timeET = '', timeUTC = '', direction = '', alignment = '', confidence = 0, price = 0;
      let maxFavorable = 0, maxAdverse = 0, stage1Conf: number | undefined;
      let signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' = gateRaw.includes('[RANGE]') ? 'range' : gateRaw.includes('[BREAKOUT]') ? 'breakout' : 'trend';

      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        const l = lines[j]!;

        const timeMatch = l.match(/Time:\s+(\d{2}:\d{2})\s+ET\s+\((\S+)\s+UTC\)/);
        if (timeMatch) { timeET = timeMatch[1]!; timeUTC = timeMatch[2]!; }

        const dirMatch = l.match(/Direction:\s+(\w+)\s+\|\s+Alignment:\s+(\w+)/);
        if (dirMatch) { direction = dirMatch[1]!.toLowerCase(); alignment = dirMatch[2]!; }
        if (l.includes('Mode: RANGE')) signalMode = 'range';
        if (l.includes('Mode: BREAKOUT')) signalMode = 'breakout';

        const priceMatch = l.match(/Price:\s+\$([0-9.]+)\s+\|\s+Confidence:\s+([0-9.]+)%/);
        if (priceMatch) { price = parseFloat(priceMatch[1]!); confidence = parseFloat(priceMatch[2]!) / 100; }

        const stage1Match = l.match(/Stage-1 was ([0-9.]+)%/);
        if (stage1Match) stage1Conf = parseFloat(stage1Match[1]!) / 100;

        const fwdMatch = l.match(/max favorable=\$([0-9.]+),\s*max adverse=\$([0-9.]+)/);
        if (fwdMatch) { maxFavorable = parseFloat(fwdMatch[1]!); maxAdverse = parseFloat(fwdMatch[2]!); }

        // Stop at next entry or section
        if (l.match(/Entry #\d+:/) || l.match(/^──/) || l.match(/SUMMARY/)) break;
      }

      let gateResult = 'UNKNOWN';
      if (gateRaw.includes('CONFIRMED')) gateResult = 'PASSED';
      else if (gateRaw.includes('STAGE-1')) gateResult = 'STAGE1_OBSERVE';
      else if (gateRaw.includes('WEAKENING')) gateResult = 'WEAKENING_BLOCK';
      else if (gateRaw.includes('STALE')) gateResult = 'STALE_BLOCK';
      else if (gateRaw.includes('HIGH-CONV')) gateResult = 'HIGH_CONV_OVERRIDE';
      else if (gateRaw.includes('PHASE-CHANGE')) gateResult = 'PHASE_CHANGE_OVERRIDE';

      entries.push({ timeET, timeUTC, direction, alignment, confidence, price, maxFavorable, maxAdverse, outcome, gateResult, stage1Conf, signalMode });
    }
    i++;
  }

  return entries;
}

// ── Fetch live decisions from DB ──────────────────────────────────────────────

async function fetchLiveDecisions(): Promise<LiveDecision[]> {
  const pool = getPool();
  const { rows } = await pool.query<LiveDecision>(
    `SELECT
       d.id, d.decision_type, d.direction, d.confirmation_count,
       d.orchestration_confidence, d.reasoning, d.should_execute,
       d.entry_strategy, d.created_at,
       pj.id as position_id, pj.entry_price, pj.exit_price,
       pj.close_reason, pj.realized_pnl
     FROM trading.trading_decisions d
     LEFT JOIN trading.position_journal pj ON d.id = pj.decision_id
     WHERE d.trade_date = $1::date AND d.ticker = $2
     ORDER BY d.created_at ASC`,
    [TARGET_DATE, TICKER]
  );
  return rows;
}

function classifyLiveGate(d: LiveDecision): string {
  if (d.reasoning?.includes('[STAGE-1 OBSERVE]')) return 'STAGE1_OBSERVE';
  if (d.reasoning?.includes('[WEAKENING-SIGNAL BLOCK]')) return 'WEAKENING_BLOCK';
  if (d.reasoning?.includes('[STALE-SIGNAL BLOCK]')) return 'STALE_BLOCK';
  if (d.reasoning?.includes('[PHASE-CHANGE OVERRIDE]')) return 'PHASE_CHANGE_OVERRIDE';
  if (d.reasoning?.includes('[RANGE BYPASS]')) return 'RANGE_BYPASS';
  if (d.decision_type === 'NEW_ENTRY' && d.should_execute) return 'PASSED';
  return 'AI_WAIT';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  LIVE vs BACKTEST COMPARISON: ${TICKER} on ${TARGET_DATE}`);
  console.log(`${'='.repeat(90)}\n`);

  // ── 1. Fetch live decisions ─────────────────────────────────────────────────
  console.log(`  Fetching live decisions from DB...`);
  const liveDecisions = await fetchLiveDecisions();
  await closePool();

  // ── 2. Run backtest ─────────────────────────────────────────────────────────
  console.log(`  Running backtest for ${TARGET_DATE} ${TICKER}...`);
  let backtestOutput = '';
  try {
    backtestOutput = execSync(
      `npx tsx src/scripts/backtest-day.ts ${TARGET_DATE} ${TICKER}`,
      { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (err) {
    console.error(`  Backtest failed: ${(err as Error).message}`);
    return;
  }

  const backtestEntries = parseBacktestOutput(backtestOutput);
  console.log(`  Found ${liveDecisions.length} live decisions, ${backtestEntries.length} backtest entries\n`);

  // ── 3. Categorize live decisions ────────────────────────────────────────────
  const liveEntries = liveDecisions.filter(d => d.decision_type === 'NEW_ENTRY' && d.should_execute);
  const liveStage1s = liveDecisions.filter(d =>
    d.reasoning?.includes('[STAGE-1 OBSERVE]') ||
    (d.entry_strategy?.stage === 'OBSERVE' && d.confirmation_count === 1)
  );

  // ── 4. Side-by-side: backtest entries matched to live ───────────────────────
  console.log(`  ── BACKTEST ENTRIES vs LIVE DECISIONS ──\n`);

  const btConfirmed = backtestEntries.filter(b => b.gateResult === 'PASSED' || b.gateResult === 'HIGH_CONV_OVERRIDE' || b.gateResult === 'PHASE_CHANGE_OVERRIDE');
  const btBlocked = backtestEntries.filter(b => b.gateResult === 'STAGE1_OBSERVE' || b.gateResult === 'WEAKENING_BLOCK' || b.gateResult === 'STALE_BLOCK');

  for (let i = 0; i < backtestEntries.length; i++) {
    const bt = backtestEntries[i]!;
    const btMinutes = etToMinutes(bt.timeET);
    const btIsConfirmed = bt.gateResult === 'PASSED' || bt.gateResult === 'HIGH_CONV_OVERRIDE' || bt.gateResult === 'PHASE_CHANGE_OVERRIDE';

    // Find closest live decision within ±3 min window
    let closestLive: LiveDecision | null = null;
    let closestDiff = Infinity;
    for (const ld of liveDecisions) {
      if (!ld.direction) continue;
      const liveET = utcToET(ld.created_at);
      const liveMin = etToMinutes(liveET);
      const diff = Math.abs(liveMin - btMinutes);
      if (diff <= 3 && ld.direction === bt.direction && diff < closestDiff) {
        closestDiff = diff;
        closestLive = ld;
      }
    }

    // Find best matching live entry/stage-1 within ±3 min
    let matchedLiveEntry: LiveDecision | null = null;
    for (const le of liveEntries) {
      if (!le.direction) continue;
      const leET = utcToET(le.created_at);
      const leMin = etToMinutes(leET);
      if (Math.abs(leMin - btMinutes) <= 3 && le.direction === bt.direction) {
        matchedLiveEntry = le;
        break;
      }
    }

    let matchedLiveStage1: LiveDecision | null = null;
    for (const ls of liveStage1s) {
      if (!ls.direction) continue;
      const lsET = utcToET(ls.created_at);
      const lsMin = etToMinutes(lsET);
      if (Math.abs(lsMin - btMinutes) <= 3 && ls.direction === bt.direction) {
        matchedLiveStage1 = ls;
        break;
      }
    }

    const outcomeIcon = bt.outcome === 'GOOD' ? '✅' : bt.outcome === 'BAD' ? '❌' : '⚠️';
    const gateIcon = btIsConfirmed ? '🟢' : bt.gateResult === 'STAGE1_OBSERVE' ? '🔵' : bt.gateResult === 'WEAKENING_BLOCK' ? '🔴' : '🟡';

    const modeTag = bt.signalMode === 'range' ? ' [RANGE]' : '';
    console.log(`  Backtest #${i + 1}: ${bt.timeET} ET | ${bt.direction.toUpperCase()} | $${bt.price.toFixed(2)} | ${(bt.confidence * 100).toFixed(1)}% | ${outcomeIcon} ${bt.outcome} | ${gateIcon} ${bt.gateResult}${modeTag}`);

    // Live match
    if (matchedLiveEntry) {
      const leTime = utcToET(matchedLiveEntry.created_at);
      const leConf = (matchedLiveEntry.orchestration_confidence * 100).toFixed(1);
      const confGap = ((bt.confidence - matchedLiveEntry.orchestration_confidence) * 100).toFixed(1);
      const pnl = matchedLiveEntry.realized_pnl !== null ? `P&L: $${Number(matchedLiveEntry.realized_pnl).toFixed(2)}` : 'OPEN';
      console.log(`    🟢 LIVE MATCH: Entry at ${leTime} ET, conf=${leConf}% (gap: ${confGap}%) | ${pnl}`);
    } else if (matchedLiveStage1) {
      const lsTime = utcToET(matchedLiveStage1.created_at);
      const lsConf = (matchedLiveStage1.orchestration_confidence * 100).toFixed(1);
      console.log(`    🔵 LIVE STAGE-1: at ${lsTime} ET, conf=${lsConf}% (no confirmation followed)`);
    } else if (closestLive) {
      const clTime = utcToET(closestLive.created_at);
      const clConf = (closestLive.orchestration_confidence * 100).toFixed(1);
      const liveGate = classifyLiveGate(closestLive);
      console.log(`    ⏸️  LIVE: ${closestLive.decision_type} at ${clTime} ET, conf=${clConf}%, gate=${liveGate}`);
    } else {
      console.log(`    ── NO LIVE MATCH within ±3 min`);
    }

    // Forward price info
    if (btIsConfirmed) {
      console.log(`    Forward: +$${bt.maxFavorable.toFixed(2)} favorable, -$${bt.maxAdverse.toFixed(2)} adverse`);
    }
    console.log('');
  }

  // ── 5. Live entries NOT in backtest ─────────────────────────────────────────
  const unmatchedLiveEntries = liveEntries.filter(le => {
    const leET = utcToET(le.created_at);
    const leMin = etToMinutes(leET);
    return !backtestEntries.some(bt => {
      const btMin = etToMinutes(bt.timeET);
      return Math.abs(btMin - leMin) <= 3 && bt.direction === le.direction;
    });
  });

  if (unmatchedLiveEntries.length > 0) {
    console.log(`  ── LIVE ENTRIES NOT IN BACKTEST ──\n`);
    for (const le of unmatchedLiveEntries) {
      const leTime = utcToET(le.created_at);
      const leConf = (le.orchestration_confidence * 100).toFixed(1);
      const pnl = le.realized_pnl !== null ? `P&L: $${Number(le.realized_pnl).toFixed(2)}` : 'OPEN';
      console.log(`  🟢 ${leTime} ET | ${le.direction?.toUpperCase()} | conf=${leConf}% | ${pnl}`);
      console.log(`    Likely cause: AI conviction + real option data pushed confidence above threshold`);
      console.log('');
    }
  }

  // ── 6. Summary ──────────────────────────────────────────────────────────────
  console.log(`  ${'─'.repeat(80)}`);
  console.log(`  SUMMARY\n`);

  const btRange = backtestEntries.filter(b => b.signalMode === 'range');
  const btTrend = backtestEntries.filter(b => b.signalMode === 'trend');
  const btBreakout = backtestEntries.filter(b => b.signalMode === 'breakout');
  const modeParts: string[] = [];
  if (btRange.length > 0) modeParts.push(`RANGE: ${btRange.length}`);
  if (btBreakout.length > 0) modeParts.push(`BREAKOUT: ${btBreakout.length}`);
  if (btTrend.length > 0) modeParts.push(`TREND: ${btTrend.length}`);
  console.log(`  Backtest:  ${backtestEntries.length} entries (${btConfirmed.length} confirmed, ${btBlocked.length} blocked)${modeParts.length > 0 ? ` | ${modeParts.join(', ')}` : ''}`);
  console.log(`  Live:      ${liveEntries.length} entries, ${liveStage1s.length} stage-1s\n`);

  // Alignment score
  let aligned = 0;
  let misaligned = 0;
  for (const bt of btConfirmed) {
    const btMin = etToMinutes(bt.timeET);
    const hasLiveMatch = liveEntries.some(le => {
      const leMin = etToMinutes(utcToET(le.created_at));
      return Math.abs(leMin - btMin) <= 3 && le.direction === bt.direction;
    });
    if (hasLiveMatch) aligned++;
    else misaligned++;
  }

  console.log(`  Alignment (backtest confirmed → live entry within ±3 min):`);
  console.log(`    Matched:   ${aligned}/${btConfirmed.length}`);
  console.log(`    Missed:    ${misaligned}/${btConfirmed.length}`);
  if (btConfirmed.length > 0) {
    console.log(`    Score:     ${(aligned / btConfirmed.length * 100).toFixed(0)}%`);
  }

  // Confidence gap
  const confGaps: number[] = [];
  for (const bt of backtestEntries) {
    const btMin = etToMinutes(bt.timeET);
    for (const ld of liveDecisions) {
      if (!ld.direction || ld.direction !== bt.direction) continue;
      const ldMin = etToMinutes(utcToET(ld.created_at));
      if (Math.abs(ldMin - btMin) <= 1) {
        confGaps.push(bt.confidence - ld.orchestration_confidence);
        break;
      }
    }
  }
  if (confGaps.length > 0) {
    const avgGap = confGaps.reduce((a, b) => a + b, 0) / confGaps.length;
    console.log(`\n  Confidence gap (backtest - live): avg ${avgGap >= 0 ? '+' : ''}${(avgGap * 100).toFixed(1)}%`);
    console.log(`    Positive = backtest more confident (mocked options, no AI caution)`);
    console.log(`    Negative = live more confident (AI sees something backtest doesn't)`);
  }

  // Missed opportunities
  const missedGood = btConfirmed.filter(bt => {
    const btMin = etToMinutes(bt.timeET);
    return bt.outcome === 'GOOD' && !liveEntries.some(le => {
      const leMin = etToMinutes(utcToET(le.created_at));
      return Math.abs(leMin - btMin) <= 3 && le.direction === bt.direction;
    });
  });
  const avoidedBad = btConfirmed.filter(bt => {
    const btMin = etToMinutes(bt.timeET);
    return bt.outcome === 'BAD' && !liveEntries.some(le => {
      const leMin = etToMinutes(utcToET(le.created_at));
      return Math.abs(leMin - btMin) <= 3 && le.direction === bt.direction;
    });
  });

  if (missedGood.length > 0 || avoidedBad.length > 0) {
    console.log(`\n  Divergence analysis:`);
    if (missedGood.length > 0) {
      console.log(`    ⚠️  ${missedGood.length} GOOD backtest-confirmed entries missed by live`);
      for (const mg of missedGood) {
        console.log(`       ${mg.timeET} ET ${mg.direction} conf=${(mg.confidence * 100).toFixed(1)}% → +$${mg.maxFavorable.toFixed(2)} favorable`);
      }
    }
    if (avoidedBad.length > 0) {
      console.log(`    ✅ ${avoidedBad.length} BAD backtest-confirmed entries avoided by live (AI was smarter)`);
      for (const ab of avoidedBad) {
        console.log(`       ${ab.timeET} ET ${ab.direction} conf=${(ab.confidence * 100).toFixed(1)}% → -$${ab.maxAdverse.toFixed(2)} adverse`);
      }
    }
  }

  console.log(`\n${'='.repeat(90)}\n`);
}

main().catch(err => {
  console.error('Compare failed:', err);
  process.exit(1);
});
