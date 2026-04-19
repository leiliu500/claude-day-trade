const ET_TZ = "America/New_York";

const etParts = (ts: number) => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ts));
  const out: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour === "24" ? "0" : out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
};

export function etDateKey(ts: number): string {
  const p = etParts(ts);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function etMinutesSinceMidnight(ts: number): number {
  const p = etParts(ts);
  return p.hour * 60 + p.minute;
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export function isRTH(ts: number): boolean {
  const m = etMinutesSinceMidnight(ts);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

export function isBeforeCloseCutoff(ts: number, cutoffHHMM: string): boolean {
  return etMinutesSinceMidnight(ts) < parseHHMM(cutoffHHMM);
}

export function isRegularTradingDay(ts: number): boolean {
  const d = new Date(ts);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, weekday: "short" });
  const wk = fmt.format(d);
  return wk !== "Sat" && wk !== "Sun";
}

export function dateRange(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const s = new Date(startISO + "T00:00:00Z");
  const e = new Date(endISO + "T00:00:00Z");
  for (let t = s.getTime(); t <= e.getTime(); t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function addBusinessDays(dateISO: string, n: number): string {
  let remaining = n;
  const d = new Date(dateISO + "T12:00:00Z");
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return d.toISOString().slice(0, 10);
}

export function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(aISO + "T00:00:00Z").getTime();
  const b = new Date(bISO + "T00:00:00Z").getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

const ET_TZ_FOR_OFFSET = "America/New_York";

function etUtcOffsetHoursAtDate(dateISO: string): number {
  const noonLocal = new Date(dateISO + "T12:00:00Z");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ_FOR_OFFSET,
    hour: "2-digit",
    hour12: false,
  });
  const etHour = Number(fmt.format(noonLocal));
  return 12 - etHour;
}

export function sessionCloseUTCms(expiryISO: string): number {
  const offset = etUtcOffsetHoursAtDate(expiryISO);
  const closeUtcHour = 16 + offset;
  return new Date(expiryISO + "T00:00:00Z").getTime() + closeUtcHour * 3600 * 1000;
}
