import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8081),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://brake:brake@localhost:15432/brake'),
  VALKEY_URL: z.string().default('redis://localhost:16379'),
  /** Requests per minute per token (or IP when unauthenticated). */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  TRUST_PROXY: z.stringbool().default(false),
});

export type ApiEnv = z.output<typeof envSchema>;

export const loadEnv = (env: NodeJS.ProcessEnv = process.env): ApiEnv => envSchema.parse(env);
