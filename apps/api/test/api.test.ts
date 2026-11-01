import { type KeyRecord, hashVirtualKey } from '@spend-brake/budget';
import { auditLog, eq, usageEvents, virtualKeys } from '@spend-brake/db';
import { credentialContext, decryptSecret, type Envelope } from '@spend-brake/shared';
import { sql } from '@spend-brake/db';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { CSV_ROW_CAP } from '../src/routes/ledger.js';
import { buildApi } from '../src/server.js';
import { type Env, type Org, bearer, newOrg, startEnv } from './harness.js';

const SECRET = 'AIzaSy-test-provider-secret-9F3k';

let env: Env;
let a: Org;
let b: Org;

beforeAll(async () => {
  env = await startEnv();
  a = await newOrg(env);
  b = await newOrg(env);
});

afterAll(async () => {
  await env.stop();
});

const call = (token: string, opts: InjectOptions) =>
  env.app.inject({ ...opts, headers: { ...bearer(token), ...(opts.headers ?? {}) } });

async function credential(org: Org, provider = 'google-maps') {
  const res = await call(org.admin, {
    method: 'POST',
    url: '/v1/providers/credentials',
    payload: { provider, name: 'main', secret: SECRET },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function key(org: Org, extra: Record<string, unknown> = {}) {
  const cred = await credential(org);
  const res = await call(org.admin, {
    method: 'POST',
    url: '/v1/keys',
    payload: { name: 'k', credentials: { 'google-maps': cred }, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; token: string }>();
}

describe('health', () => {
  it('is ready only when Valkey and Postgres answer', async () => {
    expect((await env.app.inject('/readyz')).json()).toEqual({
      ok: true,
      valkey: true,
      postgres: true,
    });
    // Nothing listens on port 1: Valkey is down, Postgres is not.
    const down = new Redis({ port: 1, lazyConnect: true, enableOfflineQueue: false });
    const app = await buildApi({ db: env.db, valkey: down, wrapper: null });
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, valkey: false, postgres: true });
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    await app.close();
    down.disconnect();
  });
});

describe('authentication', () => {
  it('rejects missing, malformed and unknown tokens', async () => {
    expect((await env.app.inject('/v1/keys')).statusCode).toBe(401);
    expect((await call('nope', { url: '/v1/keys' })).statusCode).toBe(401);
    expect((await call(`sbt_${'x'.repeat(32)}`, { url: '/v1/keys' })).json()).toMatchObject({
      error: 'unauthorized',
    });
  });

  it('stops honouring a revoked token', async () => {
    const res = await call(a.owner, {
      method: 'POST',
      url: '/v1/tokens',
      payload: { name: 'temp', role: 'viewer' },
    });
    const { id, token } = res.json<{ id: string; token: string }>();
    expect(token).toMatch(/^sbt_[0-9A-Za-z]{32}$/);
    expect((await call(token, { url: '/v1/keys' })).statusCode).toBe(200);
    await call(a.owner, { method: 'DELETE', url: `/v1/tokens/${id}` });
    expect((await call(token, { url: '/v1/keys' })).statusCode).toBe(401);
  });

  it('stops honouring an expired token', async () => {
    const res = await call(a.owner, {
      method: 'POST',
      url: '/v1/tokens',
      payload: { name: 'old', role: 'viewer', expiresAt: '2020-01-01T00:00:00Z' },
    });
    expect((await call(res.json<{ token: string }>().token, { url: '/v1/keys' })).statusCode).toBe(
      401,
    );
  });
});

describe('RBAC', () => {
  // [method, url, minimum role, body]
  const routes: [string, string, 'viewer' | 'admin' | 'owner', unknown][] = [
    ['GET', '/v1/keys', 'viewer', undefined],
    ['GET', '/v1/caps', 'viewer', undefined],
    ['GET', '/v1/status', 'viewer', undefined],
    ['GET', '/v1/spend?groupBy=day', 'viewer', undefined],
    ['GET', '/v1/events', 'viewer', undefined],
    ['GET', '/v1/org', 'viewer', undefined],
    ['GET', '/v1/providers/credentials', 'viewer', undefined],
    [
      'POST',
      '/v1/providers/credentials',
      'admin',
      { provider: 'google-maps', name: 'x', secret: 's' },
    ],
    ['PUT', '/v1/caps/org', 'admin', { day: { hard: 1000 } }],
    ['POST', '/v1/kill', 'admin', { target: 'sess:rbac' }],
    ['POST', '/v1/unkill', 'admin', { target: 'sess:rbac' }],
    ['GET', '/v1/webhooks', 'viewer', undefined],
    [
      'POST',
      '/v1/webhooks',
      'admin',
      { name: 'w', url: 'https://hooks.example.com/x', preset: 'slack' },
    ],
    ['GET', '/v1/tokens', 'owner', undefined],
    ['POST', '/v1/tokens', 'owner', { name: 't', role: 'viewer' }],
    ['PUT', '/v1/org', 'owner', { name: 'renamed' }],
  ];
  const rank = { viewer: 0, admin: 1, owner: 2 };

  it.each(routes)('%s %s needs %s', async (method, url, need, body) => {
    for (const role of ['viewer', 'admin', 'owner'] as const) {
      const res = await call(a[role], {
        method: method as 'GET',
        url,
        ...(body ? { payload: body } : {}),
      });
      if (rank[role] >= rank[need]) {
        expect(res.statusCode, `${role}: ${res.body}`).toBeLessThan(300);
      } else {
        expect(res.statusCode, role).toBe(403);
        expect(res.json()).toMatchObject({ error: 'forbidden' });
      }
    }
  });
});

describe('provider credentials', () => {
  it('stores only ciphertext, everywhere, and the proxy can decrypt it', async () => {
    const res = await call(a.admin, {
      method: 'POST',
      url: '/v1/providers/credentials',
      payload: { provider: 'google-maps', name: 'prod', secret: SECRET },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; hint: string }>();
    expect(body.hint).toBe(SECRET.slice(-4));
    expect(res.body).not.toContain(SECRET);

    const list = await call(a.viewer, { url: '/v1/providers/credentials' });
    expect(list.body).not.toContain(SECRET);

    const db = await env.db.execute(sql`select envelope::text as e from provider_credentials`);
    expect(JSON.stringify(db.rows)).not.toContain(SECRET);
    const audit = await env.db.select().from(auditLog);
    expect(
      JSON.stringify(audit, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain(SECRET);

    const stored = await env.registry.getCredential(a.id, body.id);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(
      await decryptSecret(
        env.wrapper,
        stored!.envelope as Envelope,
        credentialContext(a.id, body.id),
      ),
    ).toBe(SECRET);
    // Bound to its org and id: the same envelope does not open under another org.
    await expect(
      decryptSecret(env.wrapper, stored!.envelope as Envelope, credentialContext(b.id, body.id)),
    ).rejects.toThrow();
  });

  it('never echoes a secret in validation errors or logs', async () => {
    const res = await call(a.admin, {
      method: 'POST',
      url: '/v1/providers/credentials',
      payload: { provider: 'not a provider!', name: '', secret: SECRET },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
    expect(res.body).not.toContain(SECRET);
    const bad = await call(a.admin, {
      method: 'POST',
      url: '/v1/providers/credentials',
      headers: { 'content-type': 'application/json' },
      payload: `{"secret":"${SECRET}",`,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain(SECRET);
    expect(env.logs.text()).not.toContain(SECRET);
    expect(env.logs.text()).not.toContain(a.admin);
  });

  it('deletes from Postgres and Valkey', async () => {
    const id = await credential(a);
    const del = await call(a.admin, { method: 'DELETE', url: `/v1/providers/credentials/${id}` });
    expect(del.statusCode).toBe(200);
    expect(await env.registry.getCredential(a.id, id)).toBeNull();
  });

  it('moves keys to a replacement on delete, and never strands them', async () => {
    const org = await newOrg(env);
    const k = await key(org);
    const first = (await env.registry.getKeyByToken(k.token))!.credentials['google-maps']!;
    const refused = await call(org.admin, {
      method: 'DELETE',
      url: `/v1/providers/credentials/${first}`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'credential_in_use' });
    expect(refused.json<{ message: string }>().message).toContain('"k"');
    expect(refused.json<{ message: string }>().message).toContain(
      'Add another Google Maps Platform key',
    );
    expect(await env.registry.getCredential(org.id, first)).not.toBeNull();

    const second = await credential(org);
    const del = await call(org.admin, {
      method: 'DELETE',
      url: `/v1/providers/credentials/${first}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ reboundKeys: [k.id] });
    expect((await env.registry.getKeyByToken(k.token))!.credentials).toEqual({
      'google-maps': second,
    });
    const listed = await call(org.viewer, { url: `/v1/keys/${k.id}` });
    expect(listed.json()).toMatchObject({ config: { credentials: { 'google-maps': second } } });
  });

  it('points keys left on a deleted credential at the next one added', async () => {
    const org = await newOrg(env);
    const k = await key(org);
    const old = (await env.registry.getKeyByToken(k.token))!.credentials['google-maps']!;
    // A key stranded before deletes were guarded.
    await env.db.execute(sql`update provider_credentials set revoked_at = now() where id = ${old}`);
    await env.registry.deleteCredential(org.id, old);
    const res = await call(org.admin, {
      method: 'POST',
      url: '/v1/providers/credentials',
      payload: { provider: 'google-maps', name: 'fixed', secret: SECRET },
    });
    expect(res.statusCode).toBe(201);
    const added = res.json<{ id: string; reboundKeys: string[] }>();
    expect(added.reboundKeys).toEqual([k.id]);
    expect((await env.registry.getKeyByToken(k.token))!.credentials['google-maps']).toBe(added.id);
  });
});

describe('virtual keys', () => {
  it('shows the token once and writes the key through to Valkey by hash', async () => {
    const k = await key(a, {
      env: 'ci',
      sessionCapMicros: 5_000_000,
      skus: ['geocoding'],
      countries: ['DE', 'FR'],
    });
    expect(k.token).toMatch(/^sb_live_[0-9A-Za-z]{22}$/);
    const rec = await env.registry.getKeyByToken(k.token);
    expect(rec).toMatchObject({
      id: k.id,
      orgId: a.id,
      env: 'ci',
      sessionCapMicros: '5000000',
      skus: ['geocoding'],
      countries: ['DE', 'FR'],
      status: 'active',
    });
    const list = await call(a.viewer, { url: '/v1/keys' });
    expect(list.body).not.toContain(k.token);
    const db = await env.db.execute(sql`select * from virtual_keys`);
    expect(JSON.stringify(db.rows)).not.toContain(k.token);
    expect(JSON.stringify(db.rows)).toContain(hashVirtualKey(k.token));
  });

  it('updates and revokes through to the proxy record', async () => {
    const k = await key(a);
    const patch = await call(a.admin, {
      method: 'PATCH',
      url: `/v1/keys/${k.id}`,
      payload: { env: 'prod', failOpenMicros: '1000000', allowedIps: ['10.0.0.1'] },
    });
    expect(patch.statusCode).toBe(200);
    expect(await env.registry.getKeyByToken(k.token)).toMatchObject({
      env: 'prod',
      failOpenMicros: '1000000',
      allowedIps: ['10.0.0.1'],
    });
    const unset = await call(a.admin, {
      method: 'PATCH',
      url: `/v1/keys/${k.id}`,
      payload: { allowedIps: null },
    });
    expect(unset.statusCode).toBe(200);
    expect((await env.registry.getKeyByToken(k.token))?.allowedIps).toBeNull();

    await call(a.admin, { method: 'DELETE', url: `/v1/keys/${k.id}` });
    expect((await env.registry.getKeyByToken(k.token))?.status).toBe('revoked');
    const again = await call(a.admin, {
      method: 'PATCH',
      url: `/v1/keys/${k.id}`,
      payload: { name: 'x' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('carries the key name to the proxy record and follows renames', async () => {
    const k = await key(a, { name: 'web app' });
    expect((await env.registry.getKeyByToken(k.token))?.name).toBe('web app');
    const renamed = await call(a.admin, {
      method: 'PATCH',
      url: `/v1/keys/${k.id}`,
      payload: { name: 'store locator' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((await env.registry.getKeyByToken(k.token))?.name).toBe('store locator');

    // A key written before records had names: any later write fills it from the row.
    const [row] = await env.db.select().from(virtualKeys).where(eq(virtualKeys.id, k.id));
    const legacy = { ...(row!.config as KeyRecord) };
    delete legacy.name;
    await env.registry.putKeyByHash(row!.tokenHash, legacy);
    expect((await env.registry.getKeyByToken(k.token))?.name).toBeUndefined();
    await call(a.admin, { method: 'PATCH', url: `/v1/keys/${k.id}`, payload: { env: 'prod' } });
    expect(await env.registry.getKeyByToken(k.token)).toMatchObject({
      name: 'store locator',
      env: 'prod',
    });
    await call(a.admin, { method: 'DELETE', url: `/v1/keys/${k.id}` });
    expect(await env.registry.getKeyByToken(k.token)).toMatchObject({
      name: 'store locator',
      status: 'revoked',
    });
  });

  it('only binds credentials of the same org and provider', async () => {
    const credB = await credential(b);
    const res = await call(a.admin, {
      method: 'POST',
      url: '/v1/keys',
      payload: { name: 'k', credentials: { 'google-maps': credB } },
    });
    expect(res.statusCode).toBe(400);
    const credA = await credential(a, 'acme');
    const wrongProvider = await call(a.admin, {
      method: 'POST',
      url: '/v1/keys',
      payload: { name: 'k', credentials: { 'google-maps': credA } },
    });
    expect(wrongProvider.statusCode).toBe(400);
  });
});

describe('cross-tenant access', () => {
  it('hides every other org resource behind 404 or an empty list', async () => {
    const k = await key(a);
    const cred = await credential(a);
    for (const [method, url, payload] of [
      ['GET', `/v1/keys/${k.id}`],
      ['PATCH', `/v1/keys/${k.id}`, { name: 'stolen' }],
      ['DELETE', `/v1/keys/${k.id}`],
      ['DELETE', `/v1/providers/credentials/${cred}`],
    ] as const) {
      const res = await call(b.owner, {
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const keys = await call(b.owner, { url: '/v1/keys' });
    expect(keys.body).not.toContain(k.id);
    const creds = await call(b.owner, { url: '/v1/providers/credentials' });
    expect(creds.body).not.toContain(cred);
    // a's key is untouched.
    expect((await env.registry.getKeyByToken(k.token))?.status).toBe('active');
  });

  it('keeps caps, kills, spend and events per org', async () => {
    await call(b.admin, { method: 'PUT', url: '/v1/caps/org', payload: { day: { hard: 1 } } });
    await call(b.admin, { method: 'POST', url: '/v1/kill', payload: { target: 'org' } });
    const status = await call(a.viewer, { url: '/v1/status?scope=org' });
    expect(status.json()).toMatchObject({ killed: [] });
    expect(status.json<{ scopes: { hard: number | null }[] }>().scopes[0]!.hard).not.toBe(1);
    await call(b.admin, { method: 'POST', url: '/v1/unkill', payload: { target: 'org' } });

    await env.db.insert(usageEvents).values([
      {
        orgId: a.id,
        ts: new Date(),
        streamId: '1-0',
        type: 'usage',
        costMicros: 100n,
        keyId: 'ka',
      },
      {
        orgId: b.id,
        ts: new Date(),
        streamId: '1-0',
        type: 'usage',
        costMicros: 900n,
        keyId: 'kb',
      },
    ]);
    const spend = await call(a.viewer, { url: '/v1/spend?groupBy=key' });
    expect(spend.json<{ items: unknown[] }>().items).toEqual([
      { key: 'ka', costMicros: 100, requests: 1, succeeded: 0 },
    ]);
    const events = await call(a.viewer, { url: '/v1/events' });
    expect(events.body).not.toContain('kb');
    const audit = await call(a.viewer, { url: '/v1/events?source=audit&limit=500' });
    expect(audit.body).not.toContain(b.id);
  });
});

describe('caps, kill switch and status', () => {
  it('writes caps to Valkey (enforcement) and Postgres (config), with an audit entry', async () => {
    const k = await key(a);
    const res = await call(a.admin, {
      method: 'PUT',
      url: `/v1/caps/key:${k.id}`,
      payload: { day: { hard: 5_000_000, soft: '4000000' }, month: { hard: 50_000_000 } },
    });
    expect(res.statusCode).toBe(200);
    const caps = await env.app.inject({ url: '/v1/caps', headers: bearer(a.viewer) });
    expect(
      caps.json<{ items: { scope: string }[] }>().items.filter((c) => c.scope === `key:${k.id}`),
    ).toHaveLength(2);
    const status = await call(a.viewer, { url: `/v1/status?scope=key:${k.id}` });
    expect(status.json<{ scopes: unknown[] }>().scopes).toContainEqual(
      expect.objectContaining({
        scope: `key:${k.id}`,
        hard: 5_000_000,
        soft: 4_000_000,
        remaining: 5_000_000,
      }),
    );
    const del = await call(a.admin, { method: 'DELETE', url: `/v1/caps/key:${k.id}?kind=m` });
    expect(del.json()).toEqual({ scope: `key:${k.id}`, deleted: ['m'] });
    const audit = await call(a.viewer, { url: '/v1/events?source=audit&type=cap.set' });
    expect(audit.json<{ items: { target: string }[] }>().items.map((i) => i.target)).toContain(
      `key:${k.id}:d`,
    );
  });

  it('shows keys paused by the loop breaker and lets an admin resume them', async () => {
    const org = await newOrg(env);
    const k = await key(org);
    await env.valkey.set(`bk:{o:${org.id}}:circuit:key:${k.id}`, '1', 'EX', 600);
    const status = await call(org.viewer, { url: '/v1/status' });
    const paused = status.json<{ paused: { keyId: string; retryAfterSec: number }[] }>().paused;
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ keyId: k.id, reason: 'loop' });
    expect(paused[0]!.retryAfterSec).toBeGreaterThan(590);
    // The SMS pumping guard marks its circuit, so the dashboard can say why.
    await env.valkey.set(`bk:{o:${org.id}}:circuit:key:${k.id}`, 'pump', 'EX', 600);
    expect(
      (await call(org.viewer, { url: '/v1/status' })).json<{ paused: { reason: string }[] }>()
        .paused[0]!.reason,
    ).toBe('pumping');

    const url = `/v1/keys/${k.id}/resume`;
    expect((await call(org.viewer, { method: 'POST', url })).statusCode).toBe(403);
    expect((await call(b.admin, { method: 'POST', url })).statusCode).toBe(404);
    const resumed = await call(org.admin, { method: 'POST', url });
    expect(resumed.json()).toEqual({ keyId: k.id, resumed: true });
    expect(
      (await call(org.viewer, { url: '/v1/status' })).json<{ paused: unknown[] }>().paused,
    ).toEqual([]);
    const audit = await call(org.viewer, { url: '/v1/events?source=audit&type=circuit.reset' });
    expect(audit.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('rejects malformed scopes and amounts', async () => {
    for (const [url, payload] of [
      ['/v1/caps/everything', { day: { hard: 1 } }],
      ['/v1/caps/org', { day: { hard: -1 } }],
      ['/v1/caps/org', { day: { hard: 2 ** 60 } }],
      ['/v1/caps/org', {}],
      // An alert above the hard cap could never fire.
      ['/v1/caps/org', { day: { hard: 1000, soft: 2000 } }],
    ] as const) {
      expect((await call(a.admin, { method: 'PUT', url, payload })).statusCode, url).toBe(400);
    }
    // A typo in a key id would cap nothing.
    const missing = await call(a.admin, {
      method: 'PUT',
      url: '/v1/caps/key:key_doesnotexist',
      payload: { day: { hard: 1000 } },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not_found', message: 'Key not found.' });
  });

  it('kills and unkills immediately and records who and why', async () => {
    const res = await call(a.admin, {
      method: 'POST',
      url: '/v1/kill',
      payload: { target: 'prov:google-maps', reason: 'runaway agent' },
    });
    expect(res.json()).toEqual({ killed: ['prov:google-maps'] });
    expect(await env.valkey.sismember(`bk:{o:${a.id}}:kill`, 'prov:google-maps')).toBe(1);
    await call(a.admin, {
      method: 'POST',
      url: '/v1/unkill',
      payload: { target: 'prov:google-maps' },
    });
    expect(await env.valkey.sismember(`bk:{o:${a.id}}:kill`, 'prov:google-maps')).toBe(0);
    const audit = await call(a.viewer, { url: '/v1/events?source=audit&type=kill' });
    const entry = audit.json<{ items: { actor: string }[] }>().items[0]!;
    expect(entry).toMatchObject({
      action: 'kill',
      target: 'prov:google-maps',
      reason: 'runaway agent',
    });
    expect(entry.actor).toMatch(/^token:tok_/);
  });
});

describe('ledger queries', () => {
  it('groups spend by key, SKU and day in the org time zone', async () => {
    const org = await newOrg(env);
    await call(org.owner, {
      method: 'PUT',
      url: '/v1/org',
      payload: { timeZone: 'America/Los_Angeles' },
    });
    const row = (ts: string, streamId: string, keyId: string, sku: string, cost: bigint) => ({
      orgId: org.id,
      ts: new Date(ts),
      streamId,
      type: 'usage',
      keyId,
      sku,
      costMicros: cost,
      status: 200,
    });
    await env.db.insert(usageEvents).values([
      row('2026-10-29T06:00:00Z', '1-0', 'k1', 'geocoding', 5000n), // Oct 28 in LA
      // Google answered 200 but refused the call in its JSON status.
      {
        ...row('2026-10-29T18:00:00Z', '2-0', 'k1', 'geocoding', 5000n),
        data: { providerError: 'OVER_QUERY_LIMIT' },
      },
      row('2026-10-29T19:00:00Z', '3-0', 'k2', 'places.text_search.pro', 32000n),
      { ...row('2026-10-29T19:00:01Z', '4-0', 'k2', 'x', 1n), type: 'blocked' },
      // A settlement adjustment moves the cost but is not a request.
      {
        ...row('2026-10-29T19:30:00Z', '5-0', 'k2', 'places.text_search.pro', -2000n),
        type: 'adjustment',
      },
    ]);
    const res = await call(org.viewer, { url: '/v1/spend?groupBy=key,sku,day' });
    expect(res.json()).toEqual({
      items: [
        {
          key: 'k1',
          sku: 'geocoding',
          day: '2026-10-28',
          costMicros: 5000,
          requests: 1,
          succeeded: 1,
        },
        {
          key: 'k1',
          sku: 'geocoding',
          day: '2026-10-29',
          costMicros: 5000,
          requests: 1,
          succeeded: 0,
        },
        {
          key: 'k2',
          sku: 'places.text_search.pro',
          day: '2026-10-29',
          costMicros: 30000,
          requests: 1,
          succeeded: 1,
        },
      ],
    });
    const ranged = await call(org.viewer, {
      url: '/v1/spend?groupBy=day&from=2026-10-29T12:00:00Z&to=2026-10-30T00:00:00Z',
    });
    expect(ranged.json()).toEqual({
      items: [{ day: '2026-10-29', costMicros: 35000, requests: 2, succeeded: 1 }],
    });
    expect((await call(org.viewer, { url: '/v1/spend?groupBy=nope' })).statusCode).toBe(400);

    const page1 = await call(org.viewer, { url: '/v1/events?limit=2' });
    const p1 = page1.json<{ items: { streamId: string }[]; nextCursor: string }>();
    expect(p1.items.map((i) => i.streamId)).toEqual(['5-0', '4-0']);
    const page2 = await call(org.viewer, { url: `/v1/events?limit=2&cursor=${p1.nextCursor}` });
    const p2 = page2.json<{ items: { streamId: string; outcome: string }[] }>();
    expect(p2.items.map((i) => [i.streamId, i.outcome])).toEqual([
      ['3-0', 'ok'],
      ['2-0', 'provider_error'],
    ]);
    const blocked = await call(org.viewer, { url: '/v1/events?type=blocked' });
    expect(blocked.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect((await call(org.viewer, { url: '/v1/events?cursor=garbage' })).statusCode).toBe(400);
  });
  it('exports events as CSV with key names, filters and formula-safe cells', async () => {
    const org = await newOrg(env);
    const k = await key(org, { name: '=HYPERLINK("http://x")' });
    const row = (ts: string, streamId: string, extra: object = {}) => ({
      orgId: org.id,
      ts: new Date(ts),
      streamId,
      type: 'usage',
      keyId: k.id,
      provider: 'google-maps',
      sku: 'geocoding',
      costMicros: 5000n,
      status: 200,
      ...extra,
    });
    await env.db
      .insert(usageEvents)
      .values([
        row('2026-10-29T06:00:00Z', '1-0', { data: { note: 'a, "quoted"\nline' } }),
        row('2026-10-29T07:00:00Z', '2-0', { type: 'adjustment', costMicros: -2500n }),
        row('2026-10-30T07:00:00Z', '3-0', { keyId: 'key_gone', costMicros: 1234567n }),
      ]);

    expect((await env.app.inject({ url: '/v1/events.csv' })).statusCode).toBe(401);
    const res = await call(org.viewer, { url: '/v1/events.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="spend-brake-requests-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['x-brake-truncated']).toBe('false');
    expect(res.body.endsWith('\r\n')).toBe(true);
    // A UTF-8 byte order mark first, so Excel reads non-ASCII names correctly.
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.body.startsWith('\uFEFFtime_utc,')).toBe(true);
    const [header, ...rows] = parseCsv(res.body);
    expect(header).toEqual([
      'time_utc',
      'type',
      'key_id',
      'key_name',
      'provider',
      'route',
      'sku',
      'outcome',
      'status',
      'cost_usd',
      'cost_micros',
      'worst_micros',
      'latency_ms',
      'session',
      'env',
      'agent_id',
      'request_id',
      'data',
    ]);
    const col = (r: string[], name: string) => r[header!.indexOf(name)];
    expect(rows.map((r) => col(r, 'time_utc'))).toEqual([
      '2026-10-30T07:00:00.000Z',
      '2026-10-29T07:00:00.000Z',
      '2026-10-29T06:00:00.000Z',
    ]);
    // A deleted key has no name; a name that looks like a formula is defused.
    expect(rows.map((r) => col(r, 'key_name'))).toEqual([
      '',
      `'=HYPERLINK("http://x")`,
      `'=HYPERLINK("http://x")`,
    ]);
    expect(rows.map((r) => col(r, 'cost_usd'))).toEqual(['1.234567', '-0.0025', '0.005']);
    // Numbers stay numbers: a negative amount is not prefixed.
    expect(col(rows[1]!, 'cost_micros')).toBe('-2500');
    expect(col(rows[2]!, 'outcome')).toBe('ok');
    expect(JSON.parse(col(rows[2]!, 'data')!)).toEqual({ note: 'a, "quoted"\nline' });

    const ranged = await call(org.viewer, {
      url: '/v1/events.csv?from=2026-10-29T06:30:00Z&to=2026-10-30T00:00:00Z',
    });
    expect(
      parseCsv(ranged.body)
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(['2026-10-29T07:00:00.000Z']);
    // A ranged file is named by its days; a `to` at midnight is exclusive, so the day before.
    expect(ranged.headers['content-disposition']).toBe(
      'attachment; filename="spend-brake-requests-2026-10-29_2026-10-29.csv"',
    );
    const named = async (query: string) =>
      (await call(org.viewer, { url: `/v1/events.csv?${query}` })).headers['content-disposition'];
    // Local days from the dashboard: midnight to the next midnight, with the offset.
    expect(
      await named('source=audit&from=2026-10-01T00:00:00%2B03:00&to=2026-11-01T00:00:00%2B02:00'),
    ).toBe('attachment; filename="spend-brake-audit-2026-10-01_2026-10-31.csv"');
    expect(await named('from=2026-10-01&to=2026-10-31')).toMatch(/-2026-10-01_2026-10-31\.csv"$/);
    expect(await named('to=2026-10-31T18:00:00Z')).toMatch(/-start_2026-10-31\.csv"$/);
    expect(await named('from=2026-10-01')).toMatch(/-2026-10-01_now\.csv"$/);
    const times = async (query: string) =>
      parseCsv((await call(org.viewer, { url: `/v1/events.csv?${query}` })).body)
        .slice(1)
        .map((r) => r[0]);
    // Offsets and plain dates: a plain `to` date takes in that whole UTC day.
    expect(await times('from=2026-10-29T08:30:00%2B02:00&to=2026-10-29')).toEqual([
      '2026-10-29T07:00:00.000Z',
    ]);
    expect(await times('to=2026-10-29')).toHaveLength(2);
    expect(await times('from=2026-10-30')).toEqual(['2026-10-30T07:00:00.000Z']);
    expect(await times('source=audit&to=2000-01-01')).toEqual([]);
    const typed = await call(org.viewer, { url: '/v1/events.csv?type=adjustment' });
    expect(parseCsv(typed.body)).toHaveLength(2);
    // The JSON list takes the same time bounds.
    const list = await call(org.viewer, { url: '/v1/events?from=2026-10-30T00:00:00Z' });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    const audit = await call(org.viewer, { url: '/v1/events.csv?source=audit' });
    expect(audit.headers['content-disposition']).toMatch(/spend-brake-audit-/);
    const [auditHeader, ...auditRows] = parseCsv(audit.body);
    expect(auditHeader).toEqual(['time_utc', 'actor', 'action', 'target', 'reason', 'data']);
    expect(auditRows.some((r) => r[2] === 'key.create' && r[3] === k.id)).toBe(true);

    // Another org sees only its own rows.
    const other = await call(b.viewer, { url: '/v1/events.csv' });
    expect(other.body).not.toContain(k.id);
    const bad = await call(org.viewer, { url: '/v1/events.csv?from=yesterday' });
    expect(bad.statusCode).toBe(400);
    // A bad date names the parameter and the formats it takes.
    const badDay = await call(org.viewer, { url: '/v1/events.csv?to=2026-02-30' });
    expect(badDay.statusCode).toBe(400);
    expect(badDay.json<{ issues: { path: string; message: string }[] }>().issues[0]).toEqual({
      in: 'query',
      path: 'to',
      message:
        'to must be an ISO 8601 time with Z or an offset (2026-10-31T00:00:00+02:00) or a date (2026-10-31).',
    });
    // A time without Z or an offset is ambiguous.
    const local = await call(org.viewer, { url: '/v1/events.csv?from=2026-10-29T06:30:00' });
    expect(local.statusCode).toBe(400);
  });

  it('caps a CSV export and says so', async () => {
    const org = await newOrg(env);
    await env.db.execute(sql`
      insert into usage_events (org_id, ts, stream_id, type, key_id, cost_micros, status)
      select ${org.id}, timestamptz '2026-10-01T00:00:00Z' + make_interval(secs => g),
        g || '-0', 'usage', 'k1', 1, 200
      from generate_series(1, ${CSV_ROW_CAP + 5}) g`);
    const res = await call(org.viewer, { url: '/v1/events.csv' });
    expect(res.headers['x-brake-truncated']).toBe('true');
    const lines = res.body.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(CSV_ROW_CAP + 1);
    expect(lines[0]!.startsWith('\uFEFFtime_utc,')).toBe(true);
    // The newest rows, in order across batches.
    expect(lines[1]).toMatch(/^2026-10-02T03:46:45\.000Z,/);
    expect(new Set(lines).size).toBe(lines.length);
    const ranged = await call(org.viewer, { url: '/v1/events.csv?to=2026-10-01T00:00:06Z' });
    expect(ranged.headers['x-brake-truncated']).toBe('false');
    expect(ranged.body.split('\r\n').filter(Boolean)).toHaveLength(6);
  }, 60_000);
});

/** A strict RFC 4180 reader, enough to check the export round-trips. */
function parseCsv(withBom: string): string[][] {
  expect(withBom.startsWith('\uFEFF')).toBe(true);
  const text = withBom.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

describe('org settings', () => {
  it('mirrors provider policy and time zone to the proxy record', async () => {
    const org = await newOrg(env);
    const res = await call(org.owner, {
      method: 'PUT',
      url: '/v1/org',
      payload: {
        timeZone: 'Europe/Sofia',
        providers: { 'google-maps': { trustFreeTier: true } },
        loop: { identical: 5, windowSec: 30, perMinute: 100, cooldownSec: 60 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(await env.registry.getOrg(org.id)).toMatchObject({
      timeZone: 'Europe/Sofia',
      providers: { 'google-maps': { trustFreeTier: true, unpricedPolicy: 'deny' } },
      loop: { identical: 5 },
    });
    const bad = await call(org.owner, {
      method: 'PUT',
      url: '/v1/org',
      payload: { timeZone: 'Mars/Base' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('OpenAPI', () => {
  it('matches the committed openapi.json (run pnpm --filter @spend-brake/api openapi)', async () => {
    const { readFileSync } = await import('node:fs');
    const committed = JSON.parse(
      readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect((await env.app.inject('/v1/openapi.json')).json()).toEqual(committed);
  });

  it('publishes a 3.1 spec covering every admin endpoint', async () => {
    const res = await env.app.inject('/v1/openapi.json');
    const spec = res.json<{ openapi: string; paths: Record<string, Record<string, unknown>> }>();
    expect(spec.openapi).toBe('3.1.0');
    const ops = Object.entries(spec.paths).flatMap(([p, m]) =>
      Object.keys(m).map((x) => `${x.toUpperCase()} ${p}`),
    );
    for (const op of [
      'POST /v1/providers/credentials',
      'POST /v1/keys',
      'GET /v1/keys',
      'PATCH /v1/keys/{id}',
      'DELETE /v1/keys/{id}',
      'PUT /v1/caps/{scope}',
      'POST /v1/kill',
      'POST /v1/unkill',
      'GET /v1/spend',
      'GET /v1/events',
      'GET /v1/status',
      'POST /v1/webhooks',
      'GET /v1/webhooks/{id}/deliveries',
      'POST /v1/actions/execute',
    ]) {
      expect(ops).toContain(op);
    }
  });
});
