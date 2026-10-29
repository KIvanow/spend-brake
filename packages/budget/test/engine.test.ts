import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetEngine, type ReserveRequest } from '../src/engine.js';
import type { Scope } from '../src/keys.js';
import { type TestValkey, newOrg, newReq, startValkey } from './valkey.js';

const USD = 1_000_000n;
const TZ = 'UTC';
const NOW = new Date('2026-10-29T12:00:00Z');
const keyScope: Scope = { kind: 'key', id: 'k1' };
const skuScope: Scope = { kind: 'sku', provider: 'google-maps', sku: 'geocoding' };

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
    scopes: [{ kind: 'org' }, keyScope, skuScope],
    killTargets: [
      { kind: 'org' },
      { kind: 'key', id: 'k1' },
      { kind: 'prov', name: 'google-maps' },
    ],
    timeZone: TZ,
    now: NOW,
    ...extra,
  };
}

async function used(orgId: string, scope: Scope, window = 'd:20261029') {
  const s = (await engine.status(orgId, [scope], TZ, NOW)).find((x) => x.window === window)!;
  return s;
}

describe('reserve', () => {
  it('reserves against every scope and window when under all caps', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 10n * USD, soft: null });
    const r = await engine.reserve(req(org, 2n * USD));
    expect(r.outcome).toBe('ok');
    for (const scope of [{ kind: 'org' } as Scope, keyScope, skuScope]) {
      for (const w of ['d:20261029', 'm:202610']) {
        const s = await used(org, scope, w);
        expect(s.held).toBe(2n * USD);
        expect(s.spent).toBe(0n);
      }
    }
  });

  it('allows a request that exactly fills the cap and denies one micro more', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 3n * USD, soft: null });
    expect((await engine.reserve(req(org, 3n * USD))).outcome).toBe('ok');
    const r = await engine.reserve(req(org, 1n));
    expect(r).toMatchObject({
      outcome: 'budget_exceeded',
      scope: 'key:k1',
      window: 'd:20261029',
      cap: 3n * USD,
      spent: 3n * USD,
    });
  });

  it('changes nothing when any scope denies', async () => {
    const org = newOrg();
    await engine.setCap(org, skuScope, 'm', { hard: 1n * USD, soft: null });
    const r = await engine.reserve(req(org, 2n * USD));
    expect(r).toMatchObject({
      outcome: 'budget_exceeded',
      scope: skuScope.kind + ':google-maps:geocoding',
      window: 'm:202610',
    });
    for (const scope of [{ kind: 'org' } as Scope, keyScope, skuScope]) {
      expect((await used(org, scope)).held).toBe(0n);
    }
    expect(await valkey.client.exists(`bk:{o:${org}}:res:x`)).toBe(0);
    expect(await valkey.client.zcard(`bk:{o:${org}}:resexp`)).toBe(0);
  });

  it('checks day and month caps together', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 100n * USD, soft: null });
    await engine.setCap(org, keyScope, 'm', { hard: 5n * USD, soft: null });
    expect((await engine.reserve(req(org, 4n * USD))).outcome).toBe('ok');
    const r = await engine.reserve(req(org, 2n * USD));
    expect(r).toMatchObject({ outcome: 'budget_exceeded', window: 'm:202610' });
    if (r.outcome === 'budget_exceeded') {
      expect(r.resetsAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    }
  });

  it('starts a fresh day window at midnight in the org time zone', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 1n * USD, soft: null });
    expect((await engine.reserve(req(org, 1n * USD))).outcome).toBe('ok');
    expect((await engine.reserve(req(org, 1n))).outcome).toBe('budget_exceeded');
    const tomorrow = new Date('2026-10-30T00:00:01Z');
    expect((await engine.reserve(req(org, 1n * USD, { now: tomorrow }))).outcome).toBe('ok');
  });

  it('a hard cap of zero blocks every paid request', async () => {
    const org = newOrg();
    await engine.setCap(org, { kind: 'org' }, 'd', { hard: 0n, soft: null });
    expect((await engine.reserve(req(org, 1n))).outcome).toBe('budget_exceeded');
  });

  it('applies cap changes on the next request', async () => {
    const org = newOrg();
    const v1 = await engine.setCap(org, keyScope, 'd', { hard: 1n * USD, soft: null });
    expect((await engine.reserve(req(org, 2n * USD))).outcome).toBe('budget_exceeded');
    const v2 = await engine.setCap(org, keyScope, 'd', { hard: 5n * USD, soft: 4n * USD });
    expect(v2).toBe(v1 + 1);
    expect(await engine.getCap(org, keyScope, 'd')).toEqual({
      hard: 5n * USD,
      soft: 4n * USD,
      version: v2,
    });
    expect((await engine.reserve(req(org, 2n * USD))).outcome).toBe('ok');
    await engine.setCap(org, keyScope, 'd', { hard: null, soft: null });
    expect((await engine.getCap(org, keyScope, 'd'))?.hard).toBeNull();
    await engine.deleteCap(org, keyScope, 'd');
    expect(await engine.getCap(org, keyScope, 'd')).toBeNull();
  });

  it('rejects a reused reqId', async () => {
    const org = newOrg();
    const r = req(org, 1n);
    await engine.reserve(r);
    await expect(engine.reserve(r)).rejects.toThrow(/already exists/);
  });

  it('rejects amounts that Lua cannot hold exactly', async () => {
    await expect(engine.reserve(req(newOrg(), 2n ** 53n))).rejects.toThrow(RangeError);
    await expect(engine.reserve(req(newOrg(), -1n))).rejects.toThrow(RangeError);
  });
});

describe('threshold crossings', () => {
  it('reports 50/80/100% and soft once per scope and window', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 10n * USD, soft: 3n * USD });
    const marks = async (amount: bigint) => {
      const r = await engine.reserve(req(org, amount));
      if (r.outcome !== 'ok') throw new Error(r.outcome);
      return r.crossings.map((c) => `${c.scope}/${c.window}/${c.mark}`);
    };
    expect(await marks(2n * USD)).toEqual([]);
    expect(await marks(3n * USD)).toEqual(['key:k1/d:20261029/50', 'key:k1/d:20261029/soft']);
    expect(await marks(3n * USD)).toEqual(['key:k1/d:20261029/80']);
    expect(await marks(2n * USD)).toEqual(['key:k1/d:20261029/100']);
  });

  it('does not repeat a mark after a refund drops spend below it', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 10n * USD, soft: null });
    const first = req(org, 6n * USD);
    const r1 = await engine.reserve(first);
    expect(r1.outcome === 'ok' && r1.crossings.map((c) => c.mark)).toEqual(['50']);
    await engine.refund(org, first.reqId);
    const r2 = await engine.reserve(req(org, 6n * USD));
    expect(r2.outcome === 'ok' && r2.crossings).toEqual([]);
  });
});

describe('kill switch', () => {
  it.each([
    [{ kind: 'org' as const }, 'org'],
    [{ kind: 'key' as const, id: 'k1' }, 'key:k1'],
    [{ kind: 'prov' as const, name: 'google-maps' }, 'prov:google-maps'],
    [{ kind: 'sess' as const, id: 's1' }, 'sess:s1'],
  ])('blocks requests for a killed %o', async (target, label) => {
    const org = newOrg();
    const base = req(org, 1n);
    const r = () =>
      engine.reserve({
        ...base,
        reqId: newReq(),
        killTargets: [...base.killTargets, { kind: 'sess', id: 's1' }],
      });
    await engine.kill(org, target);
    expect(await engine.killed(org)).toEqual([label]);
    expect(await r()).toEqual({ outcome: 'killed', target: label });
    expect((await used(org, { kind: 'org' })).held).toBe(0n);
    await engine.unkill(org, target);
    expect((await r()).outcome).toBe('ok');
  });

  it('does not block targets the request does not carry', async () => {
    const org = newOrg();
    await engine.kill(org, { kind: 'key', id: 'other' });
    expect((await engine.reserve(req(org, 1n))).outcome).toBe('ok');
  });
});

describe('commit and refund', () => {
  it('moves the reservation to spent at the actual cost', async () => {
    const org = newOrg();
    const r = req(org, 5n * USD);
    await engine.reserve(r);
    expect(await engine.commit(org, r.reqId, 3n * USD)).toEqual({
      outcome: 'committed',
      reserved: 5n * USD,
      actual: 3n * USD,
      underpriced: false,
    });
    const s = await used(org, keyScope);
    expect(s.held).toBe(0n);
    expect(s.spent).toBe(3n * USD);
  });

  it('is idempotent', async () => {
    const org = newOrg();
    const r = req(org, 5n * USD);
    await engine.reserve(r);
    await engine.commit(org, r.reqId, 2n * USD);
    expect(await engine.commit(org, r.reqId, 2n * USD)).toEqual({ outcome: 'already_settled' });
    expect(await engine.refund(org, r.reqId)).toEqual({ outcome: 'already_settled' });
    const s = await used(org, keyScope);
    expect(s.spent).toBe(2n * USD);
    expect(s.held).toBe(0n);
  });

  it('settles once under concurrent commits', async () => {
    const org = newOrg();
    const r = req(org, 5n * USD);
    await engine.reserve(r);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => engine.commit(org, r.reqId, 4n * USD)),
    );
    expect(results.filter((x) => x.outcome === 'committed')).toHaveLength(1);
    expect((await used(org, keyScope)).spent).toBe(4n * USD);
  });

  it('refund releases the reservation', async () => {
    const org = newOrg();
    const r = req(org, 5n * USD);
    await engine.reserve(r);
    await engine.refund(org, r.reqId);
    const s = await used(org, keyScope);
    expect(s.held).toBe(0n);
    expect(s.spent).toBe(0n);
    expect(await valkey.client.zcard(`bk:{o:${org}}:resexp`)).toBe(0);
  });

  it('commits an underpriced actual anyway and flags it', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 5n * USD, soft: null });
    const r = req(org, 5n * USD);
    await engine.reserve(r);
    const c = await engine.commit(org, r.reqId, 7n * USD);
    expect(c).toMatchObject({ outcome: 'committed', underpriced: true });
    const s = await used(org, keyScope);
    expect(s.spent).toBe(7n * USD);
    expect(s.remaining).toBe(0n);
  });
});

describe('sweeper', () => {
  it('commits expired reservations at worst case and leaves live ones alone', async () => {
    const org = newOrg();
    const stale = req(org, 4n * USD, { now: new Date(NOW.getTime() - 121_000) });
    const live = req(org, 1n * USD);
    await engine.reserve(stale);
    await engine.reserve(live);
    expect(await engine.sweep(org, NOW)).toEqual({ committed: 1, alreadySettled: 0 });
    const s = await used(org, keyScope);
    expect(s.spent).toBe(4n * USD);
    expect(s.held).toBe(1n * USD);
    // A late commit for the swept request is a no-op.
    expect(await engine.commit(org, stale.reqId, 1n)).toEqual({ outcome: 'already_settled' });
  });

  it('keeps the reservation record past its expiry so the sweeper can still settle it', async () => {
    const org = newOrg();
    const r = req(org, 1n);
    await engine.reserve(r);
    const ttl = await valkey.client.ttl(`bk:{o:${org}}:res:${r.reqId}`);
    expect(ttl).toBeGreaterThan(120);
  });
});

describe('isolation', () => {
  it('keeps orgs apart', async () => {
    const a = newOrg();
    const b = newOrg();
    await engine.setCap(a, keyScope, 'd', { hard: 1n * USD, soft: null });
    await engine.kill(a, { kind: 'prov', name: 'google-maps' });
    const r = req(b, 50n * USD);
    expect((await engine.reserve(r)).outcome).toBe('ok');
    await engine.commit(b, r.reqId, 50n * USD);
    expect((await used(a, keyScope)).spent).toBe(0n);
    // A reqId from org b cannot be settled through org a.
    expect(await engine.refund(a, r.reqId)).toEqual({ outcome: 'already_settled' });
    expect((await used(b, keyScope)).spent).toBe(50n * USD);
  });
});

describe('status', () => {
  it('reports spent, held, caps and remaining per window', async () => {
    const org = newOrg();
    await engine.setCap(org, keyScope, 'd', { hard: 10n * USD, soft: 8n * USD });
    const a = req(org, 2n * USD);
    await engine.reserve(a);
    await engine.commit(org, a.reqId, 1n * USD);
    await engine.reserve(req(org, 3n * USD));
    expect(await engine.status(org, [keyScope], TZ, NOW)).toEqual([
      {
        scope: 'key:k1',
        window: 'd:20261029',
        spent: 1n * USD,
        held: 3n * USD,
        hard: 10n * USD,
        soft: 8n * USD,
        remaining: 6n * USD,
      },
      {
        scope: 'key:k1',
        window: 'm:202610',
        spent: 1n * USD,
        held: 3n * USD,
        hard: null,
        soft: null,
        remaining: null,
      },
    ]);
  });
});
