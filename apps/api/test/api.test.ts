import { hashVirtualKey } from '@spend-brake/budget';
import { auditLog, usageEvents } from '@spend-brake/db';
import { credentialContext, decryptSecret, type Envelope } from '@spend-brake/shared';
import { sql } from '@spend-brake/db';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      { key: 'ka', costMicros: 100, requests: 1 },
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

  it('rejects malformed scopes and amounts', async () => {
    for (const [url, payload] of [
      ['/v1/caps/everything', { day: { hard: 1 } }],
      ['/v1/caps/org', { day: { hard: -1 } }],
      ['/v1/caps/org', { day: { hard: 2 ** 60 } }],
      ['/v1/caps/org', {}],
    ] as const) {
      expect((await call(a.admin, { method: 'PUT', url, payload })).statusCode, url).toBe(400);
    }
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
    });
    await env.db.insert(usageEvents).values([
      row('2026-10-29T06:00:00Z', '1-0', 'k1', 'geocoding', 5000n), // Oct 28 in LA
      row('2026-10-29T18:00:00Z', '2-0', 'k1', 'geocoding', 5000n),
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
        { key: 'k1', sku: 'geocoding', day: '2026-10-28', costMicros: 5000, requests: 1 },
        { key: 'k1', sku: 'geocoding', day: '2026-10-29', costMicros: 5000, requests: 1 },
        {
          key: 'k2',
          sku: 'places.text_search.pro',
          day: '2026-10-29',
          costMicros: 30000,
          requests: 1,
        },
      ],
    });
    const ranged = await call(org.viewer, {
      url: '/v1/spend?groupBy=day&from=2026-10-29T12:00:00Z&to=2026-10-30T00:00:00Z',
    });
    expect(ranged.json()).toEqual({
      items: [{ day: '2026-10-29', costMicros: 35000, requests: 2 }],
    });
    expect((await call(org.viewer, { url: '/v1/spend?groupBy=nope' })).statusCode).toBe(400);

    const page1 = await call(org.viewer, { url: '/v1/events?limit=2' });
    const p1 = page1.json<{ items: { streamId: string }[]; nextCursor: string }>();
    expect(p1.items.map((i) => i.streamId)).toEqual(['5-0', '4-0']);
    const page2 = await call(org.viewer, { url: `/v1/events?limit=2&cursor=${p1.nextCursor}` });
    expect(page2.json<{ items: { streamId: string }[] }>().items.map((i) => i.streamId)).toEqual([
      '3-0',
      '2-0',
    ]);
    const blocked = await call(org.viewer, { url: '/v1/events?type=blocked' });
    expect(blocked.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect((await call(org.viewer, { url: '/v1/events?cursor=garbage' })).statusCode).toBe(400);
  });
});

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
