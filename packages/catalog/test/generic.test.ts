import { describe, expect, it } from 'vitest';
import { GenericAdapter, customApiRecordSchema, customApiSchema } from '../src/generic.js';
import type { OutgoingReq } from '../src/types.js';
import { req } from './helpers.js';

const adapter = new GenericAdapter({
  id: 'acme-search',
  prefix: '/acme',
  origin: 'https://api.acme.example',
  auth: { type: 'header', name: 'Authorization', valuePrefix: 'Bearer ' },
  routes: [
    { method: 'POST', path: '/v1/search', sku: 'search', pricePerRequest: '0.005' },
    { path: '/v1/items/*/enrich', sku: 'enrich', pricePerRequest: '0.10' },
    { method: 'GET', path: '/v2/**', sku: 'v2', pricePerRequest: '0.001' },
  ],
});

const classify = (method: string, path: string) =>
  adapter.classify(req(method, `https://api.acme.example${path}`));

describe('generic adapter', () => {
  it('prices matched routes per request', () => {
    const c = classify('POST', '/v1/search');
    expect(c.priced && adapter.worstCase(c)).toBe(5_000n);
    const e = classify('GET', '/v1/items/42/enrich');
    expect(e.priced && adapter.worstCase(e)).toBe(100_000n);
    const v2 = classify('GET', '/v2/a/b/c');
    expect(v2.priced && v2.items[0]!.sku).toBe('v2');
  });

  it('leaves unmatched routes unpriced', () => {
    expect(classify('GET', '/v1/search').priced).toBe(false);
    expect(classify('GET', '/v1/items/42/43/enrich').priced).toBe(false);
    expect(classify('GET', '/other').priced).toBe(false);
  });

  it('bills 2xx only by default', () => {
    const c = classify('POST', '/v1/search');
    if (!c.priced) throw new Error();
    expect(adapter.actual(c, { status: 200, headers: {} })).toBe(5_000n);
    expect(adapter.actual(c, { status: 429, headers: {} })).toBe(0n);
  });

  it('injects the credential', () => {
    const out: OutgoingReq = {
      origin: 'https://api.acme.example',
      headers: {},
      query: new URLSearchParams(),
    };
    adapter.injectCredential(out, 's3cret');
    expect(out.headers.authorization).toBe('Bearer s3cret');

    const q = new GenericAdapter({
      id: 'q',
      prefix: '/q',
      origin: 'https://q.example',
      auth: { type: 'query', name: 'api_key' },
      routes: [{ path: '/**', sku: 'any', pricePerRequest: '0.01' }],
    });
    const out2: OutgoingReq = {
      origin: 'https://q.example',
      headers: {},
      query: new URLSearchParams('api_key=client'),
    };
    q.injectCredential(out2, 's3cret');
    expect(out2.query.getAll('api_key')).toEqual(['s3cret']);
  });

  it('validates its config', () => {
    const base = {
      id: 'x',
      prefix: '/x',
      origin: 'https://x.example',
      auth: { type: 'query' as const, name: 'k' },
      routes: [{ path: '/a', sku: 'a', pricePerRequest: '0.01' }],
    };
    expect(() => new GenericAdapter({ ...base, origin: 'ftp://x.example' })).toThrow();
    expect(() => new GenericAdapter({ ...base, routes: [] })).toThrow();
    expect(
      () =>
        new GenericAdapter({ ...base, routes: [{ path: '/a', sku: 'a b', pricePerRequest: '1' }] }),
    ).toThrow();
    expect(
      () =>
        new GenericAdapter({ ...base, routes: [{ path: '/a', sku: 'a', pricePerRequest: '-1' }] }),
    ).toThrow();
  });
});

const custom = (routes: unknown[], extra: Record<string, unknown> = {}) =>
  GenericAdapter.fromCustomApi({
    id: 'acme',
    name: 'Acme',
    origin: 'https://api.acme.example',
    auth: { type: 'header', name: 'X-Api-Key' },
    routes,
    ...extra,
  });

const priced = (a: GenericAdapter, method: string, path: string) => {
  const c = a.classify(req(method, `https://api.acme.example${path}`));
  if (!c.priced) throw new Error('not priced');
  return c;
};

describe('custom API pricing', () => {
  const headerApi = custom([
    {
      method: 'POST',
      path: '/v1/run',
      sku: 'run',
      pricing: {
        model: 'reported',
        header: 'X-Credits-Used',
        usdPerUnit: '0.001',
        maxPerRequest: '0.50',
      },
    },
    { path: '/v1/flat', sku: 'flat', pricing: { model: 'perRequest', usd: '0.002' } },
  ]);
  const jsonApi = custom([
    {
      path: '/v1/**',
      sku: 'gen',
      pricing: {
        model: 'reported',
        jsonPath: 'usage.cost_usd',
        usdPerUnit: '1',
        maxPerRequest: '0.25',
      },
    },
  ]);
  const json = { 'content-type': 'application/json; charset=utf-8' };

  it('prices perRequest routes flat, as before', () => {
    const c = priced(headerApi, 'GET', '/v1/flat');
    expect(headerApi.worstCase(c)).toBe(2_000n);
    expect(headerApi.actual(c, { status: 200, headers: {} })).toBe(2_000n);
    expect(headerApi.costNote(c, { status: 200, headers: {} })).toBeNull();
    expect(headerApi.needsBody(c)).toBe(false);
  });

  it('reserves maxPerRequest and settles at the cost in a response header', () => {
    const c = priced(headerApi, 'POST', '/v1/run');
    expect(headerApi.worstCase(c)).toBe(500_000n);
    expect(headerApi.needsBody(c)).toBe(false);
    const res = { status: 200, headers: { 'x-credits-used': '42' } };
    expect(headerApi.actual(c, res)).toBe(42_000n);
    expect(headerApi.costNote(c, res)).toBeNull();
    // Fractions of a micro-dollar round up.
    expect(headerApi.actual(c, { status: 200, headers: { 'x-credits-used': '0.0001' } })).toBe(1n);
    // Not billed: nothing, whatever it reports.
    expect(headerApi.actual(c, { status: 500, headers: { 'x-credits-used': '42' } })).toBe(0n);
  });

  it('settles at the cost in a JSON field of a JSON answer', () => {
    const c = priced(jsonApi, 'POST', '/v1/a/b');
    expect(jsonApi.needsBody(c)).toBe(true);
    expect(jsonApi.worstCase(c)).toBe(250_000n);
    const res = { status: 200, headers: json, body: { usage: { cost_usd: 0.0123 } } };
    expect(jsonApi.actual(c, res)).toBe(12_300n);
    expect(jsonApi.actual(c, { ...res, body: { usage: { cost_usd: '0.02' } } })).toBe(20_000n);
    expect(jsonApi.costNote(c, res)).toBeNull();
  });

  it('settles at maxPerRequest and flags it when no cost can be read', () => {
    const h = priced(headerApi, 'POST', '/v1/run');
    for (const headers of [{}, { 'x-credits-used': 'lots' }, { 'x-credits-used': '-1' }]) {
      const res = { status: 200, headers };
      expect(headerApi.actual(h, res)).toBe(500_000n);
      expect(headerApi.costNote(h, res)).toBe('cost_unreported');
    }
    const j = priced(jsonApi, 'GET', '/v1/x');
    for (const res of [
      { status: 200, headers: json }, // body not buffered
      { status: 200, headers: json, body: { usage: {} } },
      { status: 200, headers: json, body: { usage: { cost_usd: null } } },
      { status: 200, headers: json, body: [{ usage: { cost_usd: 1 } }] },
      // Only a JSON answer counts, whatever the body looks like.
      { status: 200, headers: { 'content-type': 'text/plain' }, body: { usage: { cost_usd: 0 } } },
    ]) {
      expect(jsonApi.actual(j, res)).toBe(250_000n);
      expect(jsonApi.costNote(j, res)).toBe('cost_unreported');
    }
  });

  it('charges a reported cost above maxPerRequest in full, and flags it', () => {
    const c = priced(jsonApi, 'GET', '/v1/x');
    const res = { status: 200, headers: json, body: { usage: { cost_usd: 1.5 } } };
    expect(jsonApi.actual(c, res)).toBe(1_500_000n);
    expect(jsonApi.costNote(c, res)).toBe('over_max');
  });

  it('serves custom APIs under /custom/<id>', () => {
    expect(headerApi.upstreams).toEqual([
      { prefix: '/custom/acme', origin: 'https://api.acme.example' },
    ]);
  });

  it('validates custom APIs', () => {
    const base = {
      id: 'x',
      name: 'X',
      origin: 'https://x.example',
      auth: { type: 'query', name: 'k' },
      routes: [{ path: '/a', sku: 'a', pricing: { model: 'perRequest', usd: '0.01' } }],
    };
    expect(customApiSchema.safeParse(base).success).toBe(true);
    for (const origin of [
      'http://x.example',
      'https://user:pw@x.example',
      'https://x.example/v1',
      'https://x.example/?a=1',
      'not a url',
    ]) {
      expect(customApiSchema.safeParse({ ...base, origin }).success, origin).toBe(false);
    }
    const bad = (pricing: unknown) =>
      customApiSchema.safeParse({ ...base, routes: [{ path: '/a', sku: 'a', pricing }] }).success;
    expect(bad({ model: 'reported', usdPerUnit: '1', maxPerRequest: '1' })).toBe(false);
    expect(
      bad({ model: 'reported', header: 'h', jsonPath: 'a', usdPerUnit: '1', maxPerRequest: '1' }),
    ).toBe(false);
    expect(bad({ model: 'reported', header: 'h', usdPerUnit: '1' })).toBe(false);
    expect(bad({ model: 'perRequest', usd: '0.0000001' })).toBe(false);
    expect(
      customApiSchema.safeParse({ ...base, auth: { type: 'header', name: 'Host' } }).success,
    ).toBe(false);
    expect(
      customApiSchema.safeParse({
        ...base,
        routes: [
          { path: '/a', sku: 'a', pricing: { model: 'perRequest', usd: '0.01' } },
          { path: '/b', sku: 'a', pricing: { model: 'perRequest', usd: '0.02' } },
        ],
      }).success,
    ).toBe(false);
    // Strict for input, stripping for stored records (a newer API may add fields).
    expect(customApiSchema.safeParse({ ...base, later: 1 }).success).toBe(false);
    expect(customApiRecordSchema.safeParse({ ...base, later: 1 }).success).toBe(true);
  });

  it('still reads the older pricePerRequest spelling in operator config', () => {
    const g = new GenericAdapter({
      id: 'g',
      prefix: '/g',
      origin: 'https://api.acme.example',
      auth: { type: 'query', name: 'k' },
      routes: [{ path: '/**', sku: 's', pricePerRequest: '0.003' }],
    });
    expect(g.worstCase(priced(g, 'GET', '/x'))).toBe(3_000n);
    expect(
      () =>
        new GenericAdapter({
          id: 'g',
          prefix: '/custom',
          origin: 'https://api.acme.example',
          auth: { type: 'query', name: 'k' },
          routes: [{ path: '/**', sku: 's', pricePerRequest: '0.003' }],
        }),
    ).toThrow();
  });
});
