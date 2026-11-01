import { SERPAPI_PLANS } from '@spend-brake/catalog';
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
  /** Prometheus metrics, on their own port so they are never exposed with the proxy. */
  METRICS_PORT: z.coerce.number().int().default(9465),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TRUST_PROXY: z.stringbool().default(false),
  /** Dev only: provider credentials as {"<credentialId>": "<secret>"}. Phase 4 replaces this. */
  BRAKE_DEV_SECRETS: json(z.record(z.string(), z.string())).optional(),
  /** Test/dev only: send an upstream origin somewhere else, e.g. a mock server. */
  BRAKE_UPSTREAM_OVERRIDES: json(z.record(z.string(), z.url())).optional(),
  /** SerpApi plan whose per-search price applies (see the serpapi catalog). */
  BRAKE_SERPAPI_PLAN: z.enum(SERPAPI_PLANS).default('starter'),
  /** SerpApi speed mode on the account: ludicrous bills 2x, ludicrous_max 4x. */
  BRAKE_SERPAPI_SPEED: z.enum(['normal', 'ludicrous', 'ludicrous_max']).default('normal'),
  /** Generic adapter configs (see @spend-brake/catalog GenericConfig). */
  BRAKE_GENERIC_PROVIDERS: json(z.array(z.unknown())).optional(),
  /**
   * Let orgs' custom APIs reach private addresses (an API on this machine or network). Set it on
   * the API too, which checks origins when they are saved. Leave off on a server other people use.
   */
  ALLOW_PRIVATE_CUSTOM_APIS: z.stringbool().default(false),
  /** Largest custom API response passed on; a longer one is cut and recorded as an error. */
  /**
   * Directory for fail-open spend that could not be recorded in Valkey by shutdown; replayed after
   * the next start. Put it on a volume. Unset, that spend is only logged.
   */
  BRAKE_FAIL_OPEN_DIR: z.string().min(1).optional(),
  BRAKE_CUSTOM_API_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
});

export type ProxyEnv = z.output<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnv {
  return envSchema.parse(env);
}
