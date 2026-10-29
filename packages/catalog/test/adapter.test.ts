import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GoogleMapsAdapter } from '../src/google-maps/adapter.js';
import type { OutgoingReq } from '../src/types.js';
import { ctx, req } from './helpers.js';

const adapter = new GoogleMapsAdapter();
const FIXTURES = new URL('./fixtures/google-maps/', import.meta.url);

interface Fixture {
  request: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; body?: unknown };
}

// Expected [skus, worstCase, actual] in micros at first-band list prices.
const EXPECTED: Record<string, [string[], bigint, bigint]> = {
  'places-text-search-pro': [['places.text_search.pro'], 32_000n, 32_000n],
  'places-details-atmosphere': [['places.details.enterprise_atmosphere'], 25_000n, 25_000n],
  'places-details-not-found': [['places.details.pro'], 17_000n, 0n],
  'places-nearby-wildcard': [['places.nearby_search.enterprise_atmosphere'], 40_000n, 40_000n],
  'places-autocomplete': [['places.autocomplete'], 2_830n, 2_830n],
  'geocode-ok': [['geocoding'], 5_000n, 5_000n],
  'geocode-reverse-zero-results': [['geocoding'], 5_000n, 5_000n],
  'geocode-request-denied': [['geocoding'], 5_000n, 0n],
  'routes-compute-traffic': [['routes.compute_routes.pro'], 10_000n, 10_000n],
  // 2 x 3 = 6 elements reserved, 4 returned
  'routes-matrix-partial': [['routes.compute_route_matrix.essentials'], 30_000n, 20_000n],
  'routes-upstream-500': [['routes.compute_routes.essentials'], 5_000n, 0n],
  'legacy-details-contact': [
    ['legacy.places.details', 'legacy.places.contact_data'],
    20_000n,
    20_000n,
  ],
  'legacy-textsearch': [
    ['legacy.places.text_search', 'legacy.places.contact_data', 'legacy.places.atmosphere_data'],
    40_000n,
    40_000n,
  ],
  'legacy-distancematrix': [['legacy.distance_matrix'], 20_000n, 20_000n],
};

const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map(
    (f) =>
      [
        f.replace(/\.json$/, ''),
        JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8')) as Fixture,
      ] as const,
  );

describe('google-maps fixtures', () => {
  it('has an expectation for every fixture', () => {
    expect(fixtures.map(([n]) => n).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(fixtures)('%s', (name, f) => {
    const c = adapter.classify(req(f.request.method, f.request.url, f.request));
    if (!c.priced) throw new Error(c.reason);
    const worstCase = adapter.worstCase(c, ctx());
    const actual = adapter.actual(
      c,
      { status: f.response.status, headers: {}, body: f.response.body },
      ctx(),
    );
    const [skus, wc, act] = EXPECTED[name]!;
    expect(c.items.map((i) => i.sku)).toEqual(skus);
    expect(worstCase).toBe(wc);
    expect(actual).toBe(act);
    expect({ route: c.route, items: c.items, worstCase, actual }).toMatchSnapshot();
  });
});

describe('google-maps adapter', () => {
  it('matches only its upstream origins', () => {
    expect(adapter.match(req('GET', 'https://maps.googleapis.com/maps/api/geocode/json'))).toBe(
      true,
    );
    expect(adapter.match(req('GET', 'https://evil.example.com/maps/api/geocode/json'))).toBe(false);
  });

  it('leaves unknown routes unpriced', () => {
    for (const [method, url] of [
      ['GET', 'https://maps.googleapis.com/maps/api/staticmap?center=Sofia'],
      ['POST', 'https://places.googleapis.com/v1/places:searchText:extra'],
      ['DELETE', 'https://places.googleapis.com/v1/places/ChIJ1'],
      ['GET', 'https://routes.googleapis.com/directions/v2:computeRoutes'],
    ] as const) {
      const c = adapter.classify(req(method, url));
      expect(c.priced, url).toBe(false);
    }
  });

  it('prices the free ID-only routes at zero', () => {
    const c = adapter.classify(
      req(
        'GET',
        'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=x&inputtype=textquery',
      ),
    );
    expect(c.priced && adapter.worstCase(c, ctx())).toBe(0n);
  });

  it('prices legacy autocomplete with a session token at the per-session SKU', () => {
    const c = adapter.classify(
      req(
        'GET',
        'https://maps.googleapis.com/maps/api/place/autocomplete/json?input=pi&sessiontoken=abc',
      ),
    );
    expect(c.priced && c.items[0]!.sku).toBe('legacy.places.autocomplete_session');
  });

  it('injects the real key in the place each API expects and drops the client key', () => {
    const legacy: OutgoingReq = {
      origin: 'https://maps.googleapis.com',
      headers: { 'x-goog-api-key': 'client' },
      query: new URLSearchParams('address=Sofia&key=client'),
    };
    adapter.injectCredential(legacy, 'REAL');
    expect(legacy.query.getAll('key')).toEqual(['REAL']);
    expect(legacy.headers['x-goog-api-key']).toBeUndefined();

    const places: OutgoingReq = {
      origin: 'https://places.googleapis.com',
      headers: { 'x-goog-api-key': 'client' },
      query: new URLSearchParams('key=client'),
    };
    adapter.injectCredential(places, 'REAL');
    expect(places.headers['x-goog-api-key']).toBe('REAL');
    expect(places.query.has('key')).toBe(false);
  });

  it('bills only 2xx responses, and timeouts by default', () => {
    expect(adapter.billedOnStatus(200)).toBe(true);
    expect(adapter.billedOnStatus(400)).toBe(false);
    expect(adapter.billedOnStatus(503)).toBe(false);
    expect(adapter.timeoutBilled).toBe(true);
  });

  it('hashes identical requests the same, ignoring keys, session tokens and order', () => {
    const hash = (url: string, body?: unknown, mask = 'places.id') => {
      const c = adapter.classify(req('POST', url, { body, headers: { 'X-Goog-FieldMask': mask } }));
      return c.normalizedHash;
    };
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const a = hash(url, { textQuery: 'pizza', pageSize: 5, sessionToken: 'a' });
    expect(hash(url, { pageSize: 5, textQuery: 'pizza', sessionToken: 'b' })).toBe(a);
    expect(hash(`${url}?key=other`, { textQuery: 'pizza', pageSize: 5 })).toBe(a);
    expect(hash(url, { textQuery: 'pasta', pageSize: 5 })).not.toBe(a);
    expect(hash(url, { textQuery: 'pizza', pageSize: 5 }, 'places.id,places.rating')).not.toBe(a);
    expect(hash(url, { textQuery: 'pizza' }, 'places.rating,places.id')).toBe(
      hash(url, { textQuery: 'pizza' }, 'places.id,places.rating'),
    );
  });

  it('uses the volume band from the monthly counter', () => {
    const c = adapter.classify(
      req('GET', 'https://maps.googleapis.com/maps/api/geocode/json?address=x'),
    );
    if (!c.priced) throw new Error();
    expect(adapter.worstCase(c, ctx({ geocoding: 600_000n }))).toBe(3_000n);
    expect(adapter.worstCase(c, ctx({ geocoding: 0n }, true))).toBe(0n);
  });
});
