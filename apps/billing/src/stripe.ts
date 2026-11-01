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
 * BILLING_LIVE_MODE=true, the seed script with BRAKE_STRIPE_ALLOW_LIVE=true).
 */
export function stripeClient(secretKey: string, opts: { allowLive?: boolean } = {}): Stripe {
  const live = LIVE_KEY.test(secretKey);
  if (!TEST_KEY.test(secretKey) && !(live && opts.allowLive)) {
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_).');
  }
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
}

export type { Stripe };
