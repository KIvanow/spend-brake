import { randomBytes } from 'node:crypto';
import { Registry } from '@spend-brake/budget';
import { usageEvents } from '@spend-brake/db';
import { LocalKeyWrapper } from '@spend-brake/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkGoogleKey } from '../src/google-check.js';
import { buildApi } from '../src/server.js';
import { type Env, bearer, newOrg, startEnv } from './harness.js';

let env: Env;

beforeAll(async () => {
  env = await startEnv();
});

afterAll(async () => {
  await env.stop();
});

describe('first-run setup', () => {
  it('creates the org and owner token once, with the right setup token', async () => {
    await env.db.execute((await import('@spend-brake/db')).sql`truncate orgs cascade`);
    const app: FastifyInstance = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: null,
      setupToken: 'setup-token-0123456789',
      rateLimitPerMinute: 100_000,
    });
    const post = (payload: object) => app.inject({ method: 'POST', url: '/v1/setup', payload });
    const base = { orgId: 'acme', name: 'Acme', timeZone: 'Europe/Sofia' };
    expect((await post({ ...base, setupToken: 'wrong' })).statusCode).toBe(401);
    expect(
      (await post({ ...base, timeZone: 'Mars/Base', setupToken: 'setup-token-0123456789' }))
        .statusCode,
    ).toBe(400);
    const [a, b] = await Promise.all([
      post({ ...base, setupToken: 'setup-token-0123456789' }),
      post({ ...base, orgId: 'other', setupToken: 'setup-token-0123456789' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const ok = a.statusCode === 201 ? a : b;
    const token = ok.json<{ ownerToken: string }>().ownerToken;
    expect(token).toMatch(/^sbt_/);
    const org = await app.inject({ url: '/v1/org', headers: bearer(token) });
    expect(org.statusCode).toBe(200);
    expect(
      await new Registry(env.valkey).getOrg(ok.json<{ orgId: string }>().orgId),
    ).not.toBeNull();
    expect(
      (await post({ ...base, orgId: 'third', setupToken: 'setup-token-0123456789' })).statusCode,
    ).toBe(409);
    await app.close();

    const disabled = await buildApi({ db: env.db, valkey: env.valkey, wrapper: null });
    expect(
      (
        await disabled.inject({
          method: 'POST',
          url: '/v1/setup',
          payload: { ...base, setupToken: 'x' },
        })
      ).statusCode,
    ).toBe(503);
    await disabled.close();
  });
});

describe('GET /v1/me', () => {
  it('shows a key its own budget, and nothing without a valid key', async () => {
    const org = await newOrg(env);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      env.app.inject({ method, url, headers: bearer(org.admin), ...(payload ? { payload } : {}) });
    const cred = (
      await call('POST', '/v1/providers/credentials', {
        provider: 'acme',
        name: 'c',
        secret: 'secret-1',
      })
    ).json<{ id: string }>().id;
    const key = (await call('POST', '/v1/keys', { name: 'k', credentials: { acme: cred } })).json<{
      id: string;
      token: string;
    }>();
    await call('PUT', `/v1/caps/key:${key.id}`, { day: { hard: 5_000_000 } });
    const me = await env.app.inject({ url: '/v1/me', headers: { 'x-brake-key': key.token } });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      keyId: string;
      sessionId: null;
      killed: boolean;
      scopes: { scope: string }[];
    }>();
    expect(body).toMatchObject({ keyId: key.id, sessionId: null, killed: false });
    expect(body.scopes.find((x) => x.scope === `key:${key.id}`)).toMatchObject({
      hard: 5_000_000,
      remaining: 5_000_000,
    });
    expect(
      (
        await env.app.inject({
          url: '/v1/me',
          headers: { 'x-brake-key': 'sb_live_0000000000000000000000' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await env.app.inject({ url: '/v1/me' })).statusCode).toBe(401);
  });
});

describe('Google key restriction check', () => {
  const reply = (status: number, reason?: string) =>
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify(reason ? { error: { details: [{ reason }] } } : { models: [] }),
          { status },
        ),
      )) as unknown as typeof fetch;

  it('reads restrictions from what Google answers', async () => {
    expect(await checkGoogleKey('k', reply(403, 'API_KEY_SERVICE_BLOCKED'))).toMatchObject({
      apiRestricted: true,
      valid: true,
    });
    expect(await checkGoogleKey('k', reply(403, 'API_KEY_IP_ADDRESS_BLOCKED'))).toMatchObject({
      ipRestricted: true,
      warnings: [],
    });
    const open = await checkGoogleKey('k', reply(200));
    expect(open.apiRestricted).toBe(false);
    expect(open.warnings.join()).toContain('no API restrictions');
    expect((await checkGoogleKey('k', reply(403, 'SERVICE_DISABLED'))).apiRestricted).toBe(false);
    expect(await checkGoogleKey('k', reply(400, 'API_KEY_INVALID'))).toMatchObject({
      valid: false,
    });
    const down = await checkGoogleKey('k', () => Promise.reject(new Error('offline')));
    expect(down).toMatchObject({ apiRestricted: null, valid: null });
  });

  it('runs when a Google key is added and is reported and audited', async () => {
    const seen: string[] = [];
    const app = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: new LocalKeyWrapper(randomBytes(32).toString('base64')),
      rateLimitPerMinute: 100_000,
      checkGoogleKey: (key) => {
        seen.push(key);
        return checkGoogleKey(key, reply(200));
      },
    });
    const org = await newOrg(env);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/credentials',
      headers: bearer(org.admin),
      payload: { provider: 'google-maps', name: 'g', secret: 'AIza-open-key' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ check: { apiRestricted: false, valid: true } });
    expect(res.body).not.toContain('AIza-open-key');
    expect(seen).toEqual(['AIza-open-key']);
    const other = await app.inject({
      method: 'POST',
      url: '/v1/providers/credentials',
      headers: bearer(org.admin),
      payload: { provider: 'acme', name: 'a', secret: 'not-google' },
    });
    expect(other.json()).not.toHaveProperty('check');
    expect(seen).toHaveLength(1);
    await app.close();
  });
});

describe('POST /v1/estimates/migration', () => {
  it('prices the last 30 days of billed usage on the alternatives', async () => {
    const org = await newOrg(env);
    const now = Date.now();
    const ev = (i: number, sku: string, cost: bigint, status = 200, daysAgo = 1) => ({
      orgId: org.id,
      ts: new Date(now - daysAgo * 86_400_000),
      streamId: `${i}-0`,
      type: 'usage',
      provider: 'google-maps',
      sku,
      costMicros: cost,
      status,
      data: { units: '1' },
    });
    await env.db.insert(usageEvents).values([
      ...Array.from({ length: 40 }, (_, i) => ev(i, 'geocoding', 5000n)),
      ev(100, 'places.text_search.pro', 32_000n),
      ev(101, 'geocoding', 0n, 400),
      ev(102, 'geocoding', 5000n, 200, 45),
      // Other providers' usage is not Google spend to migrate.
      { ...ev(103, 'twilio.sms.US', 14_500n, 201), provider: 'twilio' },
    ]);
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/estimates/migration',
      headers: bearer(org.viewer),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      googleCostMicros: number;
      requests: number;
      alternatives: {
        provider: string;
        plan: string;
        monthlyCostMicros: number;
        uncovered: { sku: string }[];
      }[];
    }>();
    expect(body.googleCostMicros).toBe(40 * 5000 + 32_000);
    expect(body.requests).toBe(41);
    const op = body.alternatives.find((a) => a.provider === 'openplacesapi')!;
    expect(op.plan).toBe('Free');
    expect(op.uncovered.map((u) => u.sku)).toEqual(['geocoding']);
    expect(body.alternatives.map((a) => a.provider).sort()).toEqual([
      'geoapify',
      'here',
      'mapbox',
      'openplacesapi',
      'stadia',
    ]);
    // 40 geocodes and one text search, a month's worth, at list price without free tiers.
    const mapbox = body.alternatives.find((a) => a.provider === 'mapbox')!;
    expect(mapbox).toMatchObject({ plan: 'Pay as you go', monthlyCostMicros: 40 * 750 + 1700 });
    const here = body.alternatives.find((a) => a.provider === 'here')!;
    expect(here.monthlyCostMicros).toBe(40 * 880 + 2920);
  });
});

describe('session keys follow their parent', () => {
  it('are updated with the parent and revoked with it', async () => {
    const org = await newOrg(env);
    const call = (
      method: 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: object,
      headers = bearer(org.admin),
    ) => env.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const cred = (
      await call('POST', '/v1/providers/credentials', {
        provider: 'acme',
        name: 'c',
        secret: 'secret-1',
      })
    ).json<{ id: string }>().id;
    const parent = (
      await call('POST', '/v1/keys', {
        name: 'p',
        credentials: { acme: cred },
        canMintSessions: true,
      })
    ).json<{ id: string; token: string }>();
    const minted = await env.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { 'x-brake-key': parent.token },
      payload: {},
    });
    expect(minted.statusCode).toBe(201);
    const child = minted.json<{ token: string; keyId: string }>();
    const registry = new Registry(env.valkey);

    expect(
      (
        await call('PATCH', `/v1/keys/${parent.id}`, {
          allowedIps: ['10.1.1.1'],
          skus: ['geocoding'],
        })
      ).statusCode,
    ).toBe(200);
    expect(await registry.getKeyByToken(child.token)).toMatchObject({
      allowedIps: ['10.1.1.1'],
      skus: ['geocoding'],
      status: 'active',
    });
    // The child's IP allow-list now applies to /v1/me too.
    expect(
      (await env.app.inject({ url: '/v1/me', headers: { 'x-brake-key': child.token } })).statusCode,
    ).toBe(401);

    expect((await call('DELETE', `/v1/keys/${parent.id}`)).statusCode).toBe(200);
    expect((await registry.getKeyByToken(child.token))?.status).toBe('revoked');
    const keys = await env.app.inject({ url: '/v1/keys', headers: bearer(org.viewer) });
    expect(
      keys
        .json<{ items: { id: string; status: string }[] }>()
        .items.find((k) => k.id === child.keyId)?.status,
    ).toBe('revoked');
  });
});
