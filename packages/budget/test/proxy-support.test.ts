import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetEngine, type LoopCheck, type ReserveRequest } from '../src/engine.js';
import type { Scope } from '../src/keys.js';
import { type TestValkey, newOrg, newReq, startValkey } from './valkey.js';

const TZ = 'UTC';
const NOW = new Date('2026-10-29T12:00:00Z');
const keyScope: Scope = { kind: 'key', id: 'k1' };
const sess: Scope = { kind: 'sess', id: 's1' };

let valkey: TestValkey;
let engine: BudgetEngine;

beforeAll(async () => {
  valkey = await startValkey();
  engine = new BudgetEngine(valkey.client);
});

afterAll(async () => {
  await valkey.stop();
});

function req(orgId: string, amount: bigint, extra: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    orgId,
    reqId: newReq(),
    amount,
    scopes: [{ kind: 'org' }, keyScope],
    killTargets: [{ kind: 'org' }],
    timeZone: TZ,
    now: NOW,
    ...extra,
  };
}

const loop = (hash: string, extra: Partial<LoopCheck> = {}): LoopCheck => ({
  keyId: 'k1',
  hash,
  rateScope: keyScope,
  identical: 3,
  windowSec: 60,
  perMinute: 1000,
  cooldownSec: 600,
  ...extra,
});

describe('loop detection', () => {
  it('trips the circuit after too many identical requests and blocks everything on the key', async () => {
    const org = newOrg();
    for (let i = 0; i < 3; i++) {
      expect((await engine.reserve(req(org, 1n, { loop: loop('h1') }))).outcome).toBe('ok');
    }
    expect(await engine.reserve(req(org, 1n, { loop: loop('h1') }))).toEqual({
      outcome: 'loop_detected',
      retryAfterSec: 600,
      tripped: true,
    });
    // Different requests on the same key are blocked too until the cooldown ends.
    const after = await engine.reserve(req(org, 1n, { loop: loop('h2') }));
    expect(after).toMatchObject({ outcome: 'loop_detected', tripped: false });
    if (after.outcome === 'loop_detected') expect(after.retryAfterSec).toBeGreaterThan(590);
    // Nothing was reserved by blocked requests.
    const [day] = await engine.status(org, [keyScope], TZ, NOW);
    expect(day!.held).toBe(3n);

    await engine.resetCircuit(org, 'k1');
    expect((await engine.reserve(req(org, 1n, { loop: loop('h2') }))).outcome).toBe('ok');
  });

  it('applies the per-minute rule only to sessions', async () => {
    const org = newOrg();
    const noSession = (i: number) => {
      const check = loop(`n${i}`, { perMinute: 2 });
      delete check.rateScope;
      return check;
    };
    for (let i = 0; i < 10; i++) {
      expect((await engine.reserve(req(org, 1n, { loop: noSession(i) }))).outcome).toBe('ok');
    }
  });

  it('trips on the per-minute rate of a session', async () => {
    const org = newOrg();
    const check = (i: number) => loop(`h${i}`, { rateScope: sess, perMinute: 5 });
    for (let i = 0; i < 5; i++) {
      expect((await engine.reserve(req(org, 1n, { loop: check(i) }))).outcome).toBe('ok');
    }
    expect((await engine.reserve(req(org, 1n, { loop: check(99) }))).outcome).toBe('loop_detected');
  });

  it('checks the kill set before the loop counters', async () => {
    const org = newOrg();
    await engine.kill(org, { kind: 'org' });
    for (let i = 0; i < 10; i++) {
      expect((await engine.reserve(req(org, 1n, { loop: loop('h') }))).outcome).toBe('killed');
    }
    await engine.unkill(org, { kind: 'org' });
    expect((await engine.reserve(req(org, 1n, { loop: loop('h') }))).outcome).toBe('ok');
  });
});

describe('cap templates', () => {
  it('creates a session cap on first use and enforces it', async () => {
    const org = newOrg();
    const r = (amount: bigint) =>
      engine.reserve(
        req(org, amount, {
          scopes: [{ kind: 'org' }, keyScope, sess],
          capTemplates: [{ scope: sess, kind: 'm', hard: 5n }],
        }),
      );
    expect((await r(3n)).outcome).toBe('ok');
    expect(await engine.getCap(org, sess, 'm')).toEqual({ hard: 5n, soft: null, version: 1 });
    expect(await r(3n)).toMatchObject({ outcome: 'budget_exceeded', scope: 'sess:s1', cap: 5n });
    expect(await valkey.client.ttl(`bk:{o:${org}}:cap:sess:s1:m`)).toBeGreaterThan(0);
  });

  it('never overrides an existing cap', async () => {
    const org = newOrg();
    await engine.setCap(org, sess, 'm', { hard: 100n, soft: null });
    const res = await engine.reserve(
      req(org, 50n, {
        scopes: [sess],
        capTemplates: [{ scope: sess, kind: 'm', hard: 5n }],
      }),
    );
    expect(res.outcome).toBe('ok');
    expect((await engine.getCap(org, sess, 'm'))?.hard).toBe(100n);
  });
});

describe('session scopes', () => {
  it('expire their counters after two days instead of the window TTL', async () => {
    const org = newOrg();
    await engine.reserve(req(org, 1n, { scopes: [sess, keyScope] }));
    const ttl = (k: string) => valkey.client.ttl(`bk:{o:${org}}:${k}`);
    expect(await ttl('held:sess:s1:m:202610')).toBeLessThanOrEqual(2 * 86400);
    expect(await ttl('held:sess:s1:d:20261029')).toBeLessThanOrEqual(2 * 86400);
    expect(await ttl('held:key:k1:m:202610')).toBeGreaterThan(300 * 86400);
  });
});

describe('recorded spend', () => {
  it('adds unreserved spend, units and an event in one call', async () => {
    const org = newOrg();
    await engine.recordSpend({
      orgId: org,
      amount: 9n,
      scopes: [{ kind: 'org' }, keyScope],
      timeZone: TZ,
      at: NOW,
      units: [{ sku: 'geocoding', units: 1n }],
      event: { type: 'usage', failOpen: '1' },
    });
    const [day] = await engine.status(org, [keyScope], TZ, NOW);
    expect(day).toMatchObject({ spent: 9n, held: 0n });
    expect((await engine.monthlyUnits(org, ['geocoding'], TZ, NOW)).get('geocoding')).toBe(1n);
    expect(await valkey.client.xlen(`bk:{o:${org}}:events`)).toBe(1);
  });
});

describe('remaining', () => {
  it('reports the smallest headroom left across capped scopes', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 100n, soft: null });
    await engine.setCap(org, { kind: 'org' }, 'm', { hard: 50n, soft: null });
    expect(await engine.reserve(req(org, 10n))).toMatchObject({ outcome: 'ok', remaining: 40n });
    const uncapped = newOrg();
    expect(await engine.reserve(req(uncapped, 10n))).toMatchObject({ remaining: null });
  });
});

describe('monthly units', () => {
  it('counts billed units per SKU in the month window', async () => {
    const org = newOrg();
    await engine.addUnits(org, [{ sku: 'geocoding', units: 3n }], TZ, NOW);
    await engine.addUnits(
      org,
      [
        { sku: 'geocoding', units: 2n },
        { sku: 'x', units: 0n },
      ],
      TZ,
      NOW,
    );
    const units = await engine.monthlyUnits(org, ['geocoding', 'x'], TZ, NOW);
    expect(units).toEqual(
      new Map([
        ['geocoding', 5n],
        ['x', 0n],
      ]),
    );
    const nextMonth = await engine.monthlyUnits(
      org,
      ['geocoding'],
      TZ,
      new Date('2026-11-01T00:00:01Z'),
    );
    expect(nextMonth.get('geocoding')).toBe(0n);
    expect(await valkey.client.ttl(`bk:{o:${org}}:units:geocoding:m:202610`)).toBeGreaterThan(0);
  });
});

describe('billing sessions and events', () => {
  it('reports only the first request of a billing session', async () => {
    const org = newOrg();
    expect(await engine.startBillingSession(org, 'google-maps', 'abc', 300)).toBe(true);
    expect(await engine.startBillingSession(org, 'google-maps', 'abc', 300)).toBe(false);
    expect(await engine.startBillingSession(org, 'google-maps', 'def', 300)).toBe(true);
  });

  it('appends events to the org stream', async () => {
    const org = newOrg();
    await engine.emit(org, { type: 'usage', reqId: 'r1', costMicros: '5000' });
    const entries = await valkey.client.xrange(`bk:{o:${org}}:events`, '-', '+');
    expect(entries).toHaveLength(1);
    expect(entries[0]![1]).toEqual(['type', 'usage', 'reqId', 'r1', 'costMicros', '5000']);
  });
});

describe('one-round-trip settle', () => {
  const fields = async (org: string) =>
    (await valkey.client.xrange(`bk:{o:${org}}:events`, '-', '+')).map(([, f]) => {
      const o: Record<string, string> = {};
      for (let i = 0; i < f.length; i += 2) o[f[i]!] = f[i + 1]!;
      return o;
    });

  it('commits, counts units and appends the event atomically', async () => {
    const org = newOrg();
    const r = req(org, 10n);
    const res = await engine.reserve(r);
    if (res.outcome !== 'ok') throw new Error(res.outcome);
    const c = await engine.settle(org, r.reqId, 7n, res.handle, {
      billed: true,
      timeZone: TZ,
      now: NOW,
      units: [{ sku: 'geocoding', units: 2n }],
      event: { type: 'usage', reqId: r.reqId },
    });
    expect(c).toEqual({ outcome: 'committed', reserved: 10n, actual: 7n, underpriced: false });
    const [day] = await engine.status(org, [keyScope], TZ, NOW);
    expect(day).toMatchObject({ spent: 7n, held: 0n });
    expect((await engine.monthlyUnits(org, ['geocoding'], TZ, NOW)).get('geocoding')).toBe(2n);
    expect(await fields(org)).toEqual([{ type: 'usage', reqId: r.reqId }]);
    expect(await valkey.client.zcard(`bk:{o:${org}}:resexp`)).toBe(0);
  });

  it('flags underpriced and late settles, and never double-commits', async () => {
    const org = newOrg();
    const r = req(org, 10n);
    const res = await engine.reserve(r);
    if (res.outcome !== 'ok') throw new Error(res.outcome);
    const opts = { billed: true, timeZone: TZ, now: NOW, event: { type: 'usage' } };
    expect(await engine.settle(org, r.reqId, 12n, res.handle, opts)).toMatchObject({
      underpriced: true,
    });
    expect(await engine.settle(org, r.reqId, 12n, res.handle, opts)).toEqual({
      outcome: 'already_settled',
    });
    const [day] = await engine.status(org, [keyScope], TZ, NOW);
    expect(day).toMatchObject({ spent: 12n, held: 0n });
    expect(await fields(org)).toEqual([
      { type: 'usage', underpriced: '1' },
      { type: 'usage', late: '1' },
    ]);
  });

  it('counts units for a billed request priced at zero (trusted free allowance)', async () => {
    const org = newOrg();
    const r = req(org, 0n);
    const res = await engine.reserve(r);
    if (res.outcome !== 'ok') throw new Error(res.outcome);
    await engine.settle(org, r.reqId, 0n, res.handle, {
      billed: true,
      timeZone: TZ,
      now: NOW,
      units: [{ sku: 'geocoding', units: 1n }],
    });
    expect((await engine.monthlyUnits(org, ['geocoding'], TZ, NOW)).get('geocoding')).toBe(1n);
  });

  it('refunds with actual 0 and counts no units', async () => {
    const org = newOrg();
    const r = req(org, 10n);
    const res = await engine.reserve(r);
    if (res.outcome !== 'ok') throw new Error(res.outcome);
    await engine.settle(org, r.reqId, 0n, res.handle, {
      billed: false,
      timeZone: TZ,
      now: NOW,
      units: [{ sku: 'geocoding', units: 1n }],
    });
    const [day] = await engine.status(org, [keyScope], TZ, NOW);
    expect(day).toMatchObject({ spent: 0n, held: 0n });
    expect((await engine.monthlyUnits(org, ['geocoding'], TZ, NOW)).get('geocoding')).toBe(0n);
    expect(await fields(org)).toEqual([]);
  });
});

describe('pumping guard', () => {
  it('trips the key circuit past the per-number or per-prefix hourly limit', async () => {
    const org = newOrg();
    const limits = { perNumberPerHour: 2, perPrefixPerHour: 3, cooldownSec: 600 };
    expect(await engine.pumpCheck(org, 'k1', { numberHash: 'n1', prefix: '1415' }, limits)).toEqual(
      { ok: true },
    );
    expect(await engine.pumpCheck(org, 'k1', { numberHash: 'n1', prefix: '1415' }, limits)).toEqual(
      { ok: true },
    );
    expect(await engine.pumpCheck(org, 'k1', { numberHash: 'n1', prefix: '1415' }, limits)).toEqual(
      { ok: false, retryAfterSec: 600, tripped: true },
    );
    // The circuit now blocks everything on the key, including other numbers.
    expect(
      await engine.pumpCheck(org, 'k1', { numberHash: 'n9', prefix: '4420' }, limits),
    ).toMatchObject({ ok: false, tripped: false });
    await engine.resetCircuit(org, 'k1');
    const p = (n: string) => engine.pumpCheck(org, 'k2', { numberHash: n, prefix: '1212' }, limits);
    expect((await p('a')).ok).toBe(true);
    expect((await p('b')).ok).toBe(true);
    expect((await p('c')).ok).toBe(true);
    expect((await p('d')).ok).toBe(false);
  });
});

describe('spend adjustment', () => {
  it('moves committed spend by a signed delta in the original windows', async () => {
    const org = newOrg();
    const at = new Date('2026-10-28T12:00:00Z');
    await engine.recordSpend({ orgId: org, amount: 14_500n, scopes: [keyScope], timeZone: TZ, at });
    await engine.adjustSpend({
      orgId: org,
      delta: -6_200n,
      scopes: [keyScope],
      timeZone: TZ,
      at,
      event: { type: 'adjustment' },
    });
    const [day] = await engine.status(org, [keyScope], TZ, at);
    expect(day).toMatchObject({ window: 'd:20261028', spent: 8_300n });
    await expect(
      engine.adjustSpend({ orgId: org, delta: -(2n ** 60n), scopes: [keyScope], timeZone: TZ, at }),
    ).rejects.toThrow(RangeError);
  });
});

describe('pending settlements', () => {
  it('queue, defer and are taken exactly once', async () => {
    const org = newOrg();
    const rec = {
      provider: 'twilio',
      credentialId: 'c1',
      scopes: ['org', 'key:k1'],
      at: NOW.toISOString(),
      timeZone: TZ,
      committedMicros: '14500',
      ref: { accountSid: 'AC1', sid: 'SM1' },
      keyId: 'k1',
    };
    await engine.addPending(org, 'r1', rec, new Date(NOW.getTime() + 60_000));
    expect(await engine.duePending(org, NOW)).toEqual([]);
    expect(await engine.duePending(org, new Date(NOW.getTime() + 61_000))).toEqual([
      { reqId: 'r1', record: rec },
    ]);
    await engine.deferPending(org, 'r1', new Date(NOW.getTime() + 600_000));
    expect(await engine.duePending(org, new Date(NOW.getTime() + 61_000))).toEqual([]);
    const [a, b] = await Promise.all([
      engine.takePending(org, 'r1'),
      engine.takePending(org, 'r1'),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await engine.duePending(org, new Date(NOW.getTime() + 999_000))).toEqual([]);
  });
});
