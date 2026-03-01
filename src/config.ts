import { z } from 'zod';
import 'dotenv/config';

const configSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),

  // Alpaca
  ALPACA_API_KEY: z.string().min(1),
  ALPACA_SECRET_KEY: z.string().min(1),
  ALPACA_BASE_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_URL: z.string().url().default('https://data.alpaca.markets'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),

  // App
  PORT: z.coerce.number().default(3001),
  DASHBOARD_PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Trading parameters (with sane defaults)
  MAX_RISK_PCT: z.coerce.number().default(0.005),       // 0.5% of equity per trade
  MAX_CONTRACTS: z.coerce.number().default(10),
  MIN_CONFIDENCE: z.coerce.number().default(0.65),
  MAX_SPREAD_PCT: z.coerce.number().default(0.02),      // 2%
  MIN_RR_RATIO: z.coerce.number().default(0.6),
  DAILY_LOSS_LIMIT_PCT: z.coerce.number().default(0.02), // halt new entries after -2% equity loss today
});

type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${missing}`);
  }
  return result.data;
}

export const config = loadConfig();
export type { Config };
