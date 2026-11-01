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
  it('limits each valid token, and unauthenticated traffic per IP whatever header it sends', async () => {
    const org = await newOrg(env);
    // 3 per token per minute; 12 per IP.
    const app = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: null,
      rateLimitPerMinute: 3,
    });
    const get = (auth: string) => app.inject({ url: '/v1/keys', headers: { authorization: auth } });
    for (let i = 0; i < 3; i++) expect((await get(`Bearer ${org.viewer}`)).statusCode).toBe(200);
    const limited = await get(`Bearer ${org.viewer}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    // Another token has its own allowance.
    expect((await get(`Bearer ${org.admin}`)).statusCode).toBe(200);
    // A fresh garbage header per request does not buy a fresh bucket.
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await get(`Bearer junk-${i}`)).statusCode);
    expect(codes.slice(0, 7).every((c) => c === 401)).toBe(true);
    expect(codes[7]).toBe(429);
    await app.close();
  });

  it('behind the reverse proxy, takes X-Forwarded-For only from private hops', async () => {
    // 4 per IP per minute.
    const app = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: null,
      rateLimitPerMinute: 1,
      trustProxy: true,
    });
    const attempt = (forwardedFor: string, remoteAddress = '172.18.0.5') =>
      app.inject({
        url: '/v1/keys',
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
      });
    for (let i = 0; i < 4; i++) expect((await attempt('203.0.113.7')).statusCode).toBe(401);
    expect((await attempt('203.0.113.7')).statusCode).toBe(429);
    // Another client (Caddy -> nginx hops are private) has its own bucket.
    expect((await attempt('198.51.100.9, 172.18.0.2')).statusCode).toBe(401);
    // A public peer's own X-Forwarded-For is not trusted: it can't pick a bucket, or an address.
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push((await attempt(`192.0.2.${i}`, '203.0.113.7')).statusCode);
    expect(codes).toEqual([429, 429, 429, 429, 429]);
    await app.close();
  });
});
