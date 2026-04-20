import { loadEnv } from "../util/env.js";
loadEnv();
import { startDashboard } from "../dashboard/server.js";

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main(): Promise<void> {
  const port = Number(arg("port", process.env.ODT_DASHBOARD_PORT ?? "3001"));
  await startDashboard({ port });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
