import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { assertStripeKeyMode } from './stripe.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8083),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  /** Behind the dashboard's nginx: rate limit by the client's X-Forwarded-For address. */
  TRUST_PROXY: z.stringbool().default(false),
  DATABASE_URL: z.string().default('postgres://brake:brake@localhost:15432/brake'),
  VALKEY_URL: z.string().default('redis://localhost:16379'),
  /** A test-mode key (sk_test_ / rk_test_), or a live one (sk_live_ / rk_live_) in live mode. */
  STRIPE_SECRET_KEY: z.string().min(1),
  /** Take real payments: STRIPE_SECRET_KEY must then be a live key, and a test key is refused. */
  BILLING_LIVE_MODE: z.stringbool().default(false),
  /**
   * Stripe Tax on Checkout (VAT added to the tax-exclusive prices). Needs Stripe Tax set up in the
   * account (origin address, registrations); unset, it follows BILLING_LIVE_MODE.
   */
  BILLING_AUTOMATIC_TAX: z.stringbool().optional(),
  /** The webhook endpoint's signing secret (whsec_...), from Stripe or `stripe listen`. */
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  BRAKE_DASHBOARD_URL: z.url().default('http://localhost:3000'),
  /** Ed25519 private key (PEM) that signs license files; or a path in ..._FILE. */
  BRAKE_LICENSE_SIGNING_KEY: z.string().optional(),
  BRAKE_LICENSE_SIGNING_KEY_FILE: z.string().optional(),
  BRAKE_HOSTED_SIGNUP: z.stringbool().default(false),
});

export type BillingEnv = z.output<typeof envSchema> & {
  licenseKey: string | null;
  automaticTax: boolean;
};

export function loadEnv(env: NodeJS.ProcessEnv = process.env): BillingEnv {
  const parsed = envSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')),
  );
  assertStripeKeyMode(parsed.STRIPE_SECRET_KEY, parsed.BILLING_LIVE_MODE);
  const licenseKey =
    parsed.BRAKE_LICENSE_SIGNING_KEY ??
    (parsed.BRAKE_LICENSE_SIGNING_KEY_FILE
      ? readFileSync(parsed.BRAKE_LICENSE_SIGNING_KEY_FILE, 'utf8')
      : null);
  return {
    ...parsed,
    licenseKey,
    automaticTax: parsed.BILLING_AUTOMATIC_TAX ?? parsed.BILLING_LIVE_MODE,
  };
}
