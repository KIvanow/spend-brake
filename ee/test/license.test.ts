import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LICENSE_PUBLIC_KEY } from '../src/license/keys.js';
import {
  GRACE_MS,
  LicenseError,
  allows,
  licenseState,
  signLicense,
  verifyLicense,
} from '../src/license/license.js';
import { issuer, license } from './harness.js';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err instanceof LicenseError ? err.code : String(err);
  }
};

describe('license files', () => {
  const l = license({ org: 'acme', features: ['sso', 'approvals'] });
  const file = signLicense(l, issuer.privateKey);

  it('verifies a valid license offline', () => {
    expect(verifyLicense(file, issuer.publicKey)).toEqual(l);
  });

  it('rejects a tampered license', () => {
    const doc = JSON.parse(file) as { payload: string };
    const payload = JSON.parse(Buffer.from(doc.payload, 'base64url').toString()) as object;
    const forged = JSON.stringify({
      ...doc,
      payload: Buffer.from(JSON.stringify({ ...payload, orgUnits: 1000 })).toString('base64url'),
    });
    expect(codeOf(() => verifyLicense(forged, issuer.publicKey))).toBe('bad_signature');
    // A flipped signature bit, too.
    const sig = JSON.parse(file) as { signature: string };
    const bytes = Buffer.from(sig.signature, 'base64url');
    bytes[0]! ^= 1;
    const flipped = JSON.stringify({ ...doc, signature: bytes.toString('base64url') });
    expect(codeOf(() => verifyLicense(flipped, issuer.publicKey))).toBe('bad_signature');
  });

  it('rejects a license signed with another key, including the real one checked by the test key', () => {
    const other = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(codeOf(() => verifyLicense(signLicense(l, other.privateKey), issuer.publicKey))).toBe(
      'bad_signature',
    );
    // Test-issued licenses mean nothing to a real build.
    expect(codeOf(() => verifyLicense(file, LICENSE_PUBLIC_KEY))).toBe('bad_signature');
  });

  it('rejects malformed files and invalid fields', () => {
    expect(codeOf(() => verifyLicense('not json', issuer.publicKey))).toBe('malformed');
    expect(
      codeOf(() =>
        verifyLicense('{"format":"other/1","payload":"e30","signature":"AA"}', issuer.publicKey),
      ),
    ).toBe('malformed');
    const backwards = signLicense(
      { ...l, issuedAt: l.expiresAt, expiresAt: l.issuedAt },
      issuer.privateKey,
    );
    expect(codeOf(() => verifyLicense(backwards, issuer.publicKey))).toBe('invalid');
  });
});

describe('expiry and grace', () => {
  const l = license({ features: ['approvals'], expiresAt: '2026-10-01T00:00:00.000Z' });
  const at = (iso: string) => licenseState(l, new Date(iso));

  it('is active before expiry, then in grace for 14 days, then read-only', () => {
    expect(at('2026-09-30T00:00:00Z').status).toBe('active');
    expect(at('2026-10-01T00:00:00Z').status).toBe('grace');
    expect(at('2026-10-14T23:59:59Z').status).toBe('grace');
    const expired = at('2026-10-15T00:00:00Z');
    expect(expired).toMatchObject({ status: 'expired', readOnlyAt: '2026-10-15T00:00:00.000Z' });
    expect(GRACE_MS).toBe(14 * 24 * 3600_000);
  });

  it('allows changes while active or in grace, reads after; nothing it does not list', () => {
    const grace = at('2026-10-10T00:00:00Z');
    expect(allows(grace, 'approvals', 'write')).toBe(true);
    const expired = at('2026-11-01T00:00:00Z');
    expect(allows(expired, 'approvals', 'write')).toBe(false);
    expect(allows(expired, 'approvals', 'read')).toBe(true);
    expect(allows(at('2026-09-01T00:00:00Z'), 'sso', 'read')).toBe(false);
    expect(allows(licenseState(null, new Date()), 'approvals', 'read')).toBe(false);
  });
});
