import { randomBytes } from 'node:crypto';
import { BudgetEngine, Registry } from '@spend-brake/budget';
import {
  type Db,
  createDb,
  eq,
  migrate,
  orgs,
  providerCredentials,
  reconciliationResults,
  usageEvents,
} from '@spend-brake/db';
import { LocalKeyWrapper, credentialContext, encryptSecret } from '@spend-brake/shared';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TwilioDeps, reconcileTwilio, settleTwilioPending, usdMicros } from '../src/twilio.js';

const ACC = `AC${'a'.repeat(32)}`;
const SID = `SM${'b'.repeat(32)}`;
const SECRET = `${ACC}:auth-token-secret`;
const TZ = 'UTC';
const AT = new Date('2026-10-28T12:00:00Z');

describe('usdMicros', () => {
  it('converts exact decimal strings', () => {
    expect(usdMicros('-0.00830')).toBe(-8_300n);
    expect(usdMicros('1.2345675')).toBe(1_234_568n);
    expect(usdMicros('0')).toBe(0n);
    expect(() => usdMicros('1e-3')).toThrow();
  });
});

let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: Redis;
let engine: BudgetEngine;
let registry: Registry;
const wrapper = new LocalKeyWrapper(randomBytes(32).toString('base64'));

beforeAll(async () => {
  [pg, vk] = await Promise.all([
    new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_PASSWORD: 'p', POSTGRES_USER: 'brake', POSTGRES_DB: 'brake' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  ({ db, pool } = createDb(`postgres://brake:p@${pg.getHost()}:${pg.getMappedPort(5432)}/brake`));
  await migrate(db);
  valkey = new Redis(`redis://${vk.getHost()}:${vk.getMappedPort(6379)}`);
  engine = new BudgetEngine(valkey);
  registry = new Registry(valkey);
});

afterAll(async () => {
  await valkey.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

let n = 0;
async function newOrg() {
  const orgId = `tw${++n}`;
  await db.insert(orgs).values({ id: orgId, name: orgId });
  const envelope = await encryptSecret(wrapper, SECRET, credentialContext(orgId, 'cred-tw'));
  await registry.putCredential({ id: 'cred-tw', orgId, provider: 'twilio', envelope });
  await db.insert(providerCredentials).values({
    id: `cred-tw-${orgId}`,
    orgId,
    provider: 'twilio',
    name: 'twilio',
    envelope: await encryptSecret(wrapper, SECRET, credentialContext(orgId, `cred-tw-${orgId}`)),
    hint: 'cret',
  });
  return orgId;
}

function deps(now: Date, respond: (url: string) => unknown, seen: string[] = []): TwilioDeps {
  return {
    db,
    engine,
    registry,
    wrapper,
    valkey,
    now: () => now,
    fetch: ((url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      const body = respond(url);
      return Promise.resolve(body instanceof Response ? body : Response.json(body));
    }) as typeof fetch,
  };
}

/** A Twilio credential stored as the API does: same id in Valkey and Postgres. */
async function addCredential(orgId: string, id: string, secret: string) {
  const envelope = await encryptSecret(wrapper, secret, credentialContext(orgId, id));
  await registry.putCredential({ id, orgId, provider: 'twilio', envelope });
  await db
    .insert(providerCredentials)
    .values({ id, orgId, provider: 'twilio', name: id, envelope, hint: secret.slice(-4) });
}

async function queueSend(orgId: string, reqId: string) {
  // As the proxy does: the worst case is committed, then the send is queued for settlement.
  await engine.recordSpend({
    orgId,
    amount: 14_500n,
    scopes: [{ kind: 'org' }],
    timeZone: TZ,
    at: AT,
  });
  await engine.addPending(
    orgId,
    reqId,
    {
      provider: 'twilio',
      credentialId: 'cred-tw',
      scopes: ['org'],
      at: AT.toISOString(),
      timeZone: TZ,
      committedMicros: '14500',
      ref: { accountSid: ACC, sid: SID, sku: 'twilio.sms.US', units: '1' },
      keyId: 'k1',
    },
    new Date(AT.getTime() + 120_000),
  );
}

const spent = async (orgId: string) =>
  (await engine.status(orgId, [{ kind: 'org' }], TZ, AT)).find((w) => w.window === 'd:20261028')
    ?.spent;

describe('settleTwilioPending', () => {
  it('defers until Twilio prices the message, then adjusts spend once', async () => {
    const orgId = await newOrg();
    await queueSend(orgId, 'req-1');
    const seen: string[] = [];
    let price: string | null = null;
    const respond = () => ({ sid: SID, price, price_unit: 'USD', num_segments: '1' });

    const early = deps(new Date(AT.getTime() + 60_000), respond, seen);
    expect(await settleTwilioPending(early, [orgId])).toEqual({
      settled: 0,
      deferred: 0,
      expired: 0,
    });

    const later = deps(new Date(AT.getTime() + 300_000), respond, seen);
    expect(await settleTwilioPending(later, [orgId])).toEqual({
      settled: 0,
      deferred: 1,
      expired: 0,
    });
    expect(seen[0]).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACC}/Messages/${SID}.json Basic ${Buffer.from(SECRET).toString('base64')}`,
    );
    // Deferred ten minutes.
    expect(await settleTwilioPending(later, [orgId])).toEqual({
      settled: 0,
      deferred: 0,
      expired: 0,
    });

    price = '-0.00830';
    const priced = deps(new Date(AT.getTime() + 1_000_000), respond, seen);
    expect(await settleTwilioPending(priced, [orgId])).toEqual({
      settled: 1,
      deferred: 0,
      expired: 0,
    });
    // 0.0083 + US carrier fee 0.0062 = 0.0145, which was the worst case: no change.
    expect(await spent(orgId)).toBe(14_500n);
    expect(await settleTwilioPending(priced, [orgId])).toEqual({
      settled: 0,
      deferred: 0,
      expired: 0,
    });
  });

  it('moves spend by the difference and records a signed adjustment event', async () => {
    const orgId = await newOrg();
    await queueSend(orgId, 'req-2');
    const d = deps(new Date(AT.getTime() + 600_000), () => ({
      price: '-0.00400',
      price_unit: 'USD',
      num_segments: '1',
    }));
    expect((await settleTwilioPending(d, [orgId])).settled).toBe(1);
    expect(await spent(orgId)).toBe(10_200n);
    const events = await valkey.xrange(`bk:{o:${orgId}}:events`, '-', '+');
    const adj = events.map(([, f]) => f).find((f) => f.includes('adjustment'));
    expect(adj).toEqual(
      expect.arrayContaining([
        'costMicros',
        '-4300',
        'toMicros',
        '10200',
        'usageAt',
        AT.toISOString(),
      ]),
    );
  });

  it('keeps the worst case after 48 hours and on errors defers', async () => {
    const orgId = await newOrg();
    await queueSend(orgId, 'req-3');
    const failing = deps(new Date(AT.getTime() + 600_000), () => ({ code: 20404 }));
    expect((await settleTwilioPending(failing, [orgId])).deferred).toBe(1);
    const late = deps(new Date(AT.getTime() + 49 * 3600_000), () => ({ price: '-1.0' }));
    expect(await settleTwilioPending(late, [orgId])).toEqual({
      settled: 0,
      deferred: 0,
      expired: 1,
    });
    expect(await spent(orgId)).toBe(14_500n);
  });
});

describe('reconcileTwilio', () => {
  it('compares Usage Records with sends plus adjustments per UTC day and alerts above 5%', async () => {
    const orgId = await newOrg();
    await db.insert(usageEvents).values([
      {
        orgId,
        ts: AT,
        streamId: '1-0',
        type: 'usage',
        provider: 'twilio',
        sku: 'twilio.sms.US',
        skus: 'twilio.sms.US',
        costMicros: 2_000_000n,
        status: 201,
      },
      {
        // Settled the next day, counted on the day of the send.
        orgId,
        ts: new Date('2026-10-29T00:30:00Z'),
        streamId: '2-0',
        type: 'adjustment',
        provider: 'twilio',
        sku: 'twilio.sms.US',
        skus: 'twilio.sms.US',
        costMicros: -500_000n,
        data: { usageAt: AT.toISOString() },
      },
    ]);
    const seen: string[] = [];
    const d = deps(
      new Date('2026-10-30T09:00:00Z'),
      (url) => {
        const u = new URL(url);
        const day = u.searchParams.get('StartDate');
        const cat = u.searchParams.get('Category');
        if (day !== '2026-10-28') return { usage_records: [] };
        if (cat === 'sms-outbound') return { usage_records: [{ price: '1.2', price_unit: 'usd' }] };
        if (cat === 'sms-messages-carrierfees')
          return { usage_records: [{ price: '0.1', price_unit: 'USD' }] };
        return { usage_records: [] };
      },
      seen,
    );
    const alerts = (await reconcileTwilio(d)).filter((x) => x.orgId === orgId);
    expect(seen.some((s) => s.includes(`/Accounts/${ACC}/Usage/Records/Daily.json?`))).toBe(true);
    const rows = await db
      .select()
      .from(reconciliationResults)
      .where(eq(reconciliationResults.orgId, orgId));
    const sms = rows.find((r) => r.day === '2026-10-28' && r.family === 'twilio.sms');
    expect(sms).toMatchObject({ ledgerMicros: 1_500_000n, billedMicros: 1_300_000n });
    expect(alerts).toEqual([
      expect.objectContaining({
        type: 'reconcile_drift',
        orgId,
        dedupeId: `reconcile:${orgId}:2026-10-28:twilio.sms`,
      }),
    ]);
  });
});

describe('settlement edge cases', () => {
  it('settles failed messages at zero and flags prices above the worst case', async () => {
    const failed = await newOrg();
    await queueSend(failed, 'req-f');
    const d = deps(new Date(AT.getTime() + 600_000), () => ({ status: 'failed', price: null }));
    expect((await settleTwilioPending(d, [failed])).settled).toBe(1);
    expect(await spent(failed)).toBe(0n);

    const dear = await newOrg();
    await queueSend(dear, 'req-d');
    const up = deps(new Date(AT.getTime() + 600_000), () => ({
      price: '-0.02000',
      price_unit: 'USD',
      num_segments: '1',
    }));
    expect((await settleTwilioPending(up, [dear])).settled).toBe(1);
    expect(await spent(dear)).toBe(26_200n);
    const events = await valkey.xrange(`bk:{o:${dear}}:events`, '-', '+');
    const adj = events.map(([, f]) => f).find((f) => f.includes('adjustment'))!;
    expect(adj).toEqual(expect.arrayContaining(['underpriced', '1', 'costMicros', '11700']));
  });

  it('drops records it cannot settle instead of blocking the queue', async () => {
    const orgId = await newOrg();
    await engine.addPending(
      orgId,
      'req-other',
      {
        provider: 'someone-else',
        credentialId: 'x',
        scopes: ['org'],
        at: AT.toISOString(),
        timeZone: TZ,
        committedMicros: '1',
        ref: {},
        keyId: 'k1',
      },
      AT,
    );
    await valkey.set(`bk:{o:${orgId}}:pending:req-bad`, '{not json');
    await valkey.zadd(`bk:{o:${orgId}}:pendingq`, AT.getTime(), 'req-bad');
    const d = deps(new Date(AT.getTime() + 600_000), () => ({}));
    expect(await settleTwilioPending(d, [orgId])).toEqual({ settled: 0, deferred: 0, expired: 0 });
    expect(await engine.duePending(orgId, new Date(AT.getTime() + 600_000))).toEqual([]);
  });
});

describe('reconciliation robustness', () => {
  const usage = (orgId: string) =>
    db.insert(usageEvents).values({
      orgId,
      ts: AT,
      streamId: '9-0',
      type: 'usage',
      provider: 'twilio',
      sku: 'twilio.sms.US',
      skus: 'twilio.sms.US',
      costMicros: 1_000_000n,
      status: 201,
    });
  const records = (url: string) => {
    const u = new URL(url);
    if (u.searchParams.get('StartDate') !== '2026-10-28') return { usage_records: [] };
    if (u.searchParams.get('Category') !== 'sms-outbound') return { usage_records: [] };
    return { usage_records: [{ price: '1.0', price_unit: 'USD' }] };
  };
  const row = async (orgId: string) =>
    (
      await db.select().from(reconciliationResults).where(eq(reconciliationResults.orgId, orgId))
    ).find((r) => r.day === '2026-10-28' && r.family === 'twilio.sms');

  it('counts an account once, reconciles API keys by the account settlement saw, survives a 401', async () => {
    const ACC2 = `AC${'c'.repeat(32)}`;
    // Two credentials for one account (a rotation in progress).
    const rotated = `tw${++n}`;
    await db.insert(orgs).values({ id: rotated, name: rotated });
    await addCredential(rotated, `old-${rotated}`, `${ACC2}:old-token`);
    await addCredential(rotated, `new-${rotated}`, `${ACC2}:new-token`);
    await usage(rotated);
    // An API key: unknown account until a send was settled through it.
    const apiKey = `tw${++n}`;
    await db.insert(orgs).values({ id: apiKey, name: apiKey });
    await addCredential(apiKey, `sk-${apiKey}`, `SK${'d'.repeat(32)}:secret`);
    await usage(apiKey);
    await engine.addPending(
      apiKey,
      'req-sk',
      {
        provider: 'twilio',
        credentialId: `sk-${apiKey}`,
        scopes: ['org'],
        at: AT.toISOString(),
        timeZone: TZ,
        committedMicros: '0',
        ref: { accountSid: ACC2, sid: SID, sku: 'twilio.sms.US', units: '1' },
        keyId: 'k1',
      },
      AT,
    );
    // A credential Twilio refuses.
    const revoked = `tw${++n}`;
    await db.insert(orgs).values({ id: revoked, name: revoked });
    await addCredential(revoked, `bad-${revoked}`, `${ACC}:revoked-token`);

    const now = new Date('2026-10-30T09:00:00Z');
    const respond = (url: string) =>
      url.includes('Usage/Records') && url.includes(ACC) && !url.includes(ACC2)
        ? new Response('{"code":20003}', { status: 401 })
        : url.includes('/Messages/')
          ? { price: null, status: 'queued' }
          : records(url);
    await settleTwilioPending(deps(now, respond), [apiKey]);
    const warnings: string[] = [];
    const d = { ...deps(now, respond), log: { warn: (_o: object, m: string) => warnings.push(m) } };
    await reconcileTwilio(d);
    expect(await row(rotated)).toMatchObject({
      billedMicros: 1_000_000n,
      ledgerMicros: 1_000_000n,
    });
    expect(await row(apiKey)).toMatchObject({ billedMicros: 1_000_000n });
    expect(warnings).toContain('twilio reconciliation failed');
  });

  it('records yesterday without alerting while sends may still be settling', async () => {
    const orgId = await newOrg();
    await usage(orgId);
    const d = deps(new Date('2026-10-29T09:00:00Z'), (url) => {
      const u = new URL(url);
      if (u.searchParams.get('Category') !== 'sms-outbound') return { usage_records: [] };
      return { usage_records: [{ price: '2.0', price_unit: 'USD' }] };
    });
    const alerts = (await reconcileTwilio(d)).filter(
      (a) => a.orgId === orgId && a.data.day === '2026-10-28',
    );
    expect(alerts).toEqual([]);
    expect(await row(orgId)).toMatchObject({ billedMicros: 2_000_000n });
  });
});
