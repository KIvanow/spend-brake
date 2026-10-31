import { auditLog, and, eq, orgEntitlements } from '@spend-brake/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownHosts, loadEnv } from '../src/config.js';
import { originProblem } from '../src/routes/custom-apis.js';
import { buildApi } from '../src/server.js';
import { type Env, bearer, newOrg, startEnv } from './harness.js';

let env: Env;

beforeAll(async () => {
  env = await startEnv();
});

afterAll(async () => {
  await env.stop();
});

const call = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  url: string,
  payload?: object,
  app: FastifyInstance = env.app,
) => app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });

const acme = (extra: Record<string, unknown> = {}) => ({
  id: 'acme',
  name: 'Acme Search',
  origin: 'https://api.acme.example',
  auth: { type: 'header', name: 'X-Api-Key' },
  routes: [
    {
      method: 'POST',
      path: '/v1/search',
      sku: 'search',
      pricing: { model: 'perRequest', usd: '0.005' },
    },
    {
      path: '/v1/run/**',
      sku: 'run',
      pricing: {
        model: 'reported',
        header: 'X-Credits',
        usdPerUnit: '0.001',
        maxPerRequest: '0.50',
      },
    },
  ],
  ...extra,
});

const issues = (res: { json: <T>() => T }) =>
  res
    .json<{ issues?: { path: string; message: string }[] }>()
    .issues?.map((i) => `${i.path}: ${i.message}`)
    .join('; ') ?? '';

describe('custom APIs', () => {
  it('are created, listed, replaced and deleted by admins, read by viewers', async () => {
    const org = await newOrg(env);
    const created = await call(org.admin, 'POST', '/v1/custom-apis', acme());
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      id: 'acme',
      name: 'Acme Search',
      origin: 'https://api.acme.example',
      auth: { type: 'header', name: 'X-Api-Key', valuePrefix: '' },
      billed: '2xx',
      timeoutBilled: true,
      proxyPath: '/custom/acme',
      routes: [{ method: 'POST' }, { method: '*' }],
    });
    // Written through for the proxy.
    expect(await env.registry.getCustomApis(org.id)).toMatchObject([
      { id: 'acme', origin: 'https://api.acme.example' },
    ]);

    const list = await call(org.viewer, 'GET', '/v1/custom-apis');
    expect(list.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(['acme']);
    expect((await call(org.viewer, 'GET', '/v1/custom-apis/acme')).statusCode).toBe(200);
    expect((await call(org.viewer, 'POST', '/v1/custom-apis', acme({ id: 'x' }))).statusCode).toBe(
      403,
    );
    expect((await call(org.viewer, 'DELETE', '/v1/custom-apis/acme')).statusCode).toBe(403);

    const rest: Record<string, unknown> = acme();
    delete rest.id;
    const replaced = await call(org.admin, 'PUT', '/v1/custom-apis/acme', {
      ...rest,
      name: 'Acme v2',
      origin: 'https://v2.acme.example',
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json()).toMatchObject({ id: 'acme', name: 'Acme v2' });
    expect((await env.registry.getCustomApis(org.id))[0]).toMatchObject({
      origin: 'https://v2.acme.example',
    });
    expect((await call(org.admin, 'PUT', '/v1/custom-apis/nope', rest)).statusCode).toBe(404);

    const dup = await call(org.admin, 'POST', '/v1/custom-apis', acme());
    expect(dup.statusCode).toBe(409);

    const del = await call(org.admin, 'DELETE', '/v1/custom-apis/acme');
    expect(del.statusCode, del.body).toBe(200);
    expect(await env.registry.getCustomApis(org.id)).toEqual([]);
    expect((await call(org.viewer, 'GET', '/v1/custom-apis/acme')).statusCode).toBe(404);

    const actions = (await env.db.select().from(auditLog).where(eq(auditLog.orgId, org.id))).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['custom_api.create', 'custom_api.update', 'custom_api.delete']),
    );
  });

  it('are per org: two orgs can use the same id', async () => {
    const a = await newOrg(env);
    const b = await newOrg(env);
    expect((await call(a.admin, 'POST', '/v1/custom-apis', acme())).statusCode).toBe(201);
    const other = await call(
      b.admin,
      'POST',
      '/v1/custom-apis',
      acme({ origin: 'https://other.example' }),
    );
    expect(other.statusCode).toBe(201);
    expect((await env.registry.getCustomApis(a.id))[0]).toMatchObject({
      origin: 'https://api.acme.example',
    });
    expect((await env.registry.getCustomApis(b.id))[0]).toMatchObject({
      origin: 'https://other.example',
    });
    expect((await call(b.viewer, 'GET', '/v1/custom-apis')).json()).toMatchObject({
      items: [{ origin: 'https://other.example' }],
    });
  });

  it('validate definitions', async () => {
    const org = await newOrg(env);
    const bad = async (body: object, expected: string) => {
      const res = await call(org.admin, 'POST', '/v1/custom-apis', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(issues(res) || res.json<{ message: string }>().message).toContain(expected);
    };
    await bad(acme({ origin: 'http://api.acme.example' }), 'Use https');
    await bad(acme({ origin: 'https://u:p@api.acme.example' }), 'No credentials in the URL');
    await bad(acme({ origin: 'https://api.acme.example/v1' }), 'Only the origin');
    await bad(acme({ origin: 'https://127.0.0.1' }), 'private or loopback');
    await bad(acme({ origin: 'https://[::1]:8443' }), 'private or loopback');
    await bad(acme({ origin: 'https://10.1.2.3' }), 'private or loopback');
    await bad(acme({ origin: 'https://localhost:9000' }), 'private or loopback');
    await bad(acme({ origin: 'https://proxy.spendbrake.dev' }), 'Spend Brake itself');
    await bad(acme({ origin: 'https://spendbrake.dev.' }), 'Spend Brake itself');
    await bad(acme({ id: 'google-maps' }), 'built-in provider');
    await bad(acme({ id: 'a b' }), 'id');
    await bad(acme({ routes: [] }), 'routes');
    await bad(
      acme({
        routes: [
          {
            path: '/a',
            sku: 'a',
            pricing: { model: 'reported', usdPerUnit: '1', maxPerRequest: '1' },
          },
        ],
      }),
      'Give either header or jsonPath',
    );
    await bad(
      acme({
        routes: [
          { path: '/a', sku: 'a', pricing: { model: 'reported', header: 'h', usdPerUnit: '1' } },
        ],
      }),
      'maxPerRequest',
    );
    await bad(
      acme({
        routes: [{ path: '/a', sku: 'a', pricing: { model: 'perRequest', usd: '1.1234567' } }],
      }),
      'USD',
    );
    await bad(acme({ auth: { type: 'header', name: 'Host' } }), 'cannot carry the credential');
    await bad(acme({ extra: true }), '');
  });

  it("refuse the service's own domains and allow private addresses only when configured", async () => {
    const policy = { allowPrivate: false, ownHosts: ['proxy.example.net', 'app.example.net'] };
    expect(originProblem('https://proxy.example.net', policy)).toContain('Spend Brake itself');
    expect(originProblem('https://eu.app.example.net', policy)).toContain('Spend Brake itself');
    expect(originProblem('https://example.net', policy)).toBeNull();
    expect(originProblem('https://192.168.1.10', policy)).toContain('private');
    const open = { ...policy, allowPrivate: true };
    expect(originProblem('https://192.168.1.10', open)).toBeNull();
    expect(originProblem('https://localhost', open)).toBeNull();
    expect(originProblem('https://app.spendbrake.dev', open)).toContain('Spend Brake itself');

    expect(
      ownHosts(
        loadEnv({
          BRAKE_PROXY_DOMAIN: 'Proxy.Example.net',
          BRAKE_APP_DOMAIN: 'app.example.net',
          BRAKE_PUBLIC_PROXY_URL: 'https://proxy.example.net',
          BRAKE_DASHBOARD_URL: 'http://localhost:3000',
        }),
      ),
    ).toEqual(['proxy.example.net', 'app.example.net']);

    const app = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: env.wrapper,
      authCacheMs: 0,
      rateLimitPerMinute: 10_000,
      customApiPolicy: policy,
    });
    try {
      const org = await newOrg(env);
      const res = await call(
        org.admin,
        'POST',
        '/v1/custom-apis',
        acme({ origin: 'https://proxy.example.net' }),
        app,
      );
      expect(res.statusCode).toBe(400);
      expect(issues(res)).toContain('origin: A custom API cannot point at Spend Brake itself');
    } finally {
      await app.close();
    }
  });

  it('take provider keys and Spend Brake keys like built-in providers', async () => {
    const org = await newOrg(env);
    await call(org.admin, 'POST', '/v1/custom-apis', acme());
    const cred = await call(org.admin, 'POST', '/v1/providers/credentials', {
      provider: 'acme',
      name: 'Acme Search',
      secret: 'acme-secret-1234',
    });
    expect(cred.statusCode, cred.body).toBe(201);
    const credId = cred.json<{ id: string; check?: unknown }>().id;
    expect(cred.json<{ check?: unknown }>().check).toBeUndefined();
    expect(await env.registry.getCredential(org.id, credId)).toMatchObject({ provider: 'acme' });

    const key = await call(org.admin, 'POST', '/v1/keys', {
      name: 'agent',
      credentials: { acme: credId },
    });
    expect(key.statusCode, key.body).toBe(201);

    // In use: refused, naming the key.
    const inUse = await call(org.admin, 'DELETE', '/v1/custom-apis/acme');
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ error: 'custom_api_in_use' });
    expect(inUse.json<{ message: string }>().message).toContain('"agent"');
    // Deleting its only provider key names the custom API.
    const credDel = await call(org.admin, 'DELETE', `/v1/providers/credentials/${credId}`);
    expect(credDel.statusCode).toBe(409);
    expect(credDel.json<{ message: string }>().message).toContain('Add another Acme Search key');

    await call(org.admin, 'DELETE', `/v1/keys/${key.json<{ id: string }>().id}`);
    const del = await call(org.admin, 'DELETE', '/v1/custom-apis/acme');
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toMatchObject({ deletedCredentials: [credId] });
    expect(await env.registry.getCredential(org.id, credId)).toBeNull();
    const creds = await call(org.viewer, 'GET', '/v1/providers/credentials');
    expect(creds.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('are limited per plan: new ones are refused, existing ones keep working', async () => {
    const org = await newOrg(env);
    await env.db
      .insert(orgEntitlements)
      .values({ orgId: org.id, plan: 'free', retentionDays: 7, maxCustomApis: 1 });
    expect((await call(org.admin, 'POST', '/v1/custom-apis', acme())).statusCode).toBe(201);
    const over = await call(org.admin, 'POST', '/v1/custom-apis', acme({ id: 'second' }));
    expect(over.statusCode).toBe(402);
    expect(over.json()).toMatchObject({
      error: 'plan_limit',
      message: expect.stringContaining('The free plan allows 1 custom API.') as string,
    });

    // Downgraded below what it has: existing ones stay and can be edited; no new ones.
    await env.db
      .update(orgEntitlements)
      .set({ plan: 'indie', maxCustomApis: 3 })
      .where(eq(orgEntitlements.orgId, org.id));
    expect((await call(org.admin, 'POST', '/v1/custom-apis', acme({ id: 'b' }))).statusCode).toBe(
      201,
    );
    expect((await call(org.admin, 'POST', '/v1/custom-apis', acme({ id: 'c' }))).statusCode).toBe(
      201,
    );
    await env.db
      .update(orgEntitlements)
      .set({ plan: 'free', maxCustomApis: 1 })
      .where(and(eq(orgEntitlements.orgId, org.id)));
    const rest: Record<string, unknown> = acme();
    delete rest.id;
    expect((await call(org.admin, 'PUT', '/v1/custom-apis/b', rest)).statusCode).toBe(200);
    expect((await call(org.admin, 'POST', '/v1/custom-apis', acme({ id: 'd' }))).statusCode).toBe(
      402,
    );
    expect(
      (await call(org.viewer, 'GET', '/v1/custom-apis')).json<{ items: unknown[] }>().items,
    ).toHaveLength(3);

    // Self-hosted (no plan row): unlimited.
    const free = await newOrg(env);
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect((await call(free.admin, 'POST', '/v1/custom-apis', acme({ id }))).statusCode).toBe(
        201,
      );
    }
  });
});
