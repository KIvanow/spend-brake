import Stripe from 'stripe';

/**
 * A Stripe client for test mode only: live keys are refused, so nothing here can move real
 * money until someone changes this on purpose.
 */
export function stripeClient(secretKey: string): Stripe {
  if (!/^(sk|rk)_test_/.test(secretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_).');
  }
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
}

export type { Stripe };
