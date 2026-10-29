import { describe, expect, it } from 'vitest';
import { signAction, signWebhook, verifyAction, verifyWebhook } from '../src/signing.js';

describe('webhook signatures', () => {
  const body = JSON.stringify({ type: 'threshold' });
  it('verify with the right secret inside the replay window', () => {
    const sig = signWebhook('s1', 1000, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhook('s1', { signature: sig, timestamp: '1000' }, body, 1100)).toBe(true);
  });
  it('reject a wrong secret, a changed body, or a stale or future timestamp', () => {
    const sig = signWebhook('s1', 1000, body);
    expect(verifyWebhook('s2', { signature: sig, timestamp: '1000' }, body, 1000)).toBe(false);
    expect(verifyWebhook('s1', { signature: sig, timestamp: '1000' }, `${body} `, 1000)).toBe(
      false,
    );
    expect(verifyWebhook('s1', { signature: sig, timestamp: '1000' }, body, 1301)).toBe(false);
    expect(verifyWebhook('s1', { signature: sig, timestamp: '1000' }, body, 699)).toBe(false);
    expect(verifyWebhook('s1', { signature: sig, timestamp: '1001' }, body, 1000)).toBe(false);
    expect(verifyWebhook('s1', { signature: undefined, timestamp: '1000' }, body, 1000)).toBe(
      false,
    );
  });
});

describe('action tokens', () => {
  const claims = {
    org: 'o1',
    act: 'raise' as const,
    target: 'key:k1',
    kind: 'd' as const,
    amount: '25000000',
    exp: 2000,
  };
  it('round-trip with a unique id', () => {
    const a = signAction('secret', claims);
    const b = signAction('secret', claims);
    expect(a).not.toBe(b);
    const r = verifyAction('secret', a, 1000);
    expect(r).toMatchObject({ ok: true, claims: { ...claims, v: 1 } });
  });
  it('reject tampering, the wrong secret, expiry and garbage', () => {
    const t = signAction('secret', claims);
    const [payload, sig] = t.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        amount: '999000000',
      }),
    ).toString('base64url');
    expect(verifyAction('secret', `${forged}.${sig}`, 1000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyAction('other', t, 1000)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyAction('secret', t, 2000)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyAction('secret', 'nope', 1000)).toEqual({ ok: false, reason: 'malformed' });
  });
});
