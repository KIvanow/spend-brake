import { isIP } from 'node:net';
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
  /**
   * Custom API origins may be private addresses (an API on this machine or network). Set it on
   * the proxy too, which makes the calls. Leave off on a server other people use.
   */
  ALLOW_PRIVATE_CUSTOM_APIS: z.stringbool().default(false),
  /** The service's own hostnames (TLS overlay): custom APIs may not point at them. */
  BRAKE_PROXY_DOMAIN: z.string().optional(),
  BRAKE_APP_DOMAIN: z.string().optional(),
  /** Hosted sign-up is open (the billing service serves it). */
  BRAKE_HOSTED_SIGNUP: z.stringbool().default(false),
});

export type ApiEnv = z.output<typeof envSchema>;

/**
 * Hostnames custom APIs may not point at: the proxy's and the dashboard's (spendbrake.dev is
 * refused regardless). Loopback names and IP addresses are left to ALLOW_PRIVATE_CUSTOM_APIS.
 */
export function ownHosts(env: ApiEnv): string[] {
  const hosts = [env.BRAKE_PROXY_DOMAIN, env.BRAKE_APP_DOMAIN];
  for (const url of [env.BRAKE_PUBLIC_PROXY_URL, env.BRAKE_DASHBOARD_URL]) {
    if (url) hosts.push(new URL(url).hostname);
  }
  return [
    ...new Set(
      hosts
        .map((h) => h?.trim().toLowerCase().replace(/\.$/, ''))
        .filter(
          (h): h is string => Boolean(h) && h !== 'localhost' && !isIP(h!.replace(/^\[|\]$/g, '')),
        ),
    ),
  ];
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.parse(env);
  if (parsed.BRAKE_EMAIL_SIGN_IN && !parsed.BRAKE_DASHBOARD_URL) {
    throw new Error('BRAKE_EMAIL_SIGN_IN needs BRAKE_DASHBOARD_URL (the links point there).');
  }
  return parsed;
}
