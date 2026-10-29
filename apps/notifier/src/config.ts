import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8082),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://brake:brake@localhost:15432/brake'),
  VALKEY_URL: z.string().default('redis://localhost:16379'),
  /** Where this notifier is reachable from a browser: action links point here. */
  BRAKE_PUBLIC_URL: z.url().default('http://localhost:8082'),
  /** The admin API, which executes confirmed actions. */
  BRAKE_API_URL: z.url().default('http://localhost:8081'),
  /** Optional: "View" links point into the dashboard. */
  BRAKE_DASHBOARD_URL: z.url().optional(),
  /** Signs action links; must match the API's. */
  BRAKE_ACTION_SECRET: z.string().min(32),
  BRAKE_ACTION_TTL_SEC: z.coerce.number().int().positive().default(900),
  /** Largest custom raise a link may ask for. */
  BRAKE_MAX_CUSTOM_RAISE_USD: z.coerce.number().positive().default(500),
  /** smtp://user:pass@host:port — email fallback when an org has no webhook. */
  SMTP_URL: z.string().optional(),
  BRAKE_EMAIL_FROM: z.string().default('Spend Brake <alerts@localhost>'),
  /** Receives operator alerts (catalog drift). */
  OPERATOR_EMAIL: z.string().optional(),
  /** Self-hosted setups posting to internal hosts (n8n on the LAN) set this. */
  ALLOW_PRIVATE_WEBHOOKS: z.stringbool().default(false),
});

export type NotifierEnv = z.output<typeof envSchema>;
export const loadEnv = (env: NodeJS.ProcessEnv = process.env): NotifierEnv => envSchema.parse(env);
