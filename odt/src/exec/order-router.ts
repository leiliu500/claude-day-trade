import type { Fill, OptionOrder } from "../types.js";
import { config } from "../config.js";
import { submitMlegOrder, cancelOrder, getOrder, type MlegLeg } from "../data/alpaca-rest.js";
import { logger } from "../util/logger.js";

const log = logger("router");

export interface OrderRouter {
  submit(order: OptionOrder, now: number): Promise<Fill | null>;
  cancelAll(): Promise<void>;
}

export class LiveRouter implements OrderRouter {
  private activeOrderIds = new Set<string>();
  private dryRun: boolean;

  constructor(opts: { dryRun?: boolean } = {}) {
    this.dryRun = opts.dryRun ?? false;
  }

  async submit(order: OptionOrder, now: number): Promise<Fill | null> {
    const legs: MlegLeg[] =
      order.kind === "debit_vertical"
        ? [
            { symbol: order.long.symbol, side: "buy", ratio_qty: "1", position_intent: "buy_to_open" },
            { symbol: order.short.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
          ]
        : [
            { symbol: order.leg.symbol, side: "buy", ratio_qty: "1", position_intent: "buy_to_open" },
          ];
    const legCount = legs.length;

    if (this.dryRun) {
      log.info("dry-run: would submit", {
        kind: order.kind,
        symbols: legs.map((l) => l.symbol),
        qty: order.qty,
        limitDebit: order.limitDebit,
      });
      return null;
    }
    const submit = await submitMlegOrder({ qty: order.qty, limitDebit: order.limitDebit, legs });
    this.activeOrderIds.add(submit.id);
    const startTs = Date.now();
    const timeoutMs = 10_000;
    while (Date.now() - startTs < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1500));
      const info = await getOrder(submit.id).catch(() => null);
      if (!info) continue;
      if (info.status === "filled") {
        this.activeOrderIds.delete(submit.id);
        const filledDebit = Number(info.filled_avg_price ?? order.limitDebit);
        return {
          order,
          filledDebit,
          fees: config.execution.feePerContract * legCount * order.qty,
          ts: now,
        };
      }
      if (info.status === "canceled" || info.status === "rejected" || info.status === "expired") {
        this.activeOrderIds.delete(submit.id);
        return null;
      }
    }
    await cancelOrder(submit.id).catch(() => {});
    this.activeOrderIds.delete(submit.id);
    return null;
  }

  async cancelAll(): Promise<void> {
    for (const id of this.activeOrderIds) {
      await cancelOrder(id).catch(() => {});
    }
    this.activeOrderIds.clear();
  }
}
