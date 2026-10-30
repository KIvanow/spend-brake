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
  /** Signs alert action links; the notifier must use the same value. */
  BRAKE_ACTION_SECRET: z.string().min(32).optional(),
  /** First-run token for `brake init` (POST /v1/setup); remove it after setup. */
  BRAKE_SETUP_TOKEN: z.string().min(16).optional(),
  /** Check new Google keys' restrictions with a free call to Google. */
  GOOGLE_KEY_CHECK: z.stringbool().default(true),
  /** People sign in with emailed links (the notifier sends them; it needs SMTP_URL). */
  BRAKE_EMAIL_SIGN_IN: z.stringbool().default(false),
  /** Where the dashboard is, for the links in sign-in emails. */
  BRAKE_DASHBOARD_URL: z.url().optional(),
  /** Where apps send provider calls, shown in the dashboard's setup steps. */
  BRAKE_PUBLIC_PROXY_URL: z.url().optional(),
  /** The proxy's outbound IP addresses (comma-separated): the dashboard tells people to allow them. */
  BRAKE_PROXY_EGRESS_IPS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.union([z.ipv4(), z.ipv6()]))),
  /**
   * Test spans may go to private addresses, and OTLP endpoints may be a local http:// collector
   * (development). Set it on the worker too, which sends the real spans.
   */
  ALLOW_PRIVATE_COLLECTORS: z.stringbool().default(false),
  /** Hosted sign-up is open (the billing service serves it). */
  BRAKE_HOSTED_SIGNUP: z.stringbool().default(false),
});

export type ApiEnv = z.output<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.parse(env);
  if (parsed.BRAKE_EMAIL_SIGN_IN && !parsed.BRAKE_DASHBOARD_URL) {
    throw new Error('BRAKE_EMAIL_SIGN_IN needs BRAKE_DASHBOARD_URL (the links point there).');
  }
  return parsed;
}
