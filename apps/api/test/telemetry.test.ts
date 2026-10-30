import { type Server, createServer } from 'node:http';
import { orgEntitlements } from '@spend-brake/db';
import { guardedAgent, orgMetricsKey } from '@spend-brake/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/server.js';
import { type Env, bearer, newOrg, startEnv } from './harness.js';

let env: Env;
let app: FastifyInstance;
let collector: Server;
let collectorUrl: string;
const received: { headers: Record<string, unknown>; body: string }[] = [];

beforeAll(async () => {
  env = await startEnv();
  collector = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  collectorUrl = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  app = await buildApi({
    db: env.db,
    valkey: env.valkey,
    wrapper: env.wrapper,
    authCacheMs: 0,
    rateLimitPerMinute: 100_000,
    // The test collector listens on 127.0.0.1.
    collectorDispatcher: guardedAgent(true, 'collector'),
  });
});

afterAll(async () => {
  collector.close();
  await app.close();
  await env.stop();
});

const plan = (orgId: string, p: 'free' | 'team', otelExport: boolean) =>
  env.db.insert(orgEntitlements).values({ orgId, plan: p, retentionDays: 7, otelExport });

describe('Prometheus metrics', () => {
  it("serve the org's own counters and live budget to any of its tokens", async () => {
    const org = await newOrg(env);
    await env.valkey.hset(
      orgMetricsKey(org.id),
      'req\u001fagent="",env="",key="key_1",outcome="ok",provider="google-maps",sku="gmp.geocoding"',
      '3',
    );
    await app.inject({
      method: 'PUT',
      url: '/v1/caps/org',
      headers: bearer(org.admin),
      payload: { day: { hard: 5_000_000 } },
    });
    const res = await app.inject({ url: '/v1/metrics', headers: bearer(org.viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain; version=0.0.4');
    expect(res.body).toContain(
      'spend_brake_requests_total{agent="",env="",key="key_1",outcome="ok",provider="google-maps",sku="gmp.geocoding"} 3',
    );
    expect(res.body).toContain('spend_brake_cap_usd{scope="org",window="day"} 5');
    expect(res.body).toContain('spend_brake_remaining_usd{scope="org",window="day"} 5');

    // Another org's tokens see their own (empty) counters.
    const other = await newOrg(env);
    const theirs = await app.inject({ url: '/v1/metrics', headers: bearer(other.viewer) });
    expect(theirs.body).not.toContain('key_1');
    expect((await app.inject({ url: '/v1/metrics' })).statusCode).toBe(401);
  });
});

describe('OpenTelemetry export settings', () => {
  it('come with the Team plan and up (self-hosted installs have every feature)', async () => {
    const free = await newOrg(env);
    await plan(free.id, 'free', false);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/telemetry/otlp',
      headers: bearer(free.admin),
      payload: { endpoint: 'https://otlp.example.com' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'plan_feature' });
  });

  it('store the headers encrypted, show only their names, and send a test span', async () => {
    const org = await newOrg(env);
    await plan(org.id, 'team', true);
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/telemetry/otlp',
      headers: bearer(org.admin),
      payload: { endpoint: collectorUrl, headers: { 'x-honeycomb-team': 'hc-secret' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      endpoint: collectorUrl,
      headerNames: ['x-honeycomb-team'],
      enabled: true,
      queued: 0,
    });
    expect(put.body).not.toContain('hc-secret');
    const get = await app.inject({ url: '/v1/telemetry/otlp', headers: bearer(org.viewer) });
    expect(get.body).not.toContain('hc-secret');

    // Changing the endpoint alone keeps the headers.
    await app.inject({
      method: 'PUT',
      url: '/v1/telemetry/otlp',
      headers: bearer(org.admin),
      payload: { endpoint: `${collectorUrl}/v1/traces` },
    });
    const test = await app.inject({
      method: 'POST',
      url: '/v1/telemetry/otlp/test',
      headers: bearer(org.admin),
    });
    expect(test.json()).toEqual({ ok: true, status: 200, error: null });
    const last = received.at(-1)!;
    expect(last.headers['x-honeycomb-team']).toBe('hc-secret');
    expect(last.body).toContain('"name":"spend-brake test"');

    const audit = await app.inject({ url: '/v1/events?source=audit', headers: bearer(org.viewer) });
    expect(audit.body).toContain('telemetry.otlp.set');
    expect(audit.body).not.toContain('hc-secret');

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/telemetry/otlp',
          headers: bearer(org.admin),
        })
      ).json(),
    ).toEqual({ deleted: true });
    expect(
      (await app.inject({ url: '/v1/telemetry/otlp', headers: bearer(org.viewer) })).json(),
    ).toEqual({
      otlp: null,
    });
  });

  it('refuse plain HTTP to other hosts, credentials in the URL and reserved headers', async () => {
    const org = await newOrg(env);
    const put = (payload: object) =>
      app.inject({ method: 'PUT', url: '/v1/telemetry/otlp', headers: bearer(org.admin), payload });
    expect((await put({ endpoint: 'http://otlp.example.com' })).statusCode).toBe(400);
    expect((await put({ endpoint: 'https://user:pw@otlp.example.com' })).statusCode).toBe(400);
    expect(
      (await put({ endpoint: 'https://otlp.example.com', headers: { Host: 'evil' } })).statusCode,
    ).toBe(400);
    // Viewers may look but not change.
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/telemetry/otlp',
          headers: bearer(org.viewer),
          payload: { endpoint: 'https://otlp.example.com' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('never let a test span reach a private address', async () => {
    const strict = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: env.wrapper,
      authCacheMs: 0,
    });
    const org = await newOrg(env);
    await app.inject({
      method: 'PUT',
      url: '/v1/telemetry/otlp',
      headers: bearer(org.admin),
      payload: { endpoint: collectorUrl },
    });
    const test = await strict.inject({
      method: 'POST',
      url: '/v1/telemetry/otlp/test',
      headers: bearer(org.admin),
    });
    // A local http:// collector saved where they were allowed: the test says what to set.
    expect(test.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('ALLOW_PRIVATE_COLLECTORS=true') as string,
    });
    // And it cannot be saved without the setting.
    const put = await strict.inject({
      method: 'PUT',
      url: '/v1/telemetry/otlp',
      headers: bearer(org.admin),
      payload: { endpoint: 'http://localhost:4318' },
    });
    expect(put.statusCode).toBe(400);
    expect(put.body).toContain('ALLOW_PRIVATE_COLLECTORS');
    await strict.close();
  });
});
