import { describe, expect, it } from 'vitest';
import { TwilioAdapter, destination } from '../src/twilio/adapter.js';
import type { OutgoingReq } from '../src/types.js';
import { req } from './helpers.js';

const adapter = new TwilioAdapter();
const AC = `AC${'0'.repeat(32)}`;
const VA = `VA${'1'.repeat(32)}`;
const send = (body: Record<string, string>) =>
  adapter.classify({
    ...req('POST', `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`),
    body,
  });
const verify = (body: Record<string, string>) =>
  adapter.classify({
    ...req('POST', `https://verify.twilio.com/v2/Services/${VA}/Verifications`),
    body,
  });

describe('Twilio prices', () => {
  it('per segment by country, with US carrier fees on top', () => {
    // US: $0.0083 + $0.0062 carrier fee; Germany $0.112 (highest carrier).
    expect(adapter.prices.get('twilio.sms.US')).toBe(14_500n);
    expect(adapter.prices.get('twilio.sms.DE')).toBe(112_000n);
    expect(adapter.prices.get('twilio.mms.US')).toBe(35_500n);
    expect(adapter.prices.get('twilio.mms.DE')).toBeUndefined();
    expect(adapter.prices.get('twilio.verify.sms.US')).toBe(64_500n);
    expect(adapter.prices.get('twilio.verify.whatsapp.US')).toBe(64_700n);
    expect(adapter.prices.get('twilio.verify.email')).toBe(50_000n);
    expect([...adapter.prices.keys()].some((k) => k.startsWith('twilio.verify.call'))).toBe(false);
  });
});

describe('Twilio classify', () => {
  it('prices SMS by segments and destination country', () => {
    const c = send({ To: '+14155552671', From: '+15005550006', Body: 'a'.repeat(161) });
    if (!c.priced) throw new Error(c.reason);
    expect(c.items).toEqual([{ sku: 'twilio.sms.US', units: 2n }]);
    expect(adapter.worstCase(c)).toBe(29_000n);
    expect(c.destination).toEqual({ number: '+14155552671', country: 'US', prefix: '+1415' });
  });

  it('prices MMS per message where published and refuses it elsewhere', () => {
    const us = send({ To: '+14155552671', Body: 'pic', MediaUrl: 'https://x/y.png' });
    expect(us.priced && us.items).toEqual([{ sku: 'twilio.mms.US', units: 1n }]);
    expect(send({ To: '+4915112345678', Body: 'pic', MediaUrl: 'https://x/y.png' }).priced).toBe(
      false,
    );
  });

  it('leaves unknown destinations, WhatsApp and bodiless messages unpriced', () => {
    expect(send({ To: '+999123', Body: 'x' }).priced).toBe(false);
    expect(send({ To: 'whatsapp:+14155552671', Body: 'x' }).priced).toBe(false);
    expect(send({ To: '+14155552671' }).priced).toBe(false);
  });

  it('prices Verify by channel and country; voice is unpriced', () => {
    const sms = verify({ To: '+447400123456', Channel: 'sms' });
    expect(sms.priced && sms.items[0]!.sku).toBe('twilio.verify.sms.GB');
    expect(verify({ To: 'someone@example.com', Channel: 'email' }).priced).toBe(true);
    expect(verify({ To: '+14155552671', Channel: 'call' }).priced).toBe(false);
    expect(verify({ To: '+447400123456', Channel: 'whatsapp' }).priced).toBe(false);
  });

  it('hashes identical sends the same for loop detection', () => {
    const a = send({ To: '+14155552671', Body: 'hi' });
    const b = send({ Body: 'hi', To: '+14155552671' });
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it('counts pumping on country code + three digits', () => {
    expect(destination('+447400123456').prefix).toBe('+44740');
    expect(destination('+14155552671').prefix).toBe('+1415');
  });

  it('injects Basic auth and recognises auth errors', () => {
    const out: OutgoingReq = {
      origin: 'https://api.twilio.com',
      headers: {},
      query: new URLSearchParams(),
    };
    adapter.injectCredential(out, `${AC}:token`);
    expect(out.headers.authorization).toBe(
      `Basic ${Buffer.from(`${AC}:token`).toString('base64')}`,
    );
    expect(adapter.credentialRejected({ status: 401, headers: {} })).toBe(true);
    expect(adapter.credentialRejected({ status: 400, headers: {}, body: { code: 21211 } })).toBe(
      false,
    );
  });
});
