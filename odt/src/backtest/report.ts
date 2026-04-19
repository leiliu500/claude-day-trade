import type { Position } from "../types.js";
import type { BacktestResult } from "./engine.js";

export interface Metrics {
  entries: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnL: number;
  netPnL: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  maxDrawdown: number;
  exitBreakdown: Record<string, number>;
  blockedBreakdown: Record<string, number>;
  signalsTotal: number;
}

export function computeMetrics(r: BacktestResult): Metrics {
  const wins = r.closedPositions.filter((p) => (p.pnlDollars ?? 0) > 0);
  const losses = r.closedPositions.filter((p) => (p.pnlDollars ?? 0) <= 0);
  const grossPnL = r.closedPositions.reduce((a, p) => a + (p.pnlDollars ?? 0) + (p.fill.fees ?? 0), 0);
  const netPnL = r.closedPositions.reduce((a, p) => a + (p.pnlDollars ?? 0), 0);
  const avgWin = wins.length ? wins.reduce((a, p) => a + (p.pnlDollars ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, p) => a + (p.pnlDollars ?? 0), 0) / losses.length : 0;
  const expectancy = r.closedPositions.length ? netPnL / r.closedPositions.length : 0;

  let peak = 0;
  let running = 0;
  let maxDD = 0;
  for (const p of r.closedPositions) {
    running += p.pnlDollars ?? 0;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }

  const exitBreakdown: Record<string, number> = {};
  for (const p of r.closedPositions) {
    const k = p.exitRule ?? "unknown";
    exitBreakdown[k] = (exitBreakdown[k] ?? 0) + 1;
  }
  const blockedBreakdown: Record<string, number> = {};
  for (const b of r.signalsBlocked) {
    blockedBreakdown[b.reason] = (blockedBreakdown[b.reason] ?? 0) + 1;
  }

  return {
    entries: r.closedPositions.length,
    wins: wins.length,
    losses: losses.length,
    winRate: r.closedPositions.length ? wins.length / r.closedPositions.length : 0,
    grossPnL,
    netPnL,
    avgWin,
    avgLoss,
    expectancy,
    maxDrawdown: maxDD,
    exitBreakdown,
    blockedBreakdown,
    signalsTotal: r.signalsEmitted.length,
  };
}

export function formatReport(r: BacktestResult, m: Metrics): string {
  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  const $ = (x: number) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toFixed(2);
  const lines: string[] = [];
  lines.push(`=== Backtest ${r.symbol} ${r.startISO} → ${r.endISO} ===`);
  lines.push(`Final equity: $${r.finalEquity.toFixed(2)}`);
  lines.push(`Signals: ${m.signalsTotal}, Entries: ${m.entries} (${m.signalsTotal - m.entries} blocked)`);
  lines.push(`Wins: ${m.wins}  Losses: ${m.losses}  Win rate: ${pct(m.winRate)}`);
  lines.push(`Avg win: ${$(m.avgWin)}  Avg loss: ${$(m.avgLoss)}  Expectancy/trade: ${$(m.expectancy)}`);
  lines.push(`Net P&L: ${$(m.netPnL)}  Max DD: $${m.maxDrawdown.toFixed(2)}`);
  lines.push(`Exits: ${JSON.stringify(m.exitBreakdown)}`);
  lines.push(`Blocked: ${JSON.stringify(m.blockedBreakdown)}`);
  return lines.join("\n");
}

export function toCSV(positions: Position[]): string {
  const header = "id,opened,closed,kind,side,long,short,qty,entry_debit,exit_debit,exit_rule,pnl_dollars";
  const rows = positions.map((p) => {
    const opened = new Date(p.opened).toISOString();
    const closed = p.closedTs ? new Date(p.closedTs).toISOString() : "";
    const order = p.fill.order;
    const longSym = order.kind === "debit_vertical" ? order.long.symbol : order.leg.symbol;
    const shortSym = order.kind === "debit_vertical" ? order.short.symbol : "";
    return [
      p.id,
      opened,
      closed,
      order.kind,
      order.side,
      longSym,
      shortSym,
      order.qty,
      p.fill.filledDebit.toFixed(2),
      (p.exitDebit ?? 0).toFixed(2),
      p.exitRule ?? "",
      (p.pnlDollars ?? 0).toFixed(2),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}
