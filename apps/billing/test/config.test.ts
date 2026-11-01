import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config.js';
import { stripeClient } from '../src/stripe.js';

// Dummy strings only: no real Stripe key is ever used here.
const base = { STRIPE_WEBHOOK_SECRET: 'whsec_dummy' };

describe('Stripe live mode', () => {
  it('takes a test key by default and refuses a live one', () => {
    expect(loadEnv({ ...base, STRIPE_SECRET_KEY: 'sk_test_dummy' }).BILLING_LIVE_MODE).toBe(false);
    expect(() => loadEnv({ ...base, STRIPE_SECRET_KEY: 'sk_live_dummy' })).toThrow(
      /BILLING_LIVE_MODE/,
    );
    expect(() => loadEnv({ ...base, STRIPE_SECRET_KEY: 'rk_live_dummy' })).toThrow(
      /BILLING_LIVE_MODE/,
    );
  });

  it('takes a live key with BILLING_LIVE_MODE=true and refuses a test one', () => {
    const live = { ...base, BILLING_LIVE_MODE: 'true' };
    expect(loadEnv({ ...live, STRIPE_SECRET_KEY: 'sk_live_dummy' }).BILLING_LIVE_MODE).toBe(true);
    expect(loadEnv({ ...live, STRIPE_SECRET_KEY: 'rk_live_dummy' }).BILLING_LIVE_MODE).toBe(true);
    expect(() => loadEnv({ ...live, STRIPE_SECRET_KEY: 'sk_test_dummy' })).toThrow(/live key/);
    expect(() => loadEnv({ ...live, STRIPE_SECRET_KEY: 'sk_org_live_dummy' })).toThrow(/live key/);
  });

  it('builds a client for whichever mode the key matches', () => {
    expect(() => stripeClient('sk_test_dummy', { allowLive: false })).not.toThrow();
    expect(() => stripeClient('sk_live_dummy', { allowLive: true })).not.toThrow();
  });
});
