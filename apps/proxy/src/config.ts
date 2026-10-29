import { z } from 'zod';

const json = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  VALKEY_URL: z.string().default('redis://localhost:16379'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TRUST_PROXY: z.stringbool().default(false),
  /** Dev only: provider credentials as {"<credentialId>": "<secret>"}. Phase 4 replaces this. */
  BRAKE_DEV_SECRETS: json(z.record(z.string(), z.string())).optional(),
  /** Test/dev only: send an upstream origin somewhere else, e.g. a mock server. */
  BRAKE_UPSTREAM_OVERRIDES: json(z.record(z.string(), z.url())).optional(),
  /** Generic adapter configs (see @spend-brake/catalog GenericConfig). */
  BRAKE_GENERIC_PROVIDERS: json(z.array(z.unknown())).optional(),
});

export type ProxyEnv = z.output<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnv {
  return envSchema.parse(env);
}
