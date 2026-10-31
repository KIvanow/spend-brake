import { Readable } from 'node:stream';
import { BudgetEngine } from '@spend-brake/budget';
import { guardedAgent } from '@spend-brake/shared';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StaticSecretStore } from '../src/secrets.js';
import { type Harness, MockGoogle, newKey, newOrg, startProxy, startValkey } from './harness.js';

let container: StartedTestContainer;
let valkeyUrl: string;
let mock: MockGoogle;
let h: Harness;

const ORIGIN_A = 'https://api.acme-a.example';
const ORIGIN_B = 'https://api.acme-b.example';
const secrets = new StaticSecretStore({ 'cred-a': 'secret-a', 'cred-b': 'secret-b' });

const api = (origin: string, routes: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'acme',
  name: 'Acme',
  origin,
  auth: { type: 'header', name: 'X-Acme-Key', valuePrefix: 'Key ' },
  routes,
  billed: '2xx',
  timeoutBilled: true,
  ...extra,
});

const flat = (usd: string) => [
  { method: '*', path: '/v1/**', sku: 'call', pricing: { model: 'perRequest', usd } },
];

const reported = (pricing: Record<string, unknown>) => [
  {
    method: 'POST',
    path: '/v1/run',
    sku: 'run',
    pricing: { model: 'reported', usdPerUnit: '0.001', maxPerRequest: '0.50', ...pricing },
  },
];

beforeAll(async () => {
  ({ container, url: valkeyUrl } = await startValkey());
  mock = await new MockGoogle().start();
  h = await startProxy(valkeyUrl, mock, {
    adapters: [],
    secrets,
    configTtlMs: 50,
    customEgress: guardedAgent(true, 'custom API'),
    customMaxResponseBytes: 64 * 1024,
    upstreamOverrides: { [ORIGIN_A]: mock.url, [ORIGIN_B]: mock.url },
  });
});

afterAll(async () => {
  await h.proxy.close();
  await h.valkey.quit();
  await mock.app.close();
  await container.stop();
});

beforeEach(() => {
  mock.respond = (_req, reply) => reply.send({ ok: true });
});

async function events(org: string) {
  await h.proxy.brakeDrain();
  const entries = await h.valkey.xrange(`bk:{o:${org}}:events`, '-', '+');
  return entries.map(([, fields]) => {
    const o: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) o[fields[i]!] = fields[i + 1]!;
    return o;
  });
}

const call = (token: string, path = '/custom/acme/v1/things', method: 'GET' | 'POST' = 'GET') =>
  h.proxy.inject({
    method,
    url: path,
    headers: { 'x-brake-key': token, 'content-type': 'application/json' },
    ...(method === 'POST' ? { payload: JSON.stringify({ n: Math.random() }) } : {}),
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('org custom APIs through the proxy', () => {
  it('resolves the id within the key org: two orgs can both have "acme"', async () => {
    const orgA = newOrg();
    const orgB = newOrg();
    await h.registry.putCustomApis(orgA, [api(ORIGIN_A, flat('0.01'))]);
    await h.registry.putCustomApis(orgB, [
      api(ORIGIN_B, flat('0.02'), { auth: { type: 'query', name: 'api_key' } }),
    ]);
    const a = await newKey(h, orgA, { credentials: { acme: 'cred-a' } });
    const b = await newKey(h, orgB, { credentials: { acme: 'cred-b' } });

    const ra = await call(a.token);
    expect(ra.statusCode).toBe(200);
    expect(ra.headers['x-brake-cost-micros']).toBe('10000');
    expect(mock.last().headers['x-acme-key']).toBe('Key secret-a');
    expect(mock.last().headers['x-brake-key']).toBeUndefined();
    expect(mock.last().url).toBe('/v1/things');

    const rb = await call(b.token);
    expect(rb.statusCode).toBe(200);
    expect(rb.headers['x-brake-cost-micros']).toBe('20000');
    expect(mock.last().url).toBe('/v1/things?api_key=secret-b');
    expect(mock.last().headers['x-acme-key']).toBeUndefined();

    const [usage] = (await events(orgA)).filter((e) => e.type === 'usage');
    expect(usage).toMatchObject({ provider: 'acme', route: 'call', costMicros: '10000' });
    // Spend counts against the custom API like a built-in provider.
    expect(await h.valkey.get(`bk:{o:${orgA}}:spent:sku:acme:call:d:20261029`)).toBe('10000');
  });

  it('refuses keys not bound to the custom API, unknown ids and unpriced routes', async () => {
    const org = newOrg();
    await h.registry.putCustomApis(org, [api(ORIGIN_A, flat('0.01'))]);
    const bound = await newKey(h, org, { credentials: { acme: 'cred-a' } });
    const other = await newKey(h, org, { credentials: { other: 'cred-a' } });
    expect((await call(other.token)).json()).toMatchObject({ error: 'sku_not_allowed' });
    const unknown = await call(bound.token, '/custom/nope/v1/x');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'unknown_route' });
    // Another org's custom API is not visible.
    const stranger = await newKey(h, newOrg(), { credentials: { acme: 'cred-a' } });
    expect((await call(stranger.token)).statusCode).toBe(404);
    expect((await call(bound.token, '/custom/acme/other')).json()).toMatchObject({
      error: 'unpriced_route',
    });
    expect(mock.seen.some((s) => s.url === '/other')).toBe(false);
  });

  it('reserves maxPerRequest and settles at the cost the API reports in a header', async () => {
    const org = newOrg();
    await h.registry.putCustomApis(org, [api(ORIGIN_A, reported({ header: 'X-Credits' }))]);
    const { token, id } = await newKey(h, org, { credentials: { acme: 'cred-a' } });
    mock.respond = (_req, reply) => reply.header('x-credits', '42').send({ ok: true });
    const res = await call(token, '/custom/acme/v1/run', 'POST');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-brake-cost-micros']).toBe('42000');
    const [usage] = (await events(org)).filter((e) => e.type === 'usage');
    expect(usage).toMatchObject({ worstMicros: '500000', costMicros: '42000' });
    expect(usage!.costNote).toBeUndefined();

    // The reservation is the maximum: a cap below it refuses the call before it is sent.
    const engine = new BudgetEngine(h.valkey);
    await engine.setCap(org, { kind: 'key', id }, 'd', { hard: 400_000n, soft: null });
    const seen = mock.seen.length;
    const refused = await call(token, '/custom/acme/v1/run', 'POST');
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ error: 'budget_exceeded' });
    expect(mock.seen.length).toBe(seen);
  });

  it('settles at a JSON field, charges above the max in full and flags it', async () => {
    const org = newOrg();
    await h.registry.putCustomApis(org, [
      api(ORIGIN_A, reported({ jsonPath: 'usage.credits', usdPerUnit: '0.01' })),
    ]);
    const { token } = await newKey(h, org, { credentials: { acme: 'cred-a' } });
    mock.respond = (_req, reply) => reply.send({ usage: { credits: 3 } });
    expect((await call(token, '/custom/acme/v1/run', 'POST')).headers['x-brake-cost-micros']).toBe(
      '30000',
    );
    mock.respond = (_req, reply) => reply.send({ usage: { credits: 80 } });
    const over = await call(token, '/custom/acme/v1/run', 'POST');
    expect(over.headers['x-brake-cost-micros']).toBe('800000');
    const usage = (await events(org)).filter((e) => e.type === 'usage');
    expect(usage[1]).toMatchObject({ costMicros: '800000', costNote: 'over_max' });
    expect(h.logs.text()).toContain('reported cost is above the route maximum');
  });

  it('settles at maxPerRequest when no cost is reported, and flags it', async () => {
    const org = newOrg();
    await h.registry.putCustomApis(org, [api(ORIGIN_A, reported({ jsonPath: 'usage.credits' }))]);
    const { token } = await newKey(h, org, { credentials: { acme: 'cred-a' } });
    mock.respond = (_req, reply) => reply.send({ result: 'no usage here' });
    const res = await call(token, '/custom/acme/v1/run', 'POST');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'no usage here' });
    expect(res.headers['x-brake-cost-micros']).toBe('500000');
    const [usage] = (await events(org)).filter((e) => e.type === 'usage');
    expect(usage).toMatchObject({ costMicros: '500000', costNote: 'cost_unreported' });
  });

  it('picks up changed and deleted definitions without a restart', async () => {
    const org = newOrg();
    await h.registry.putCustomApis(org, [api(ORIGIN_A, flat('0.01'))]);
    const { token } = await newKey(h, org, { credentials: { acme: 'cred-a' } });
    expect((await call(token)).headers['x-brake-cost-micros']).toBe('10000');
    await h.registry.putCustomApis(org, [api(ORIGIN_A, flat('0.03'))]);
    await sleep(80);
    expect((await call(token)).headers['x-brake-cost-micros']).toBe('30000');
    await h.registry.putCustomApis(org, []);
    await sleep(80);
    expect((await call(token)).statusCode).toBe(404);
  });

  it('skips a stored definition it cannot read without breaking the others', async () => {
    const org = newOrg();
    await h.registry.putCustomApis(org, [
      { id: 'broken', origin: 'ftp://x' },
      api(ORIGIN_A, flat('0.01')),
    ]);
    const { token } = await newKey(h, org, { credentials: { acme: 'cred-a', broken: 'cred-a' } });
    expect((await call(token)).statusCode).toBe(200);
    expect((await call(token, '/custom/broken/v1/x')).json()).toMatchObject({
      error: 'unknown_route',
    });
  });

  it('cuts responses over the size limit and records an error', async () => {
    const org = newOrg();
    await h.registry.putCustomApis(org, [api(ORIGIN_A, flat('0.01'))]);
    const { token } = await newKey(h, org, { credentials: { acme: 'cred-a' } });
    const big = Buffer.alloc(100 * 1024, 'a');

    // Announced as too long: not passed on.
    mock.respond = (_req, reply) => reply.header('content-type', 'text/plain').send(big);
    const announced = await call(token);
    expect(announced.statusCode).toBe(502);
    expect(announced.json()).toMatchObject({ error: 'upstream_unavailable' });

    // Streamed with no length: cut at the limit.
    mock.respond = (_req, reply) =>
      reply
        .header('content-type', 'text/plain')
        .send(Readable.from([big.subarray(0, 50_000), big]));
    const streamed = await call(token).catch((err: Error) => err);
    if (!(streamed instanceof Error)) expect(streamed.rawPayload.length).toBeLessThan(big.length);

    const usage = (await events(org)).filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(2);
    for (const e of usage) expect(e).toMatchObject({ error: 'response_too_large' });
    // The provider answered: the call is still charged.
    expect(usage[0]!.costMicros).toBe('10000');
  });
});

describe('custom API egress', () => {
  let guarded: Harness;

  beforeAll(async () => {
    guarded = await startProxy(valkeyUrl, mock, {
      adapters: [],
      secrets,
      customEgress: guardedAgent(false, 'custom API'),
      upstreamOverrides: { [ORIGIN_A]: mock.url },
    });
  });

  afterAll(async () => {
    await guarded.proxy.close();
    await guarded.valkey.quit();
  });

  it('refuses private addresses, by IP literal and by name, and sends nothing', async () => {
    const org = newOrg();
    await guarded.registry.putCustomApis(org, [
      api(ORIGIN_A, flat('0.01')),
      api('https://localhost:1', flat('0.01'), { id: 'local' }),
    ]);
    const { token } = await newKey(guarded, org, {
      credentials: { acme: 'cred-a', local: 'cred-a' },
    });
    const seen = mock.seen.length;
    for (const path of ['/custom/acme/v1/x', '/custom/local/v1/x']) {
      const res = await guarded.proxy.inject({
        method: 'GET',
        url: path,
        headers: { 'x-brake-key': token },
      });
      expect(res.statusCode, path).toBe(502);
      expect(res.json<{ message: string }>().message).toContain('private address');
      expect(res.headers['x-brake-cost-micros']).toBe('0');
    }
    expect(mock.seen.length).toBe(seen);
    await guarded.proxy.brakeDrain();
    const entries = await guarded.valkey.xrange(`bk:{o:${org}}:events`, '-', '+');
    expect(entries).toHaveLength(2);
    for (const [, fields] of entries) {
      expect(fields).toContain('private_address');
    }
  });
});
