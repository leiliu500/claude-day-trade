export function buildOccSymbol(params: {
  underlying: string;
  expiryISO: string;
  type: "C" | "P";
  strike: number;
}): string {
  const d = new Date(params.expiryISO + "T00:00:00Z");
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const strikeInt = Math.round(params.strike * 1000);
  const strikeStr = String(strikeInt).padStart(8, "0");
  return `${params.underlying}${yy}${mm}${dd}${params.type}${strikeStr}`;
}

export function parseOccSymbol(symbol: string): {
  underlying: string;
  expiryISO: string;
  type: "C" | "P";
  strike: number;
} | null {
  const m = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, underlying, date, type, strike] = m;
  const yy = 2000 + Number(date.slice(0, 2));
  const mm = date.slice(2, 4);
  const dd = date.slice(4, 6);
  return {
    underlying,
    expiryISO: `${yy}-${mm}-${dd}`,
    type: type as "C" | "P",
    strike: Number(strike) / 1000,
  };
}
