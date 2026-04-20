import type { Fill, OptionOrder } from "../types.js";
import { config } from "../config.js";
import { submitMlegOrder, cancelOrder, getOrder, type MlegLeg } from "../data/alpaca-rest.js";
import { logger } from "../util/logger.js";

const log = logger("router");

export interface OrderRouter {
  submit(order: OptionOrder, now: number): Promise<Fill | null>;
  submitClose(
    order: OptionOrder,
    markDebit: number,
    now: number,
    opts?: { useMarket?: boolean },
  ): Promise<Fill | null>;
  cancelAll(): Promise<void>;
}

function openLegs(order: OptionOrder): MlegLeg[] {
  if (order.kind === "debit_vertical") {
    return [
      { symbol: order.long.symbol, side: "buy", ratio_qty: "1", position_intent: "buy_to_open" },
      { symbol: order.short.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
    ];
  }
  return [
    { symbol: order.leg.symbol, side: "buy", ratio_qty: "1", position_intent: "buy_to_open" },
  ];
}

function closeLegs(order: OptionOrder): MlegLeg[] {
  if (order.kind === "debit_vertical") {
    return [
      { symbol: order.long.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_close" },
      { symbol: order.short.symbol, side: "buy", ratio_qty: "1", position_intent: "buy_to_close" },
    ];
  }
  return [
    { symbol: order.leg.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_close" },
  ];
}

async function pollForFill(
  orderId: string,
  fallbackPrice: number,
  timeoutMs: number,
): Promise<{ filledPrice: number } | null> {
  const startTs = Date.now();
  while (Date.now() - startTs < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const info = await getOrder(orderId).catch(() => null);
    if (!info) continue;
    if (info.status === "filled") {
      return { filledPrice: Number(info.filled_avg_price ?? fallbackPrice) };
    }
    if (["canceled", "rejected", "expired"].includes(info.status)) return null;
  }
  return null;
}

export class LiveRouter implements OrderRouter {
  private activeOrderIds = new Set<string>();
  private dryRun: boolean;

  constructor(opts: { dryRun?: boolean } = {}) {
    this.dryRun = opts.dryRun ?? false;
  }

  async submit(order: OptionOrder, now: number): Promise<Fill | null> {
    const legs = openLegs(order);
    if (this.dryRun) {
      log.info("dry-run: would open", {
        kind: order.kind,
        symbols: legs.map((l) => l.symbol),
        qty: order.qty,
        limitDebit: order.limitDebit,
      });
      return null;
    }
    const submit = await submitMlegOrder({
      qty: order.qty,
      limitDebit: order.limitDebit,
      legs,
    });
    this.activeOrderIds.add(submit.id);
    const res = await pollForFill(submit.id, order.limitDebit, 10_000);
    if (res) {
      this.activeOrderIds.delete(submit.id);
      return {
        order,
        filledDebit: res.filledPrice,
        fees: config.execution.feePerContract * legs.length * order.qty,
        ts: now,
      };
    }
    await cancelOrder(submit.id).catch(() => {});
    this.activeOrderIds.delete(submit.id);
    return null;
  }

  async submitClose(
    order: OptionOrder,
    markDebit: number,
    now: number,
    opts: { useMarket?: boolean } = {},
  ): Promise<Fill | null> {
    const legs = closeLegs(order);
    const fees = config.execution.feePerContract * legs.length * order.qty;

    if (this.dryRun) {
      log.info("dry-run: would close", {
        kind: order.kind,
        symbols: legs.map((l) => l.symbol),
        qty: order.qty,
        markDebit,
        type: opts.useMarket ? "market" : "limit",
      });
      return { order, filledDebit: markDebit, fees, ts: now };
    }

    if (opts.useMarket) {
      const submit = await submitMlegOrder({
        qty: order.qty,
        legs,
        orderType: "market",
        clientOrderId: `odt-close-mkt-${now}`,
      });
      this.activeOrderIds.add(submit.id);
      const res = await pollForFill(submit.id, markDebit, 10_000);
      this.activeOrderIds.delete(submit.id);
      if (res) return { order, filledDebit: res.filledPrice, fees, ts: now };
      log.error(`market close did not fill within 10s: ${submit.id}`);
      return null;
    }

    const limitCredit = Math.max(0.05, markDebit * 0.92);
    const submit = await submitMlegOrder({
      qty: order.qty,
      limitDebit: limitCredit,
      legs,
      clientOrderId: `odt-close-lim-${now}`,
    });
    this.activeOrderIds.add(submit.id);
    const res = await pollForFill(submit.id, limitCredit, 15_000);
    this.activeOrderIds.delete(submit.id);
    if (res) return { order, filledDebit: res.filledPrice, fees, ts: now };
    await cancelOrder(submit.id).catch(() => {});
    log.warn(`limit close did not fill, canceled: ${submit.id}`);
    return null;
  }

  async cancelAll(): Promise<void> {
    for (const id of this.activeOrderIds) {
      await cancelOrder(id).catch(() => {});
    }
    this.activeOrderIds.clear();
  }
}
