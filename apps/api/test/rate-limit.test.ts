import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/server.js';
import { type Env, newOrg, startEnv } from './harness.js';

let env: Env;

beforeAll(async () => {
  env = await startEnv();
});

afterAll(async () => {
  await env.stop();
});

describe('rate limits', () => {
  it('limits each token separately', async () => {
    const org = await newOrg(env);
    const app = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: null,
      rateLimitPerMinute: 3,
    });
    const get = (t: string) =>
      app.inject({ url: '/v1/keys', headers: { authorization: `Bearer ${t}` } });
    for (let i = 0; i < 3; i++) expect((await get(org.viewer)).statusCode).toBe(200);
    const limited = await get(org.viewer);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect((await get(org.admin)).statusCode).toBe(200);
    await app.close();
  });
});
