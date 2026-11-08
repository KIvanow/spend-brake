import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASED_LICENSE_PUBLIC_KEY, isReleasedLicenseKey, loadEnv } from '../src/config.js';
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

  it('turns Stripe Tax on with live mode unless BILLING_AUTOMATIC_TAX says otherwise', () => {
    const test = { ...base, STRIPE_SECRET_KEY: 'sk_test_dummy' };
    const live = { ...base, STRIPE_SECRET_KEY: 'sk_live_dummy', BILLING_LIVE_MODE: 'true' };
    expect(loadEnv(test).automaticTax).toBe(false);
    expect(loadEnv({ ...test, BILLING_AUTOMATIC_TAX: '' }).automaticTax).toBe(false);
    expect(loadEnv({ ...test, BILLING_AUTOMATIC_TAX: 'true' }).automaticTax).toBe(true);
    expect(loadEnv(live).automaticTax).toBe(true);
    expect(loadEnv({ ...live, BILLING_AUTOMATIC_TAX: '' }).automaticTax).toBe(true);
    expect(loadEnv({ ...live, BILLING_AUTOMATIC_TAX: 'false' }).automaticTax).toBe(false);
  });

  it('builds a client for whichever mode the key matches', () => {
    expect(() => stripeClient('sk_test_dummy', { allowLive: false })).not.toThrow();
    expect(() => stripeClient('sk_live_dummy', { allowLive: true })).not.toThrow();
  });
});

describe('license signing key', () => {
  const throwaway = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;

  it('is the public key released ee builds verify with', () => {
    const ee = readFileSync(new URL('../../../ee/src/license/keys.ts', import.meta.url), 'utf8');
    expect(ee).toContain(RELEASED_LICENSE_PUBLIC_KEY.trim());
  });

  it('refuses to take payments in live mode with a key installs would refuse', async () => {
    const live = {
      ...base,
      STRIPE_SECRET_KEY: 'sk_live_dummy',
      BILLING_LIVE_MODE: 'true',
      BRAKE_LICENSE_SIGNING_KEY: throwaway,
    };
    expect(() => loadEnv(live)).toThrow(/not the key released ee builds verify/);
    // In test mode a throwaway key is fine, and says so.
    const test = {
      ...base,
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      BRAKE_LICENSE_SIGNING_KEY: throwaway,
    };
    expect(loadEnv(test)).toMatchObject({ licenseKey: throwaway, releasedLicenseKey: false });
    expect(isReleasedLicenseKey(throwaway)).toBe(false);
    // An empty key file is no key: billing starts, and sells no license.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const empty = join(mkdtempSync(join(tmpdir(), 'billing-key-')), 'license.pem');
    writeFileSync(empty, '\n');
    expect(
      loadEnv({ ...live, BRAKE_LICENSE_SIGNING_KEY: '', BRAKE_LICENSE_SIGNING_KEY_FILE: empty }),
    ).toMatchObject({ licenseKey: null, releasedLicenseKey: false });
    // An unreadable key names the setting.
    expect(() => loadEnv({ ...test, BRAKE_LICENSE_SIGNING_KEY: 'not a key' })).toThrow(
      /BRAKE_LICENSE_SIGNING_KEY is not a readable private key/,
    );
  });
});
