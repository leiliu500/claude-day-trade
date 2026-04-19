export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = (process.env.ODT_LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(l: LogLevel): void {
  currentLevel = l;
}

function emit(level: LogLevel, scope: string, msg: string, meta?: unknown): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const extra = meta === undefined ? "" : " " + JSON.stringify(meta);
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(line + extra);
}

export function logger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => emit("debug", scope, m, x),
    info: (m: string, x?: unknown) => emit("info", scope, m, x),
    warn: (m: string, x?: unknown) => emit("warn", scope, m, x),
    error: (m: string, x?: unknown) => emit("error", scope, m, x),
  };
}
