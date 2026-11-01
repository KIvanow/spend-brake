import { BudgetEngine } from '@spend-brake/budget';
import { GoogleMapsAdapter, TwilioAdapter } from '@spend-brake/catalog';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticSecretStore } from '../src/secrets.js';
import {
  type Harness,
  MockGoogle,
  newKey,
  newOrg,
  startProxy,
  startValkey,
  disconnectClients,
} from './harness.js';

const AC = `AC${'a'.repeat(32)}`;
let container: StartedTestContainer;
let mock: MockGoogle;
let h: Harness;
let engine: BudgetEngine;

beforeAll(async () => {
  let url: string;
  ({ container, url } = await startValkey());
  mock = await new MockGoogle().start();
  h = await startProxy(url, mock, {
    adapters: [new GoogleMapsAdapter(), new TwilioAdapter()],
    secrets: new StaticSecretStore({ 'cred-twilio': `${AC}:auth-token` }),
    upstreamOverrides: {
      'https://api.twilio.com': mock.url,
      'https://verify.twilio.com': mock.url,
    },
  });
  engine = new BudgetEngine(h.valkey);
  mock.respond = (_req, reply) =>
    reply
      .code(201)
      .send({ sid: `SM${'c'.repeat(32)}`, account_sid: AC, status: 'queued', price: null });
});

afterAll(async () => {
  await h.proxy.close();
  await h.valkey.quit();
  await mock.app.close();
  disconnectClients();
  await container.stop();
});

const sms = (token: string, to: string, body = 'Your code is 123456') =>
  h.proxy.inject({
    method: 'POST',
    url: `/twilio/2010-04-01/Accounts/${AC}/Messages.json`,
    headers: { 'x-brake-key': token, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ To: to, From: '+15005550006', Body: body }).toString(),
  });

describe('Twilio through the proxy', () => {
  it('prices form-encoded sends by segments and injects Basic auth', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org, { credentials: { twilio: 'cred-twilio' } });
    const res = await sms(token, '+14155550100', 'a'.repeat(161));
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-brake-cost-micros']).toBe('29000');
    expect(mock.last().headers.authorization).toBe(
      `Basic ${Buffer.from(`${AC}:auth-token`).toString('base64')}`,
    );
    expect(mock.last().body.toString()).toContain('Body=aaaa');
    await h.proxy.brakeDrain();
    // Queued for settlement at Twilio's final price.
    const due = await engine.duePending(org, new Date('2026-10-29T12:05:00Z'));
    expect(due).toHaveLength(1);
    expect(due[0]!.record).toMatchObject({
      provider: 'twilio',
      credentialId: 'cred-twilio',
      committedMicros: '29000',
      ref: { accountSid: AC, sid: `SM${'c'.repeat(32)}`, sku: 'twilio.sms.US', units: '2' },
    });
  });

  it('denies countries the key does not allow; US and CA are the default', async () => {
    const org = newOrg();
    const def = await newKey(h, org, { credentials: { twilio: 'cred-twilio' } });
    const before = mock.seen.length;
    const ng = await sms(def.token, '+2348031234567');
    expect(ng.statusCode).toBe(403);
    expect(ng.json()).toMatchObject({ error: 'sku_not_allowed', country: 'NG' });
    expect((await sms(def.token, '+16135550123')).statusCode).toBe(201); // Canada
    const de = await newKey(h, org, { credentials: { twilio: 'cred-twilio' }, countries: ['DE'] });
    expect((await sms(de.token, '+4915112345678')).statusCode).toBe(201);
    expect((await sms(de.token, '+14155550100')).statusCode).toBe(403);
    expect(mock.seen.length).toBe(before + 2);
  });

  it('a pumping run of 1,000 sends to one prefix is stopped well under $5', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org, { credentials: { twilio: 'cred-twilio' } });
    const before = mock.seen.length;
    const codes: number[] = [];
    for (let i = 0; i < 1000; i++) {
      // Different numbers in one range, as pumping bots do.
      codes.push(
        (await sms(token, `+1415555${String(1000 + i).slice(-4)}`, `code ${i}`)).statusCode,
      );
    }
    const sent = mock.seen.length - before;
    expect(sent).toBe(50);
    expect(codes.filter((c) => c === 429)).toHaveLength(950);
    await h.proxy.brakeDrain();
    const [day] = await engine.status(
      org,
      [{ kind: 'key', id }],
      'UTC',
      new Date('2026-10-29T12:00:00Z'),
    );
    expect(day!.spent).toBe(50n * 14_500n); // $0.725
    expect(day!.spent).toBeLessThan(5_000_000n);
  });

  it('caps one number at five messages an hour', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org, {
      name: 'signup sms',
      credentials: { twilio: 'cred-twilio' },
    });
    const codes = [];
    for (let i = 0; i < 7; i++)
      codes.push((await sms(token, '+14155550199', `msg ${i}`)).statusCode);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429, 429]);
    // The pause covers the whole key and says it is for pumping, not repeated requests.
    const other = await sms(token, '+14155550123', 'hello');
    expect(other.statusCode).toBe(429);
    expect(other.json()).toMatchObject({ error: 'loop_detected', reason: 'pumping' });
    expect(other.json<{ message: string }>().message).toMatch(/SMS pumping.*all providers/);
    expect(other.json<{ message: string }>().message).toContain(
      `key "signup sms" (${id}) is paused`,
    );
  });
});
