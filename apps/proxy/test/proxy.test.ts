import { gunzipSync, gzipSync } from 'node:zlib';
import { BudgetEngine } from '@spend-brake/budget';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Harness,
  MockGoogle,
  REAL_KEY,
  newKey,
  newOrg,
  startProxy,
  startValkey,
} from './harness.js';

let container: StartedTestContainer;
let valkeyUrl: string;
let mock: MockGoogle;
let h: Harness;
let engine: BudgetEngine;

beforeAll(async () => {
  ({ container, url: valkeyUrl } = await startValkey());
  mock = await new MockGoogle().start();
  h = await startProxy(valkeyUrl, mock);
  engine = new BudgetEngine(h.valkey);
});

afterAll(async () => {
  await h.proxy.close();
  await h.valkey.quit();
  await mock.app.close();
  await container.stop();
});

beforeEach(() => {
  mock.respond = (_req, reply) => reply.send({ places: [] });
});

const textSearch = (token: string, extra: Record<string, string> = {}) =>
  h.proxy.inject({
    method: 'POST',
    url: '/google-places/v1/places:searchText',
    headers: {
      'x-brake-key': token,
      'content-type': 'application/json',
      'x-goog-fieldmask': 'places.id,places.displayName',
      ...extra,
    },
    payload: JSON.stringify({ textQuery: `pizza ${Math.random()}` }),
  });

async function spent(org: string, scope = 'org', window = 'd:20261029') {
  await h.proxy.brakeDrain();
  return BigInt((await h.valkey.get(`bk:{o:${org}}:spent:${scope}:${window}`)) ?? '0');
}

async function events(org: string) {
  await h.proxy.brakeDrain();
  const entries = await h.valkey.xrange(`bk:{o:${org}}:events`, '-', '+');
  return entries.map(([, fields]) => {
    const o: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) o[fields[i]!] = fields[i + 1]!;
    return o;
  });
}

describe('happy path', () => {
  it('forwards with the real key, prices, settles and emits an event', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org, { sessionCapMicros: '100000000' });
    await engine.setCap(org, { kind: 'key', id }, 'd', { hard: 1_000_000n, soft: null });
    const body = JSON.stringify({ textQuery: 'pizza in Sofia', pageSize: 5 });
    mock.respond = (_req, reply) => reply.send({ places: [{ id: 'ChIJ1' }] });

    const res = await h.proxy.inject({
      method: 'POST',
      url: '/google-places/v1/places:searchText',
      headers: {
        'x-brake-key': token,
        'x-brake-session': 'run-1',
        'content-type': 'application/json',
        'x-goog-fieldmask': 'places.id,places.displayName',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'user-agent': 'my-app/1.0',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ places: [{ id: 'ChIJ1' }] });
    expect(res.headers['x-brake-cost-micros']).toBe('32000');
    expect(res.headers['x-brake-remaining-micros']).toBe(String(1_000_000 - 32_000));
    expect(res.headers['x-brake-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const up = mock.last();
    expect(up.url).toBe('/v1/places:searchText');
    expect(up.headers['x-goog-api-key']).toBe(REAL_KEY);
    expect(up.headers['x-goog-fieldmask']).toBe('places.id,places.displayName');
    expect(up.headers['x-brake-key']).toBeUndefined();
    expect(up.headers['x-brake-session']).toBeUndefined();
    expect(up.body.toString()).toBe(body);

    expect(await spent(org)).toBe(32_000n);
    expect(await spent(org, `key:${id}`)).toBe(32_000n);
    expect(await spent(org, 'sku:google-maps:places.text_search.pro')).toBe(32_000n);
    expect(await spent(org, 'sess:run-1')).toBe(32_000n);
    expect(await h.valkey.get(`bk:{o:${org}}:units:places.text_search.pro:m:202610`)).toBe('1');

    const [ev] = await events(org);
    expect(ev).toMatchObject({
      type: 'usage',
      keyId: id,
      provider: 'google-maps',
      route: 'places.text_search',
      skus: 'places.text_search.pro',
      costMicros: '32000',
      worstMicros: '32000',
      status: '200',
      session: 'run-1',
      // For the org's own telemetry: the caller's trace, client and sizes (never the query).
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      userAgent: 'my-app/1.0',
      reqBytes: String(Buffer.byteLength(body)),
    });
    expect(Number(ev!.resBytes)).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain('pizza');
  });

  it('accepts the virtual key in place of the Google key (drop-in mode)', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'OK' });
    const res = await h.proxy.inject(
      `/google-maps/maps/api/geocode/json?address=Sofia&key=${token}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-brake-cost-micros']).toBe('5000');
    const up = new URL(mock.last().url, 'http://x');
    expect(up.pathname).toBe('/maps/api/geocode/json');
    expect(up.searchParams.getAll('key')).toEqual([REAL_KEY]);
    expect(up.searchParams.get('address')).toBe('Sofia');

    const viaHeader = await h.proxy.inject({
      method: 'GET',
      url: '/google-places/v1/places/ChIJ1',
      headers: { 'x-goog-api-key': token, 'x-goog-fieldmask': 'id' },
    });
    expect(viaHeader.statusCode).toBe(200);
    expect(mock.last().headers['x-goog-api-key']).toBe(REAL_KEY);
  });
});

describe('error contract', () => {
  it('401 for missing, unknown, revoked, expired or wrong-IP keys', async () => {
    const org = newOrg();
    const missing = await h.proxy.inject('/google-maps/maps/api/geocode/json?address=x');
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: 'invalid_key' });
    expect(missing.headers['x-brake-request-id']).toBeDefined();
    expect(missing.headers['x-brake-cost-micros']).toBe('0');

    expect((await textSearch('sb_live_0000000000000000000000')).statusCode).toBe(401);
    const revoked = await newKey(h, org);
    await h.registry.revokeKey(revoked.token);
    expect((await textSearch(revoked.token)).statusCode).toBe(401);
    const expired = await newKey(h, org, { expiresAt: '2026-10-01T00:00:00.000Z' });
    expect((await textSearch(expired.token)).statusCode).toBe(401);
    const ip = await newKey(h, org, { allowedIps: ['10.9.9.9'] });
    expect((await textSearch(ip.token)).statusCode).toBe(401);
    const ipOk = await newKey(h, org, { allowedIps: ['127.0.0.1'] });
    expect((await textSearch(ipOk.token)).statusCode).toBe(200);
  });

  it('402 budget_exceeded names the scope and nothing reaches Google', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org, { name: 'web app' });
    await engine.setCap(org, { kind: 'key', id }, 'd', { hard: 50_000n, soft: null });
    expect((await textSearch(token)).statusCode).toBe(200);
    const before = mock.seen.length;
    const res = await textSearch(token);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({
      error: 'budget_exceeded',
      message: `Spend cap reached for key "web app" (${id}). Stop and ask the user to raise the cap.`,
      scope: `key:${id}`,
      window: 'd:20261029',
      cap: 50_000,
      spent: 32_000,
      resetsAt: '2026-10-30T00:00:00.000Z',
    });
    expect(mock.seen.length).toBe(before);
    expect(res.headers['x-brake-remaining-micros']).toBe('18000');
    const blocked = (await events(org)).find((e) => e.type === 'blocked');
    expect(blocked).toMatchObject({ reason: 'budget_exceeded', firstDeny: '1' });
  });

  it('402 unpriced_route by default, or the default price when the org allows it', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    const res = await h.proxy.inject(`/google-maps/maps/api/staticmap?center=Sofia&key=${token}`);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'unpriced_route' });

    const org2 = newOrg();
    await h.registry.putOrg({
      id: org2,
      providers: {
        'google-maps': { unpricedPolicy: 'allow-with-default-price', defaultPriceMicros: '9000' },
      },
    });
    const k2 = await newKey(h, org2);
    mock.respond = (_req, reply) => reply.send('png');
    const ok = await h.proxy.inject(`/google-maps/maps/api/staticmap?center=Sofia&key=${k2.token}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-brake-cost-micros']).toBe('9000');
  });

  it('403 killed for org, provider, key and session targets', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org, { sessionCapMicros: '100000000' });
    await engine.kill(org, { kind: 'key', id });
    const res = await textSearch(token);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'killed', target: `key:${id}` });
    expect(res.json<{ message: string }>().message).toBe(
      `Spending is switched off for key ${id}. Stop.`,
    );
    // A named key is named, with its id kept for support.
    const named = await newKey(h, org, { name: 'store "locator"\nv2' });
    await engine.kill(org, { kind: 'key', id: named.id });
    expect((await textSearch(named.token)).json()).toEqual({
      error: 'killed',
      message: `Spending is switched off for key "store "locator" v2" (${named.id}). Stop.`,
      target: `key:${named.id}`,
    });
    await engine.unkill(org, { kind: 'key', id });
    await engine.kill(org, { kind: 'sess', id: 'bad-run' });
    expect((await textSearch(token, { 'x-brake-session': 'bad-run' })).statusCode).toBe(403);
    expect((await textSearch(token, { 'x-brake-session': 'good-run' })).statusCode).toBe(200);
    await engine.kill(org, { kind: 'prov', name: 'google-maps' });
    expect((await textSearch(token)).json()).toMatchObject({ target: 'prov:google-maps' });
  });

  it('403 sku_not_allowed for SKUs or providers the key may not use', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org, { skus: ['geocoding'] });
    expect((await textSearch(token)).json()).toMatchObject({ error: 'sku_not_allowed' });
    const none = await newKey(h, org, { name: 'ci', credentials: { other: 'cred-x' } });
    const res = await textSearch(none.token);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ message: string }>().message).toBe(
      `Key "ci" (${none.id}) may not call provider google-maps.`,
    );
  });

  it('429 loop_detected with Retry-After after identical requests', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org, {
      name: 'web app',
      loop: { identical: 3, windowSec: 60, perMinute: 1000, cooldownSec: 600 },
    });
    const same = () =>
      h.proxy.inject(`/google-maps/maps/api/geocode/json?address=same&key=${token}`);
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'OK' });
    for (let i = 0; i < 3; i++) expect((await same()).statusCode).toBe(200);
    const res = await same();
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('600');
    expect(res.json()).toMatchObject({ error: 'loop_detected', retryAfter: 600, reason: 'loop' });
    expect(res.json<{ message: string }>().message).toBe(
      `Repeated requests detected; key "web app" (${id}) is paused for all providers. Stop and ask the user.`,
    );
    expect((await events(org)).some((e) => e.type === 'loop')).toBe(true);
  });

  it('400 for a malformed session id and 404 for unknown prefixes', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org, { sessionCapMicros: '100000000' });
    expect((await textSearch(token, { 'x-brake-session': 'bad id!' })).statusCode).toBe(400);
    const noSessions = await newKey(h, org);
    const res400 = await textSearch(noSessions.token, { 'x-brake-session': 'run-1' });
    expect(res400.statusCode).toBe(400);
    expect(res400.json()).toMatchObject({ error: 'invalid_request' });
    const res = await h.proxy.inject(`/elsewhere/v1/x?key=${token}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'unknown_route' });
  });
});

describe('upstream behaviour', () => {
  it('refunds 4xx and 5xx responses Google does not bill', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    for (const status of [400, 403, 404, 500, 503]) {
      mock.respond = (_req, reply) => reply.code(status).send({ error: { code: status } });
      const res = await textSearch(token);
      expect(res.statusCode).toBe(status);
      expect(res.headers['x-brake-cost-micros']).toBe('0');
    }
    expect(await spent(org)).toBe(0n);
    expect(await h.valkey.get(`bk:{o:${org}}:held:org:d:20261029`)).toBe('0');
  });

  it('flags usage events when Google rejects the real key', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) =>
      reply.code(400).send({
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      });
    const res = await textSearch(token);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { details: [{ reason: 'API_KEY_INVALID' }] } });
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'REQUEST_DENIED' });
    await h.proxy.inject(`/google-maps/maps/api/geocode/json?address=x&key=${token}`);
    mock.respond = (_req, reply) => reply.code(400).send({ error: { message: 'bad query' } });
    await textSearch(token);
    const flagged = (await events(org)).filter((e) => e.keyError === '1');
    expect(flagged.map((e) => e.status)).toEqual(['400', '200']);
  });

  it('names the missing provider key when a credential was deleted, and sends nothing', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org, {
      name: 'web app',
      credentials: { 'google-maps': 'cred-deleted' },
    });
    let reached = false;
    mock.respond = (_req, reply) => {
      reached = true;
      return reply.send({ results: [], status: 'OK' });
    };
    const res = await h.proxy.inject(`/google-maps/maps/api/geocode/json?address=x&key=${token}`);
    expect(res.statusCode).toBe(502);
    expect(res.json<{ message: string }>().message).toContain(
      `The google-maps provider key that Spend Brake key "web app" (${id}) uses was deleted`,
    );
    expect(reached).toBe(false);
    const [usage] = (await events(org)).filter((e) => e.type === 'usage');
    expect(usage).toMatchObject({ error: 'credential_unavailable', status: '0' });
  });

  it('marks a refusal inside a 200 (legacy JSON status) as a provider error', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    for (const status of ['OVER_QUERY_LIMIT', 'INVALID_REQUEST', 'OK', 'ZERO_RESULTS']) {
      mock.respond = (_req, reply) => reply.send({ results: [], status });
      const res = await h.proxy.inject(`/google-maps/maps/api/geocode/json?address=x&key=${token}`);
      expect(res.statusCode).toBe(200);
    }
    const usage = (await events(org)).filter((e) => e.type === 'usage');
    expect(usage.map((e) => e.providerError ?? null)).toEqual([
      'OVER_QUERY_LIMIT',
      'INVALID_REQUEST',
      null,
      null,
    ]);
  });

  it('commits worst case on a timeout, since Google may have billed', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = async (_req, reply) => {
      await new Promise((r) => setTimeout(r, 1_500));
      return reply.send({ places: [] });
    };
    const res = await textSearch(token);
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: 'upstream_timeout' });
    expect(res.headers['x-brake-cost-micros']).toBe('32000');
    expect(await spent(org)).toBe(32_000n);
  });

  it('refunds when the provider cannot be reached at all', async () => {
    const dead = await startProxy(valkeyUrl, mock, {
      upstreamOverrides: { 'https://places.googleapis.com': 'http://127.0.0.1:1' },
    });
    const org = newOrg();
    const { token } = await newKey(dead, org);
    const res = await dead.proxy.inject({
      method: 'POST',
      url: '/google-places/v1/places:searchText',
      headers: { 'x-brake-key': token, 'x-goog-fieldmask': 'places.displayName' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(502);
    expect(res.headers['x-brake-cost-micros']).toBe('0');
    await dead.proxy.brakeDrain();
    expect(await h.valkey.get(`bk:{o:${org}}:spent:org:d:20261029`)).toBe('0');
    expect(await h.valkey.get(`bk:{o:${org}}:held:org:d:20261029`)).toBe('0');
    await dead.proxy.close();
    await dead.valkey.quit();
  });

  it('passes gzip bodies through untouched and prices from the decoded body', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    const denied = gzipSync(JSON.stringify({ results: [], status: 'REQUEST_DENIED' }));
    mock.respond = (_req, reply) =>
      reply
        .header('content-encoding', 'gzip')
        .header('content-type', 'application/json; charset=UTF-8')
        .send(denied);
    const res = await h.proxy.inject({
      method: 'GET',
      url: `/google-maps/maps/api/geocode/json?address=x&key=${token}`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toMatchObject({
      status: 'REQUEST_DENIED',
    });
    expect(res.headers['x-brake-cost-micros']).toBe('0');

    const ok = gzipSync(JSON.stringify({ results: [{}], status: 'OK' }));
    mock.respond = (_req, reply) =>
      reply.header('content-encoding', 'gzip').header('content-type', 'application/json').send(ok);
    const res2 = await h.proxy.inject({
      method: 'GET',
      url: `/google-maps/maps/api/geocode/json?address=y&key=${token}`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res2.headers['x-brake-cost-micros']).toBe('5000');
    expect(await spent(org)).toBe(5_000n);
  });

  it('streams chunked bodies to the client', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    const { Readable } = await import('node:stream');
    mock.respond = (_req, reply) => {
      const chunks = ['{"places":[', '{"id":"a"},', '{"id":"b"}', ']}'];
      const stream = new Readable({
        read() {
          const next = chunks.shift();
          setTimeout(() => this.push(next ?? null), 5);
        },
      });
      return reply.header('content-type', 'application/json').send(stream);
    };
    const res = await textSearch(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ places: [{ id: 'a' }, { id: 'b' }] });
  });

  it('bills a route matrix by origins x destinations even from a streamed, cut-short body', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) =>
      reply
        .header('content-type', 'application/json')
        .send([{ originIndex: 0, destinationIndex: 0 }]);
    const res = await h.proxy.inject({
      method: 'POST',
      url: '/google-routes/distanceMatrix/v2:computeRouteMatrix',
      headers: { 'x-brake-key': token, 'content-type': 'application/json' },
      payload: JSON.stringify({
        origins: [{ waypoint: { address: 'A' } }, { waypoint: { address: 'B' } }],
        destinations: [{ waypoint: { address: 'C' } }],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-brake-cost-micros']).toBe('10000');
  });

  it('bills photo redirects and passes the Location header', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) => reply.redirect('https://lh3.googleusercontent.com/p/abc', 302);
    const res = await h.proxy.inject(
      `/google-places/v1/places/ChIJ1/photos/AUc/media?maxWidthPx=400&key=${token}`,
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://lh3.googleusercontent.com/p/abc');
    expect(res.headers['x-brake-cost-micros']).toBe('7000');
  });

  it('charges a legacy autocomplete session once', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) => reply.send({ predictions: [], status: 'OK' });
    const ac = (input: string) =>
      h.proxy.inject(
        `/google-maps/maps/api/place/autocomplete/json?input=${input}&sessiontoken=tok-1&key=${token}`,
      );
    expect((await ac('p')).headers['x-brake-cost-micros']).toBe('17000');
    await h.proxy.brakeDrain();
    expect((await ac('pi')).headers['x-brake-cost-micros']).toBe('0');
    expect((await ac('piz')).headers['x-brake-cost-micros']).toBe('0');
  });
});

describe('budgets', () => {
  it('creates a session budget from the key template and enforces it', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org, { sessionCapMicros: '70000' });
    const run = { 'x-brake-session': 'agent-run-7' };
    expect((await textSearch(token, run)).statusCode).toBe(200);
    expect((await textSearch(token, run)).statusCode).toBe(200);
    const res = await textSearch(token, run);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({
      scope: 'sess:agent-run-7',
      window: 'm:202610',
      cap: 70_000,
    });
    // Another session on the same key has its own budget.
    expect((await textSearch(token, { 'x-brake-session': 'agent-run-8' })).statusCode).toBe(200);
  });

  it('reserves full price with trustFreeTier and keeps counting units past the allowance', async () => {
    const org = newOrg();
    await h.registry.putOrg({ id: org, providers: { 'google-maps': { trustFreeTier: true } } });
    const { token, id } = await newKey(h, org);
    await engine.setCap(org, { kind: 'key', id }, 'd', { hard: 10_000n, soft: null });
    // 1 of the 10,000 free Geocoding requests left this month.
    await h.valkey.set(`bk:{o:${org}}:units:geocoding:m:202610`, '9999');
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'OK' });
    const costs: string[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await h.proxy.inject(
        `/google-maps/maps/api/geocode/json?address=f${i}&key=${token}`,
      );
      statuses.push(res.statusCode);
      costs.push(String(res.headers['x-brake-cost-micros']));
      await h.proxy.brakeDrain();
    }
    // Free, then list price; the 4th does not fit the 10,000-micro cap.
    expect(statuses).toEqual([200, 200, 200, 402]);
    expect(costs.slice(0, 3)).toEqual(['0', '5000', '5000']);
    expect(await h.valkey.get(`bk:{o:${org}}:units:geocoding:m:202610`)).toBe('10002');
    expect(await spent(org, `key:${id}`)).toBe(10_000n);
  });

  it('counts units for billed requests without trustFreeTier', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'OK' });
    await h.proxy.inject(`/google-maps/maps/api/geocode/json?address=u1&key=${token}`);
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'REQUEST_DENIED' });
    await h.proxy.inject(`/google-maps/maps/api/geocode/json?address=u2&key=${token}`);
    await h.proxy.brakeDrain();
    expect(await h.valkey.get(`bk:{o:${org}}:units:geocoding:m:202610`)).toBe('1');
  });

  it('prices a route matrix whatever the body content type says', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org);
    await engine.setCap(org, { kind: 'key', id }, 'd', { hard: 1n, soft: null });
    const matrix = JSON.stringify({
      origins: Array.from({ length: 25 }, () => ({ waypoint: { address: 'A' } })),
      destinations: Array.from({ length: 25 }, () => ({ waypoint: { address: 'B' } })),
    });
    const before = mock.seen.length;
    for (const [type, body] of [
      ['Application/JSON', matrix],
      ['text/plain', matrix],
      ['application/json', `\uFEFF${matrix}`],
      ['application/json', '{not json'],
    ] as const) {
      const res = await h.proxy.inject({
        method: 'POST',
        url: '/google-routes/distanceMatrix/v2:computeRouteMatrix',
        headers: { 'x-brake-key': token, 'content-type': type },
        payload: body,
      });
      expect(res.statusCode, type).toBe(402);
    }
    expect(mock.seen.length).toBe(before);
  });

  it('emits threshold crossings with the usage event', async () => {
    const org = newOrg();
    const { token, id } = await newKey(h, org);
    await engine.setCap(org, { kind: 'key', id }, 'd', { hard: 60_000n, soft: null });
    await textSearch(token);
    const ev = (await events(org)).find((e) => e.type === 'usage');
    expect(JSON.parse(ev!.crossings!)).toEqual([
      { scope: `key:${id}`, window: 'd:20261029', mark: '50' },
    ]);
  });
});

describe('security', () => {
  it('never lets the path pick another host', async () => {
    const { upstreamUrl } = await import('../src/forward.js');
    for (const path of [
      '//evil.example.com/x',
      '/@evil.example.com/x',
      '/..//evil.example.com',
      '/\\evil.example.com/x',
      '/%2e%2e/x',
    ]) {
      expect(upstreamUrl('https://maps.googleapis.com', path, new URLSearchParams()).origin).toBe(
        'https://maps.googleapis.com',
      );
    }
    expect(() =>
      upstreamUrl('https://maps.googleapis.com', 'evil.example.com/x', new URLSearchParams()),
    ).toThrow();

    // Through the proxy, with an org that forwards unpriced routes so the request is sent.
    const org = newOrg();
    await h.registry.putOrg({
      id: org,
      providers: {
        'google-maps': { unpricedPolicy: 'allow-with-default-price', defaultPriceMicros: '1' },
      },
    });
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) => reply.send({});
    for (const path of ['//evil.example.com/x', '/@evil.example.com/x']) {
      const before = mock.seen.length;
      const res = await h.proxy.inject(`/google-maps${path}?key=${token}`);
      expect(res.statusCode).toBe(200);
      // The request reached the maps.googleapis.com stand-in, with the path as a path.
      expect(mock.seen.length).toBe(before + 1);
      expect(mock.last().url.startsWith(path)).toBe(true);
      expect(mock.last().headers.host).toBe(new URL(mock.url).host);
    }
  });

  it('keeps virtual keys and provider secrets out of logs, events and error bodies', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) => reply.code(500).send({ error: 'boom' });
    const bodies: string[] = [];
    bodies.push(
      (await h.proxy.inject(`/google-maps/maps/api/geocode/json?address=x&key=${token}`)).body,
    );
    bodies.push((await textSearch(token)).body);
    bodies.push((await h.proxy.inject(`/nowhere?key=${token}`)).body);
    bodies.push(
      (await h.proxy.inject(`/google-maps/maps/api/geocode/json?key=${token.slice(0, -1)}X`)).body,
    );
    const evs = JSON.stringify(await events(org));
    const logs = h.logs.text();
    expect(logs.length).toBeGreaterThan(0);
    for (const text of [logs, evs, ...bodies]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(REAL_KEY);
    }
    expect(logs).toContain('[redacted]');
  });
});

describe('Valkey outage', () => {
  it('fails closed by default and fails open within the allowance when configured', async () => {
    const side = await startProxy(valkeyUrl, mock, { configTtlMs: 1 });
    const org = newOrg();
    const closed = await newKey(side, org);
    const open = await newKey(side, org, { failOpenMicros: '40000' });
    mock.respond = (_req, reply) => reply.send({ places: [] });
    const call = (t: string) =>
      side.proxy.inject({
        method: 'POST',
        url: '/google-places/v1/places:searchText',
        headers: { 'x-brake-key': t, 'x-goog-fieldmask': 'places.displayName' },
        payload: '{}',
      });
    // Warm the config cache, then cut Valkey off.
    expect((await call(closed.token)).statusCode).toBe(200);
    expect((await call(open.token)).statusCode).toBe(200);
    await side.proxy.brakeDrain();
    side.valkey.disconnect();

    const c = await call(closed.token);
    expect(c.statusCode).toBe(503);
    expect(c.json()).toMatchObject({ error: 'budget_unavailable' });

    const o = await call(open.token);
    expect(o.statusCode).toBe(200);
    expect(o.headers['x-brake-fail-open']).toBe('1');
    expect(o.headers['x-brake-cost-micros']).toBe('32000');
    const o2 = await call(open.token);
    expect(o2.statusCode).toBe(402);
    expect(o2.json()).toMatchObject({ cap: 40_000, spent: 32_000 });
    expect(o2.headers['x-brake-remaining-micros']).toBe('0');

    // Valkey is back: the fail-open spend is recorded and shows up in the ledger stream.
    side.valkey.connect().catch(() => undefined);
    await new Promise<void>((r) => side.valkey.once('ready', () => r()));
    expect(await side.proxy.brakeReplayFailOpen()).toBe(1);
    expect(await h.valkey.get(`bk:{o:${org}}:spent:key:${open.id}:d:20261029`)).toBe('64000');
    const evs = await events(org);
    expect(evs.filter((e) => e.failOpen === '1')).toHaveLength(1);
    await side.proxy.close();
  });
});

describe('metrics', () => {
  it('counts requests by outcome and records latencies', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    await engine.kill(org, { kind: 'org' });
    await textSearch(token);
    const text = await h.proxy.brakeMetrics.registry.metrics();
    expect(text).toMatch(
      /brake_requests_total\{provider="google-maps",sku="places.text_search.pro",outcome="killed"\} \d+/,
    );
    expect(text).toMatch(
      /brake_requests_total\{provider="google-maps",sku="places.text_search.pro",outcome="ok"\} \d+/,
    );
    expect(text).toContain('brake_reserve_latency_ms_bucket');
    expect(text).toContain('brake_upstream_latency_ms_bucket');
  });
});

describe('encrypted provider credentials', () => {
  it('decrypts the credential the admin API stored, only for its own org', async () => {
    const { randomBytes } = await import('node:crypto');
    const { LocalKeyWrapper, credentialContext, encryptSecret } =
      await import('@spend-brake/shared');
    const { Registry } = await import('@spend-brake/budget');
    const { EnvelopeSecretStore } = await import('../src/secrets.js');
    const wrapper = new LocalKeyWrapper(randomBytes(32).toString('base64'));
    const registry = new Registry(h.valkey);
    const sealed = startProxy(valkeyUrl, mock, {
      secrets: new EnvelopeSecretStore(registry, wrapper),
    });
    const s = await sealed;
    const org = newOrg();
    const other = newOrg();
    const secret = 'AIzaSy-encrypted-at-rest';
    await registry.putCredential({
      id: 'cred-enc',
      orgId: org,
      provider: 'google-maps',
      envelope: await encryptSecret(wrapper, secret, credentialContext(org, 'cred-enc')),
    });
    const mine = await newKey(s, org, { credentials: { 'google-maps': 'cred-enc' } });
    const theirs = await newKey(s, other, { credentials: { 'google-maps': 'cred-enc' } });
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'OK' });

    const ok = await s.proxy.inject(
      `/google-maps/maps/api/geocode/json?address=a&key=${mine.token}`,
    );
    expect(ok.statusCode).toBe(200);
    expect(new URL(mock.last().url, 'http://x').searchParams.get('key')).toBe(secret);

    const before = mock.seen.length;
    const denied = await s.proxy.inject(
      `/google-maps/maps/api/geocode/json?address=b&key=${theirs.token}`,
    );
    expect(denied.statusCode).toBe(502);
    expect(denied.json()).toMatchObject({ error: 'upstream_unavailable' });
    expect(mock.seen.length).toBe(before);
    expect(s.logs.text()).not.toContain(secret);
    await s.proxy.close();
    await s.valkey.quit();
  });
});
