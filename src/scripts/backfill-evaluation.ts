/**
 * One-time backfill: evaluate closed positions that have no evaluation record.
 * Run with: npx tsx src/scripts/backfill-evaluation.ts
 */
import 'dotenv/config';
import { getPool, closePool } from '../db/client.js';
import { EvaluationAgent } from '../agents/evaluation-agent.js';
import { insertEvaluation } from '../db/repositories/evaluations.js';

const evaluationAgent = new EvaluationAgent();

async function backfill(): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query(`
    SELECT pj.id, pj.ticker, pj.option_symbol, pj.option_right, pj.strike,
           pj.expiration, pj.entry_price, pj.exit_price, pj.qty,
           pj.opened_at, pj.closed_at, pj.close_reason, pj.decision_id,
           td.direction, td.reasoning AS entry_reasoning,
           CASE WHEN td.direction = 'bullish' THEN 0.66 ELSE 0.60 END AS entry_confidence
    FROM trading.position_journal pj
    LEFT JOIN trading.trading_decisions td ON pj.decision_id = td.id
    WHERE pj.status = 'CLOSED'
      AND pj.exit_price IS NOT NULL
      AND pj.id NOT IN (SELECT position_id FROM trading.trade_evaluations WHERE position_id IS NOT NULL)
    ORDER BY pj.closed_at DESC
  `);

  if (rows.length === 0) {
    console.log('No positions missing evaluations.');
    return;
  }

  console.log(`Found ${rows.length} position(s) to evaluate...`);

  for (const pos of rows) {
    console.log(`Evaluating ${pos.option_symbol} (${pos.ticker}) — P&L: ${((pos.exit_price - pos.entry_price) * pos.qty * 100).toFixed(2)}`);
    try {
      const evaluation = await evaluationAgent.evaluate({
        ticker: pos.ticker,
        optionSymbol: pos.option_symbol,
        side: pos.option_right as 'call' | 'put',
        strike: parseFloat(pos.strike),
        expiration: pos.expiration ? new Date(pos.expiration).toISOString().slice(0, 10) : '',
        entryPrice: parseFloat(pos.entry_price),
        exitPrice: parseFloat(pos.exit_price),
        qty: pos.qty,
        openedAt: pos.opened_at,
        closedAt: pos.closed_at,
        closeReason: pos.close_reason ?? 'EXIT',
        entryConfidence: parseFloat(pos.entry_confidence),
        entryAlignment: 'all_aligned',
        entryDirection: pos.direction ?? 'bullish',
        entryReasoning: pos.entry_reasoning ?? '',
        positionId: pos.id,
        decisionId: pos.decision_id ?? undefined,
      });

      await insertEvaluation(evaluation);
      console.log(`  → Grade: ${evaluation.grade} (${evaluation.score}/100) | ${evaluation.outcome}`);
    } catch (err) {
      console.error(`  → Failed: ${(err as Error).message}`);
    }
  }

  await closePool();
}

backfill().catch(err => { console.error(err); process.exit(1); });
