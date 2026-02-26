import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { checkSafetyGates } from '../pipeline/safety-gates.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { OptionCandidate, OptionEvaluation } from '../types/options.js';
import type { DecisionResult } from '../types/decision.js';
import type { OrderRecord, SizeResult, ConvictionTier } from '../types/trade.js';
import type { SignalPayload } from '../types/signal.js';

interface AlpacaOrderResponse {
  id?: string;
  status?: string;
  filled_avg_price?: string;
  filled_qty?: string;
  [key: string]: unknown;
}

function computeConvictionScore(signal: SignalPayload, analysis: AnalysisResult, option: OptionEvaluation): number {
  let score = 0;

  // Alignment bonuses
  if (signal.alignment === 'all_aligned') score += 2;
  else if (signal.alignment === 'htf_mtf_aligned') score += 1;

  // Confidence bonuses
  if (analysis.confidence >= 0.80) score += 2;
  else if (analysis.confidence >= 0.70) score += 1;

  // ADX confirmation (HTF)
  const htf = signal.timeframes[signal.timeframes.length - 1];
  if (htf && htf.dmi.adx > 25) score += 1;

  // Trend strength
  if (htf && htf.dmi.adxStrength === 'strong') score += 1;

  // R:R bonus
  const rr = option.winnerCandidate?.rrRatio ?? 0;
  if (rr >= 2.0) score += 1;

  // Spread quality
  const sp = option.winnerCandidate?.contract.spreadPct ?? 999;
  if (sp < 0.5) score += 1;

  return Math.min(score, 10);
}

function computeSizing(
  convictionScore: number,
  entryPremium: number,
  stopPremium: number,
  accountEquity: number,
  accountBuyingPower: number
): SizeResult {
  const tier: ConvictionTier =
    convictionScore >= 7 ? 'MAX_CONVICTION' :
    convictionScore >= 4 ? 'SIZABLE' :
    'REGULAR';

  const multiplier = tier === 'MAX_CONVICTION' ? 3 : tier === 'SIZABLE' ? 2 : 1;
  const baseRisk = accountEquity * config.MAX_RISK_PCT;
  const effectiveRisk = baseRisk * multiplier;
  const riskPerContract = (entryPremium - stopPremium) * 100;

  let qty = riskPerContract > 0 ? Math.floor(effectiveRisk / riskPerContract) : 1;
  qty = Math.max(1, Math.min(qty, config.MAX_CONTRACTS));

  // Buying power cap
  const totalCost = qty * entryPremium * 100;
  if (totalCost > accountBuyingPower) {
    qty = Math.max(1, Math.floor(accountBuyingPower / (entryPremium * 100)));
  }

  return {
    qty,
    convictionScore,
    convictionTier: tier,
    baseRiskUsd: baseRisk,
    effectiveRiskUsd: effectiveRisk,
    riskPerContract,
    limitPrice: Math.round(entryPremium * 100) / 100, // round to cent
  };
}

async function submitToAlpaca(params: {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  limitPrice: number;
  positionIntent: string;
}): Promise<AlpacaOrderResponse> {
  const body = {
    symbol: params.symbol,
    qty: String(params.qty),
    side: params.side,
    type: 'limit',
    time_in_force: 'day',
    order_class: 'simple',
    position_intent: params.positionIntent,
    limit_price: params.limitPrice.toFixed(2),
  };

  const res = await fetch(`${config.ALPACA_BASE_URL}/v2/orders`, {
    method: 'POST',
    headers: {
      'APCA-API-KEY-ID': config.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca order error ${res.status}: ${text}`);
  }

  return res.json() as Promise<AlpacaOrderResponse>;
}

async function cancelOpenOrdersForSymbol(symbol: string): Promise<void> {
  const res = await fetch(
    `${config.ALPACA_BASE_URL}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`,
    {
      headers: {
        'APCA-API-KEY-ID': config.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
      },
    }
  );
  if (!res.ok) return;
  const orders = (await res.json()) as Array<{ id: string }>;
  for (const order of orders) {
    await fetch(`${config.ALPACA_BASE_URL}/v2/orders/${order.id}`, {
      method: 'DELETE',
      headers: {
        'APCA-API-KEY-ID': config.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
      },
    }).catch(() => {}); // ignore if already filled/cancelled
  }
}

async function closeAlpacaPosition(symbol: string): Promise<AlpacaOrderResponse> {
  // Cancel any unfilled open orders first so they don't become positions
  await cancelOpenOrdersForSymbol(symbol);

  const res = await fetch(`${config.ALPACA_BASE_URL}/v2/positions/${encodeURIComponent(symbol)}`, {
    method: 'DELETE',
    headers: {
      'APCA-API-KEY-ID': config.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
    },
  });

  // 404 = order was never filled, no position to close — treat as success
  if (res.status === 404) return {};

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca close error ${res.status}: ${text}`);
  }

  return res.json() as Promise<AlpacaOrderResponse>;
}

export class ExecutionAgent {
  /**
   * Execute a NEW_ENTRY or ADD_POSITION decision.
   * Returns the order record (or null if gates fail).
   */
  async executeEntry(params: {
    decision: DecisionResult;
    signal: SignalPayload;
    option: OptionEvaluation;
    analysis: AnalysisResult;
    accountEquity: number;
    accountBuyingPower: number;
    timeGateOk: boolean;
  }): Promise<{ order: OrderRecord | null; sizing: SizeResult | null; failedGates: string[] }> {
    const { decision, signal, option, analysis, accountEquity, accountBuyingPower, timeGateOk } = params;
    const candidate = option.winnerCandidate;

    if (!candidate) {
      return { order: null, sizing: null, failedGates: ['NO_CANDIDATE'] };
    }

    const convictionScore = computeConvictionScore(signal, analysis, option);
    const sizing = computeSizing(
      convictionScore,
      candidate.entryPremium,
      candidate.stopPremium,
      accountEquity,
      accountBuyingPower
    );

    // Run safety gates
    const gates = checkSafetyGates({
      timeGateOk,
      analysis,
      option,
      decision,
      accountBuyingPower,
      proposedQty: sizing.qty,
      proposedCost: sizing.qty * candidate.entryPremium * 100,
    });

    if (!gates.passed) {
      console.warn('[ExecutionAgent] Gates failed:', gates.failedGates);
      return { order: null, sizing, failedGates: gates.failedGates };
    }

    // Submit order
    let alpacaResponse: AlpacaOrderResponse = {};
    let errorMessage: string | undefined;

    try {
      alpacaResponse = await submitToAlpaca({
        symbol: candidate.contract.symbol,
        qty: sizing.qty,
        side: 'buy',
        limitPrice: sizing.limitPrice,
        positionIntent: 'buy_to_open',
      });
    } catch (err) {
      errorMessage = (err as Error).message;
      console.error('[ExecutionAgent] Order submission failed:', errorMessage);
    }

    const order: OrderRecord = {
      id: uuidv4(),
      decisionId: decision.id,
      ticker: decision.ticker,
      optionSymbol: candidate.contract.symbol,
      alpacaOrderId: alpacaResponse.id,
      alpacaStatus: alpacaResponse.status ?? (errorMessage ? 'error' : 'submitted'),
      orderSide: 'buy',
      orderType: 'limit',
      positionIntent: 'buy_to_open',
      submittedQty: sizing.qty,
      filledQty: alpacaResponse.filled_qty ? parseInt(alpacaResponse.filled_qty) : 0,
      submittedPrice: sizing.limitPrice,
      fillPrice: alpacaResponse.filled_avg_price ? parseFloat(alpacaResponse.filled_avg_price) : undefined,
      errorMessage,
      submittedAt: new Date().toISOString(),
    };

    return { order, sizing, failedGates: [] };
  }

  /**
   * Execute an EXIT decision — close position via Alpaca.
   */
  async executeExit(params: {
    decision: DecisionResult;
    optionSymbol: string;
  }): Promise<OrderRecord> {
    const { decision, optionSymbol } = params;
    let alpacaResponse: AlpacaOrderResponse = {};
    let errorMessage: string | undefined;

    try {
      alpacaResponse = await closeAlpacaPosition(optionSymbol);
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    return {
      id: uuidv4(),
      decisionId: decision.id,
      ticker: decision.ticker,
      optionSymbol,
      alpacaOrderId: alpacaResponse.id,
      alpacaStatus: alpacaResponse.status ?? (errorMessage ? 'error' : 'submitted'),
      orderSide: 'sell',
      orderType: 'market',
      positionIntent: 'sell_to_close',
      submittedQty: 0, // filled qty unknown at submission
      filledQty: 0,
      errorMessage,
      submittedAt: new Date().toISOString(),
    };
  }

  /**
   * Execute a REDUCE_EXPOSURE — partial close.
   */
  async executeReduce(params: {
    decision: DecisionResult;
    optionSymbol: string;
    qty: number;
  }): Promise<OrderRecord> {
    const { decision, optionSymbol, qty } = params;
    let alpacaResponse: AlpacaOrderResponse = {};
    let errorMessage: string | undefined;

    try {
      const res = await fetch(
        `${config.ALPACA_BASE_URL}/v2/positions/${encodeURIComponent(optionSymbol)}?qty=${qty}`,
        {
          method: 'DELETE',
          headers: {
            'APCA-API-KEY-ID': config.ALPACA_API_KEY,
            'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
          },
        }
      );
      if (!res.ok) {
        errorMessage = await res.text();
      } else {
        alpacaResponse = (await res.json()) as AlpacaOrderResponse;
      }
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    return {
      id: uuidv4(),
      decisionId: decision.id,
      ticker: decision.ticker,
      optionSymbol,
      alpacaOrderId: alpacaResponse.id,
      alpacaStatus: alpacaResponse.status ?? (errorMessage ? 'error' : 'submitted'),
      orderSide: 'sell',
      orderType: 'market',
      positionIntent: 'sell_to_close',
      submittedQty: qty,
      filledQty: 0,
      errorMessage,
      submittedAt: new Date().toISOString(),
    };
  }
}
