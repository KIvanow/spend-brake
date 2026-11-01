import Stripe from 'stripe';

const LIVE_KEY = /^(sk|rk)_live_/;
const TEST_KEY = /^(sk|rk)_test_/;

/**
 * Fails fast when the key's mode is not the one asked for: a live key needs
 * BILLING_LIVE_MODE=true, and BILLING_LIVE_MODE=true needs a live key.
 */
export function assertStripeKeyMode(secretKey: string, liveMode: boolean): void {
  if (liveMode && !LIVE_KEY.test(secretKey)) {
    throw new Error(
      'BILLING_LIVE_MODE=true needs a live key in STRIPE_SECRET_KEY (sk_live_ or rk_live_).',
    );
  }
  if (!liveMode && !TEST_KEY.test(secretKey)) {
    throw new Error(
      'STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_); set BILLING_LIVE_MODE=true for a live key.',
    );
  }
}

/**
 * A Stripe client, test mode unless the caller opts in to live keys (the billing service with
 * BILLING_LIVE_MODE=true, the setup scripts with BRAKE_STRIPE_ALLOW_LIVE=1).
 */
export function stripeClient(secretKey: string, opts: { allowLive?: boolean } = {}): Stripe {
  const live = LIVE_KEY.test(secretKey);
  if (!TEST_KEY.test(secretKey) && !(live && opts.allowLive)) {
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_).');
  }
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
}

/**
 * The setup scripts' client (seed, webhook-setup): STRIPE_SECRET_KEY from the environment, and a
 * live key only with BRAKE_STRIPE_ALLOW_LIVE=1 (or true).
 */
export function stripeFromEnv(env: NodeJS.ProcessEnv = process.env): {
  stripe: Stripe;
  live: boolean;
} {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Set STRIPE_SECRET_KEY (a test key, or a live key for live mode).');
  const allowLive = ['1', 'true'].includes(env.BRAKE_STRIPE_ALLOW_LIVE ?? '');
  if (LIVE_KEY.test(key) && !allowLive) {
    throw new Error('STRIPE_SECRET_KEY is a live key: set BRAKE_STRIPE_ALLOW_LIVE=1 to use it.');
  }
  return { stripe: stripeClient(key, { allowLive }), live: LIVE_KEY.test(key) };
}

/** The dashboard the setup scripts point Stripe at (portal return URL, webhook endpoint). */
export const dashboardFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  (env.BRAKE_DASHBOARD_URL || 'https://app.spendbrake.dev').replace(/\/$/, '');

export type { Stripe };
