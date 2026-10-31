import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiTokens, eq } from '@spend-brake/db';
import { resyncValkey } from '../src/resync.js';
import { apiContext } from '../src/server.js';
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => env.app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });

describe('resync from Postgres', () => {
  it('rebuilds every proxy record after Valkey loses its data', async () => {
    const org = await newOrg(env);
    await call(org.owner, 'PUT', '/v1/org', { timeZone: 'Europe/Sofia' });
    const cred = (
      await call(org.admin, 'POST', '/v1/providers/credentials', {
        provider: 'google-maps',
        name: 'c',
        secret: 'AIza-resync',
      })
    ).json<{ id: string }>().id;
    const live = (
      await call(org.admin, 'POST', '/v1/keys', {
        name: 'live',
        credentials: { 'google-maps': cred },
      })
    ).json<{ id: string; token: string }>();
    const dead = (
      await call(org.admin, 'POST', '/v1/keys', {
        name: 'dead',
        credentials: { 'google-maps': cred },
      })
    ).json<{ id: string; token: string }>();
    await call(org.admin, 'DELETE', `/v1/keys/${dead.id}`);
    await call(org.admin, 'PUT', `/v1/caps/key:${live.id}`, { day: { hard: 5000 } });

    await env.valkey.flushall();
    expect(await env.registry.getKeyByToken(live.token)).toBeNull();

    const result = await resyncValkey(
      apiContext({ db: env.db, valkey: env.valkey, wrapper: env.wrapper }),
      org.id,
    );
    expect(result).toEqual({ orgs: 1, keys: 2, caps: 1, credentials: 1, customApis: 0 });
    expect(await env.registry.getKeyByToken(live.token)).toMatchObject({
      status: 'active',
      name: 'live',
    });
    expect((await env.registry.getKeyByToken(dead.token))?.status).toBe('revoked');
    expect((await env.registry.getOrg(org.id))?.timeZone).toBe('Europe/Sofia');
    expect(await env.registry.getCredential(org.id, cred)).not.toBeNull();
    const status = await call(org.viewer, 'GET', `/v1/status?scope=key:${live.id}`);
    expect(status.json<{ scopes: { hard: number }[] }>().scopes[0]!.hard).toBe(5000);

    // Running it again changes nothing.
    const again = await resyncValkey(
      apiContext({ db: env.db, valkey: env.valkey, wrapper: env.wrapper }),
      org.id,
    );
    expect(again.caps).toBe(0);
  });
});

describe('small API fixes', () => {
  it('answers 400 for forged cursors', async () => {
    const org = await newOrg(env);
    const c = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const url of [
      `/v1/events?source=audit&cursor=${c(['x'])}`,
      `/v1/events?cursor=${c(['not a date', '1-0'])}`,
      `/v1/events?cursor=${c(['2026-10-29T00:00:00Z', 5])}`,
    ]) {
      expect((await call(org.viewer, 'GET', url)).statusCode, url).toBe(400);
    }
  });

  it('records when a token was last used', async () => {
    const org = await newOrg(env);
    await call(org.viewer, 'GET', '/v1/keys');
    await new Promise((r) => setTimeout(r, 100));
    const rows = await env.db.select().from(apiTokens).where(eq(apiTokens.orgId, org.id));
    expect(rows.find((r) => r.role === 'viewer')?.lastUsedAt).toBeInstanceOf(Date);
  });
});
