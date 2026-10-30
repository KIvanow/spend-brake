import Stripe from 'stripe';

/**
 * A Stripe client for test mode: live keys are refused unless the caller opts in (only the seed
 * script can, so live products are created by a person on purpose).
 */
export function stripeClient(secretKey: string, opts: { allowLive?: boolean } = {}): Stripe {
  const live = /^(sk|rk)_live_/.test(secretKey);
  if (!/^(sk|rk)_test_/.test(secretKey) && !(live && opts.allowLive)) {
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_).');
  }
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
}

export type { Stripe };
