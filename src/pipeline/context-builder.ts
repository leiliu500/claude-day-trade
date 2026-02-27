import { getPool } from '../db/client.js';
import { config } from '../config.js';
import type { PositionContext } from '../types/decision.js';

interface AlpacaAccount {
  equity?: string;
  buying_power?: string;
}

async function fetchAlpacaAccount(): Promise<{ equity: number; buyingPower: number }> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  try {
    const res = await fetch(`${config.ALPACA_BASE_URL}/v2/account`, { headers });
    if (!res.ok) return { equity: 0, buyingPower: 0 };
    const data = (await res.json()) as AlpacaAccount;
    return {
      equity: parseFloat(data.equity ?? '0'),
      buyingPower: parseFloat(data.buying_power ?? '0'),
    };
  } catch {
    return { equity: 0, buyingPower: 0 };
  }
}

async function fetchAndSyncBrokerState(ticker: string): Promise<{ positions: unknown[]; orders: unknown[] }> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const pool = getPool();

  // Fetch positions
  let positions: unknown[] = [];
  try {
    const res = await fetch(`${config.ALPACA_BASE_URL}/v2/positions`, { headers });
    if (res.ok) positions = (await res.json()) as unknown[];
    // Persist to broker_positions
    for (const pos of positions) {
      const p = pos as Record<string, unknown>;
      await pool.query(
        `INSERT INTO trading.broker_positions (symbol, qty, avg_entry_price, market_value, unrealized_pl, unrealized_plpc, current_price, asset_class, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p['symbol'], p['qty'], p['avg_entry_price'], p['market_value'], p['unrealized_pl'], p['unrealized_plpc'], p['current_price'], p['asset_class'], JSON.stringify(p)]
      );
    }
  } catch { /* continue */ }

  // Fetch open orders
  let orders: unknown[] = [];
  try {
    const url = new URL(`${config.ALPACA_BASE_URL}/v2/orders`);
    url.searchParams.set('status', 'open');
    const res = await fetch(url.toString(), { headers });
    if (res.ok) orders = (await res.json()) as unknown[];
    for (const ord of orders) {
      const o = ord as Record<string, unknown>;
      await pool.query(
        `INSERT INTO trading.broker_open_orders (alpaca_order_id, symbol, order_type, side, qty, filled_qty, limit_price, status, created_at_broker, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [o['id'], o['symbol'], o['type'], o['side'], o['qty'], o['filled_qty'], o['limit_price'], o['status'], o['created_at'], JSON.stringify(o)]
      );
    }
  } catch { /* continue */ }

  return { positions, orders };
}

/**
 * Build the full PositionContext for the DecisionOrchestrator.
 * Runs 8 SQL queries + 2 Alpaca API calls.
 */
export async function buildContext(ticker: string): Promise<PositionContext> {
  const pool = getPool();

  const [account, brokerState] = await Promise.all([
    fetchAlpacaAccount(),
    fetchAndSyncBrokerState(ticker),
  ]);

  const [activePos, recentDecisions, streaks, recentEvals] = await Promise.all([
    pool.query(
      `SELECT id, option_symbol, option_right, qty, entry_price, current_stop, current_tp,
              opened_at, confirmation_count
       FROM trading.v_active_positions WHERE ticker = $1`,
      [ticker]
    ),
    pool.query(
      `SELECT decision_type, ticker, confirmation_count, orchestration_confidence,
              reasoning, created_at
       FROM trading.trading_decisions
       WHERE ticker = $1 AND trade_date = CURRENT_DATE
       ORDER BY created_at DESC LIMIT 10`,
      [ticker]
    ),
    pool.query(
      `SELECT decision_id, confirm_count, contradict_count, total_count
       FROM trading.v_confirmation_streaks
       WHERE ticker = $1 AND trade_date = CURRENT_DATE`,
      [ticker]
    ),
    pool.query(
      `SELECT ticker, option_right, outcome, evaluation_grade, evaluation_score,
              signal_quality, timing_quality, risk_management_quality,
              lessons_learned, pnl_total::text, hold_duration_min, evaluated_at
       FROM trading.v_evaluation_feedback WHERE ticker = $1 LIMIT 5`,
      [ticker]
    ),
  ]);

  return {
    openPositions: activePos.rows.map(r => ({
      id: r.id,
      optionSymbol: r.option_symbol,
      side: r.option_right,
      qty: r.qty,
      entryPrice: parseFloat(r.entry_price),
      currentStop: r.current_stop ? parseFloat(r.current_stop) : undefined,
      currentTp: r.current_tp ? parseFloat(r.current_tp) : undefined,
      openedAt: r.opened_at,
      confirmationCount: r.confirmation_count ?? 0,
    })),
    brokerPositions: brokerState.positions,
    brokerOpenOrders: brokerState.orders,
    recentDecisions: recentDecisions.rows.map(r => ({
      decisionType: r.decision_type,
      ticker: r.ticker,
      confirmationCount: r.confirmation_count,
      createdAt: r.created_at,
      reasoning: r.reasoning ?? '',
    })),
    confirmationStreaks: streaks.rows.map(r => ({
      decisionId: r.decision_id,
      confirmCount: r.confirm_count,
      contradictCount: r.contradict_count,
      totalCount: r.total_count,
    })),
    recentEvaluations: recentEvals.rows.map(r => ({
      ticker:                r.ticker,
      optionRight:           r.option_right ?? null,
      grade:                 r.evaluation_grade,
      score:                 r.evaluation_score,
      outcome:               r.outcome,
      pnlTotal:              r.pnl_total != null ? parseFloat(r.pnl_total) : null,
      holdDurationMin:       r.hold_duration_min ?? null,
      signalQuality:         r.signal_quality ?? null,
      timingQuality:         r.timing_quality ?? null,
      riskManagementQuality: r.risk_management_quality ?? null,
      lessonsLearned:        r.lessons_learned ?? '',
      evaluatedAt:           r.evaluated_at,
    })),
    accountBuyingPower: account.buyingPower,
    accountEquity: account.equity,
  };
}
