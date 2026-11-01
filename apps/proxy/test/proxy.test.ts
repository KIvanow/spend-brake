import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as zlib from 'node:zlib';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
} from 'node:zlib';
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
import type { ProxyDeps } from '../src/server.js';

// zlib's zstd arrived in Node 22.15 / 23.8.
const ZSTD = typeof zlib.zstdDecompress === 'function';

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

  it('trusts X-Forwarded-For only from a private hop for allowedIps', async () => {
    const side = await startProxy(valkeyUrl, mock, { trustProxy: true });
    const org = newOrg();
    const { token } = await newKey(side, org, { allowedIps: ['198.51.100.7'] });
    const call = (remoteAddress: string) =>
      side.proxy.inject({
        method: 'POST',
        url: '/google-places/v1/places:searchText',
        remoteAddress,
        headers: {
          'x-brake-key': token,
          'x-goog-fieldmask': 'places.displayName',
          'x-forwarded-for': '198.51.100.7',
        },
        payload: '{}',
      });
    // A client on the internet cannot claim the allowed address itself...
    expect((await call('203.0.113.9')).statusCode).toBe(401);
    // ...but the address a private hop in front (Caddy) forwards is used.
    expect((await call('10.0.0.2')).statusCode).toBe(200);
    expect((await call('127.0.0.1')).statusCode).toBe(200);
    await side.proxy.close();
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
    // Bidi overrides and isolates are dropped too, so a name cannot reorder the message.
    const bidi = await newKey(h, org, { name: 'ops\u202Eevil\u2066 x\u2069\u200F' });
    await engine.kill(org, { kind: 'key', id: bidi.id });
    expect((await textSearch(bidi.token)).json<{ message: string }>().message).toBe(
      `Spending is switched off for key "opsevil x" (${bidi.id}). Stop.`,
    );
    // Line and paragraph separators become spaces; zero-width characters are dropped.
    const hidden = await newKey(h, org, {
      name: 'a\u2028b\u2029c\u200Bd\u200Ce\u200Df\u2060g\uFEFFh',
    });
    await engine.kill(org, { kind: 'key', id: hidden.id });
    expect((await textSearch(hidden.token)).json<{ message: string }>().message).toBe(
      `Spending is switched off for key "a b cdefgh" (${hidden.id}). Stop.`,
    );
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

  it('refuses a compressed body that inflates past the limit and charges the worst case', async () => {
    const small = await startProxy(valkeyUrl, mock, { maxBufferedBytes: 4096 });
    const org = newOrg();
    const { token } = await newKey(small, org);
    // A few hundred bytes on the wire, 1 MB once inflated.
    const bomb = gzipSync(JSON.stringify({ status: 'REQUEST_DENIED', pad: ' '.repeat(1 << 20) }));
    mock.respond = (_req, reply) =>
      reply
        .header('content-encoding', 'gzip')
        .header('content-type', 'application/json')
        .send(bomb);
    const res = await small.proxy.inject(
      `/google-maps/maps/api/geocode/json?address=x&key=${token}`,
    );
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'upstream_unavailable' });
    expect(res.headers['x-brake-cost-micros']).toBe('5000');
    await small.proxy.brakeDrain();
    expect(await spent(org)).toBe(5_000n);
    await small.proxy.close();
  });

  const codecs = [
    { name: 'deflate', encode: deflateSync, decode: inflateSync, run: true },
    { name: 'br', encode: brotliCompressSync, decode: brotliDecompressSync, run: true },
    { name: 'zstd', encode: zlib.zstdCompressSync, decode: zlib.zstdDecompressSync, run: ZSTD },
  ];
  for (const { name, encode, decode, run } of codecs) {
    it.runIf(run)(`prices from a ${name} body and refuses a ${name} bomb`, async () => {
      const small = await startProxy(valkeyUrl, mock, { maxBufferedBytes: 4096 });
      const org = newOrg();
      const { token } = await newKey(small, org);
      let body = encode(Buffer.from(JSON.stringify({ results: [], status: 'REQUEST_DENIED' })));
      mock.respond = (_req, reply) =>
        reply
          .header('content-encoding', name)
          .header('content-type', 'application/json')
          .send(body);
      const geocode = () =>
        small.proxy.inject({
          method: 'GET',
          url: `/google-maps/maps/api/geocode/json?address=x&key=${token}`,
          headers: { 'accept-encoding': name },
        });
      const res = await geocode();
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe(name);
      expect(JSON.parse(decode(res.rawPayload).toString())).toMatchObject({
        status: 'REQUEST_DENIED',
      });
      expect(res.headers['x-brake-cost-micros']).toBe('0');
      expect(mock.last().headers['accept-encoding']).toBe(name);

      body = encode(Buffer.from(JSON.stringify({ status: 'OK', pad: ' '.repeat(1 << 20) })));
      const bomb = await geocode();
      expect(bomb.statusCode).toBe(502);
      expect(bomb.headers['x-brake-cost-micros']).toBe('5000');
      await small.proxy.brakeDrain();
      expect(await spent(org)).toBe(5_000n);
      await small.proxy.close();
    });
  }

  it('asks the provider for no zstd when this Node cannot decode it', async () => {
    const side = await startProxy(valkeyUrl, mock, { zstd: false });
    const org = newOrg();
    const { token } = await newKey(side, org);
    mock.respond = (_req, reply) => reply.send({ results: [{}], status: 'OK' });
    const geocode = (acceptEncoding: string) =>
      side.proxy.inject({
        method: 'GET',
        url: `/google-maps/maps/api/geocode/json?address=x&key=${token}`,
        headers: { 'accept-encoding': acceptEncoding },
      });
    expect((await geocode('zstd, br;q=0.9, gzip')).statusCode).toBe(200);
    expect(mock.last().headers['accept-encoding']).toBe('br;q=0.9, gzip');
    // Nothing left that the provider may use but identity.
    expect((await geocode('ZSTD')).statusCode).toBe(200);
    expect(mock.last().headers['accept-encoding']).toBe('identity');
    await side.proxy.close();
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

  it('ends a legacy autocomplete session on Place Details and past its window', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = (_req, reply) => reply.send({ predictions: [], result: {}, status: 'OK' });
    const ac = (input: string, session = 'tok-2') =>
      h.proxy.inject(
        `/google-maps/maps/api/place/autocomplete/json?input=${input}&sessiontoken=${session}&key=${token}`,
      );
    const cost = async (input: string, session?: string) => {
      const res = await ac(input, session);
      await h.proxy.brakeDrain();
      return res.headers['x-brake-cost-micros'];
    };
    expect(await cost('p')).toBe('17000');
    expect(await cost('pi')).toBe('0');
    await h.proxy.inject(
      `/google-maps/maps/api/place/details/json?place_id=x&fields=place_id&sessiontoken=tok-2&key=${token}`,
    );
    await h.proxy.brakeDrain();
    // Closed: Google bills a reused token per request, as if it had none.
    expect(await cost('piz')).toBe('2830');
    // A session older than Google's window bills each request on its own.
    expect(await cost('p', 'tok-3')).toBe('17000');
    const hash = createHash('sha256').update('tok-3').digest('hex').slice(0, 32);
    await h.valkey.expire(`bk:{o:${org}}:bsess:google-maps:${hash}`, 400);
    expect(await cost('pi', 'tok-3')).toBe('2830');
  });

  it('keeps a session closed when an autocomplete in flight records after Place Details', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    mock.respond = async (req, reply) => {
      if (req.url.includes('input=slow')) await new Promise((r) => setTimeout(r, 200));
      return reply.send({ predictions: [], result: {}, status: 'OK' });
    };
    const ac = (input: string) =>
      h.proxy.inject(
        `/google-maps/maps/api/place/autocomplete/json?input=${input}&sessiontoken=tok-4&key=${token}`,
      );
    expect((await ac('p')).headers['x-brake-cost-micros']).toBe('17000');
    await h.proxy.brakeDrain();
    const slow = ac('slow');
    await new Promise((r) => setTimeout(r, 50));
    await h.proxy.inject(
      `/google-maps/maps/api/place/details/json?place_id=x&fields=place_id&sessiontoken=tok-4&key=${token}`,
    );
    await h.proxy.brakeDrain();
    // The slow request settles after the close and must not start the session over.
    expect((await slow).headers['x-brake-cost-micros']).toBe('0');
    await h.proxy.brakeDrain();
    const next = await ac('pizza');
    expect(next.headers['x-brake-cost-micros']).toBe('2830');
  });
});

describe('budgets', () => {
  it('counts every SKU of a request against its own SKU cap', async () => {
    const org = newOrg();
    const { token } = await newKey(h, org);
    const atmosphere = {
      kind: 'sku',
      provider: 'google-maps',
      sku: 'legacy.places.atmosphere_data',
    } as const;
    // Text Search (Legacy) bills its base SKU plus Contact (3,000) and Atmosphere (5,000) Data.
    await engine.setCap(org, atmosphere, 'd', { hard: 7_000n, soft: null });
    mock.respond = (_req, reply) => reply.send({ results: [], status: 'OK' });
    const search = () =>
      h.proxy.inject(`/google-maps/maps/api/place/textsearch/json?query=pizza&key=${token}`);
    const first = await search();
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-brake-cost-micros']).toBe('40000');
    expect(await spent(org, 'sku:google-maps:legacy.places.atmosphere_data')).toBe(5_000n);
    expect(await spent(org, 'sku:google-maps:legacy.places.contact_data')).toBe(3_000n);
    expect(await spent(org, 'sku:google-maps:legacy.places.text_search')).toBe(32_000n);
    expect(await spent(org)).toBe(40_000n);
    const second = await search();
    expect(second.statusCode).toBe(402);
    expect(second.json()).toMatchObject({ scope: 'sku:google-maps:legacy.places.atmosphere_data' });
  });

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
    // Only the explicit replay below runs: a timer replay racing it would record twice or first.
    const side = await startProxy(valkeyUrl, mock, { configTtlMs: 1, replayIntervalMs: 3_600_000 });
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
    // disconnect() only half-closes the socket: the client stays "ready" (refusing commands) until
    // the server closes its side. Wait for "end", or connect() below finds it still connected.
    const ended = new Promise<void>((r) => side.valkey.once('end', () => r()));
    side.valkey.disconnect();
    await ended;

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
    // Resolves once the client is ready again, and rejects (rather than hangs) if it cannot be.
    await side.valkey.connect();
    expect(await side.proxy.brakeReplayFailOpen()).toBe(1);
    expect(await h.valkey.get(`bk:{o:${org}}:spent:key:${open.id}:d:20261029`)).toBe('64000');
    const evs = await events(org);
    expect(evs.filter((e) => e.failOpen === '1')).toHaveLength(1);
    await side.proxy.close();
  });

  it('reports not ready while Valkey is unreachable, and stays live', async () => {
    const side = await startProxy(valkeyUrl, mock);
    expect((await side.proxy.inject('/readyz')).statusCode).toBe(200);
    const ended = new Promise<void>((r) => side.valkey.once('end', () => r()));
    side.valkey.disconnect();
    await ended;
    const res = await side.proxy.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, valkey: false });
    expect((await side.proxy.inject('/healthz')).statusCode).toBe(200);
    await side.proxy.close();
  });

  /** A proxy with fail-open spend in its journal and Valkey cut off. */
  async function outage(extra: Partial<ProxyDeps>) {
    const side = await startProxy(valkeyUrl, mock, {
      configTtlMs: 1,
      replayIntervalMs: 3_600_000,
      ...extra,
    });
    const org = newOrg();
    const open = await newKey(side, org, { failOpenMicros: '40000' });
    mock.respond = (_req, reply) => reply.send({ places: [] });
    const call = () =>
      side.proxy.inject({
        method: 'POST',
        url: '/google-places/v1/places:searchText',
        headers: { 'x-brake-key': open.token, 'x-goog-fieldmask': 'places.displayName' },
        payload: '{}',
      });
    expect((await call()).statusCode).toBe(200);
    await side.proxy.brakeDrain();
    const ended = new Promise<void>((r) => side.valkey.once('end', () => r()));
    side.valkey.disconnect();
    await ended;
    expect((await call()).headers['x-brake-fail-open']).toBe('1');
    return { side, org, open };
  }

  it('records fail-open spend once when replays overlap on a slow Valkey', async () => {
    const { side, org, open } = await outage({ replayIntervalMs: 10 });
    await side.valkey.connect();
    // Every script call takes longer than several timer ticks.
    const evalsha = side.valkey.evalsha.bind(side.valkey);
    side.valkey.evalsha = ((...args: Parameters<typeof evalsha>) =>
      new Promise((r) => setTimeout(r, 80)).then(() => evalsha(...args))) as typeof evalsha;
    await new Promise((r) => setTimeout(r, 300));
    // Two explicit replays of the same entry at once (a timer tick racing a shutdown).
    await Promise.all([side.proxy.brakeReplayFailOpen(), side.proxy.brakeReplayFailOpen()]);
    await side.proxy.close();
    expect(await h.valkey.get(`bk:{o:${org}}:spent:key:${open.id}:d:20261029`)).toBe('64000');
    expect((await events(org)).filter((e) => e.failOpen === '1')).toHaveLength(1);
  });

  it('records fail-open spend on shutdown once Valkey is back', async () => {
    const { side, org, open } = await outage({});
    await side.valkey.connect();
    await side.proxy.close();
    expect(await h.valkey.get(`bk:{o:${org}}:spent:key:${open.id}:d:20261029`)).toBe('64000');
  });

  it('keeps fail-open spend in a file across a restart while Valkey is down', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'brake-journal-')), 'state');
    const { side, org, open } = await outage({ failOpenJournalDir: dir });
    await side.proxy.close();
    const files = await readdir(dir);
    expect(files).toEqual([expect.stringMatching(/^fail-open-.+\.json$/)]);
    expect(JSON.parse(await readFile(join(dir, files[0]!), 'utf8'))).toHaveLength(1);

    // Two proxies start on the same directory: only one claims the file.
    const opts = { replayIntervalMs: 3_600_000, failOpenJournalDir: dir };
    const a = await startProxy(valkeyUrl, mock, opts);
    const b = await startProxy(valkeyUrl, mock, opts);
    const replayed = (await a.proxy.brakeReplayFailOpen()) + (await b.proxy.brakeReplayFailOpen());
    expect(replayed).toBe(1);
    expect(await h.valkey.get(`bk:{o:${org}}:spent:key:${open.id}:d:20261029`)).toBe('64000');
    // Recorded, so the file is gone and a further restart replays nothing.
    expect(await readdir(dir)).toEqual([]);
    await Promise.all([a.proxy.close(), b.proxy.close()]);
    await rm(dirname(dir), { recursive: true });
  });

  it('replays a file a proxy killed mid-replay left claimed, once', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'brake-journal-')), 'state');
    const { side, org, open } = await outage({ failOpenJournalDir: dir });
    await side.proxy.close();
    // A proxy claims the file at start and is killed before it records it: no close, no save.
    const [file] = await readdir(dir);
    const claim = join(dir, `${file}.replaying-${randomUUID()}`);
    await rename(join(dir, file!), claim);

    // A fresh claim may still belong to a live proxy: it is left alone.
    const opts = { replayIntervalMs: 3_600_000, failOpenJournalDir: dir };
    const early = await startProxy(valkeyUrl, mock, opts);
    expect(await early.proxy.brakeReplayFailOpen()).toBe(0);
    await early.proxy.close();
    expect(await readdir(dir)).toEqual([basename(claim)]);

    // Past the grace period it is taken over, by only one of two proxies starting together.
    await new Promise((r) => setTimeout(r, 60));
    const stale = { ...opts, failOpenStaleClaimMs: 50 };
    const a = await startProxy(valkeyUrl, mock, stale);
    const b = await startProxy(valkeyUrl, mock, stale);
    const replayed = (await a.proxy.brakeReplayFailOpen()) + (await b.proxy.brakeReplayFailOpen());
    expect(replayed).toBe(1);
    expect(await h.valkey.get(`bk:{o:${org}}:spent:key:${open.id}:d:20261029`)).toBe('64000');
    expect(await readdir(dir)).toEqual([]);
    await Promise.all([a.proxy.close(), b.proxy.close()]);
    await rm(dirname(dir), { recursive: true });
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
