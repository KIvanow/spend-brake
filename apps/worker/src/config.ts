import { z } from 'zod';

const envSchema = z.object({
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://brake:brake@localhost:15432/brake'),
  VALKEY_URL: z.string().default('redis://localhost:16379'),
  METRICS_PORT: z.coerce.number().int().default(9464),
  /** Unique per worker process; consumers in one group share the ledger work. */
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  LEDGER_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  DRIFT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 3600_000),
  /** Optional: open a GitHub issue when a catalog source page changes. */
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(),
});

export type WorkerEnv = z.output<typeof envSchema>;
export const loadEnv = (env: NodeJS.ProcessEnv = process.env): WorkerEnv => envSchema.parse(env);
