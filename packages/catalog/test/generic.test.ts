import { describe, expect, it } from 'vitest';
import { GenericAdapter } from '../src/generic.js';
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
