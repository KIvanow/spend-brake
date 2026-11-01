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
  // 2 x 3 = 6 elements are billed even though the body was cut off after 4
  'routes-matrix-partial': [['routes.compute_route_matrix.essentials'], 30_000n, 30_000n],
  // Photos answer with a redirect to the image; Google bills it.
  'places-photo-redirect': [['places.photo'], 7_000n, 7_000n],
  'legacy-photo-redirect': [['legacy.places.photo'], 7_000n, 7_000n],
  // A Pro field closing an Autocomplete session bills Enterprise + Atmosphere; Essentials stays.
  'places-details-closes-session': [['places.details.enterprise_atmosphere'], 25_000n, 25_000n],
  'places-details-essentials-closes-session': [['places.details.essentials'], 5_000n, 5_000n],
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

  it('leaves a matrix of unknown size unpriced instead of free', () => {
    for (const body of [undefined, {}, { origins: [], destinations: [{}] }, 'not json']) {
      const c = adapter.classify(
        req('POST', 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', { body }),
      );
      expect(c.priced, JSON.stringify(body)).toBe(false);
    }
    expect(
      adapter.classify(
        req('GET', 'https://maps.googleapis.com/maps/api/distancematrix/json?origins=A'),
      ).priced,
    ).toBe(false);
  });

  it('prices at the highest tier across every field mask the request carries', () => {
    const c = adapter.classify(
      req('GET', 'https://places.googleapis.com/v1/places/ChIJ1?fields=*', {
        headers: { 'X-Goog-FieldMask': 'id' },
      }),
    );
    expect(c.priced && c.items[0]!.sku).toBe('places.details.enterprise_atmosphere');
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

  it('prices a legacy autocomplete session once, on its first request', () => {
    const r = req(
      'GET',
      'https://maps.googleapis.com/maps/api/place/autocomplete/json?input=pi&sessiontoken=abc',
    );
    expect(adapter.billingSession(r)).toEqual({ token: 'abc', ttlSec: 600 });
    const first = adapter.classify(r);
    const later = adapter.classify(r, { billingSessionStarted: true });
    if (!first.priced || !later.priced) throw new Error();
    expect(first.items).toEqual([{ sku: 'legacy.places.autocomplete_session', units: 1n }]);
    expect(adapter.worstCase(first, ctx())).toBe(17_000n);
    expect(adapter.worstCase(later, ctx())).toBe(0n);
    // Without a token every request is billed on its own.
    const noToken = req(
      'GET',
      'https://maps.googleapis.com/maps/api/place/autocomplete/json?input=pi',
    );
    expect(adapter.billingSession(noToken)).toBeNull();
    const c = adapter.classify(noToken);
    expect(c.priced && adapter.worstCase(c, ctx())).toBe(2_830n);
  });

  it('prices a legacy autocomplete session per request once it is too long or too old', () => {
    const r = req(
      'GET',
      'https://maps.googleapis.com/maps/api/place/autocomplete/json?input=pi&sessiontoken=abc',
    );
    const price = (opts: { billingSessionCalls: number; billingSessionAgeSec?: number }) => {
      const c = adapter.classify(r, {
        billingSessionStarted: opts.billingSessionCalls > 0,
        ...opts,
      });
      if (!c.priced) throw new Error(c.reason);
      return adapter.worstCase(c, ctx());
    };
    expect(price({ billingSessionCalls: 11, billingSessionAgeSec: 60 })).toBe(0n);
    // The 13th request and anything past Google's session window are billed on their own.
    expect(price({ billingSessionCalls: 12, billingSessionAgeSec: 60 })).toBe(2_830n);
    expect(price({ billingSessionCalls: 2, billingSessionAgeSec: 181 })).toBe(2_830n);
    // A token reused after Place Details closed its session is billed as no token.
    const c = adapter.classify(r, { billingSessionClosed: true });
    expect(c.priced && adapter.worstCase(c, ctx())).toBe(2_830n);
  });

  it('closes a legacy autocomplete session with Place Details', () => {
    const details = req(
      'GET',
      'https://maps.googleapis.com/maps/api/place/details/json?place_id=x&fields=name&sessiontoken=abc',
    );
    expect(adapter.billingSession(details)).toEqual({
      token: 'abc',
      ttlSec: 600,
      ends: true,
      closedTtlSec: 600,
    });
    const plain = req(
      'GET',
      'https://maps.googleapis.com/maps/api/place/details/json?place_id=x&fields=name',
    );
    expect(adapter.billingSession(plain)).toBeNull();
  });

  it('asks for the response body only where the price depends on it', () => {
    const needs = (method: string, url: string, body?: unknown) => {
      const c = adapter.classify(req(method, url, { body, headers: { 'X-Goog-FieldMask': 'id' } }));
      if (!c.priced) throw new Error(c.reason);
      return adapter.needsBody(c);
    };
    expect(needs('GET', 'https://maps.googleapis.com/maps/api/geocode/json?address=x')).toBe(true);
    expect(needs('GET', 'https://maps.googleapis.com/maps/api/place/photo?photo_reference=x')).toBe(
      false,
    );
    expect(needs('GET', 'https://places.googleapis.com/v1/places/ChIJ1')).toBe(false);
    expect(
      needs('POST', 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
        origins: [{ waypoint: { address: 'A' } }],
        destinations: [{ waypoint: { address: 'B' } }],
      }),
    ).toBe(true);
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

  it('bills only 2xx responses, plus redirects on photo routes, and timeouts by default', () => {
    expect(adapter.billedOnStatus(200)).toBe(true);
    expect(adapter.billedOnStatus(302)).toBe(false);
    expect(adapter.billedOnStatus(400)).toBe(false);
    expect(adapter.billedOnStatus(503)).toBe(false);
    const photo = adapter.classify(
      req('GET', 'https://maps.googleapis.com/maps/api/place/photo?photo_reference=x'),
    );
    if (!photo.priced) throw new Error(photo.reason);
    expect(adapter.billedOnStatus(302, photo)).toBe(true);
    expect(adapter.billedOnStatus(404, photo)).toBe(false);
    expect(adapter.timeoutBilled).toBe(true);
  });

  it('recognises Google rejecting the real key', () => {
    const rejected = (status: number, body: unknown) =>
      adapter.credentialRejected({ status, headers: {}, body });
    expect(
      rejected(200, {
        status: 'REQUEST_DENIED',
        error_message: 'The provided API key is invalid.',
      }),
    ).toBe(true);
    expect(
      rejected(400, {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
          ],
        },
      }),
    ).toBe(true);
    expect(
      rejected(403, {
        error: { status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] },
      }),
    ).toBe(true);
    expect(rejected(403, undefined)).toBe(true);
    expect(rejected(200, { status: 'OK' })).toBe(false);
    expect(rejected(200, { status: 'ZERO_RESULTS' })).toBe(false);
    expect(
      rejected(400, { error: { message: 'Invalid textQuery', status: 'INVALID_ARGUMENT' } }),
    ).toBe(false);
    expect(rejected(500, undefined)).toBe(false);
  });

  it('reports an error status inside a 200 from the legacy APIs and Geocoding', () => {
    const geocode = adapter.classify(
      req('GET', 'https://maps.googleapis.com/maps/api/geocode/json?address=x'),
    );
    const places = adapter.classify(
      req('GET', 'https://places.googleapis.com/v1/places/ChIJ1', {
        headers: { 'X-Goog-FieldMask': 'id' },
      }),
    );
    if (!geocode.priced || !places.priced) throw new Error();
    const error = (c: typeof geocode, status: number, body: unknown) =>
      adapter.providerError(c, { status, headers: {}, body });
    expect(error(geocode, 200, { status: 'REQUEST_DENIED' })).toBe('REQUEST_DENIED');
    expect(error(geocode, 200, { status: 'OVER_QUERY_LIMIT' })).toBe('OVER_QUERY_LIMIT');
    expect(error(geocode, 200, { status: 'INVALID_REQUEST' })).toBe('INVALID_REQUEST');
    expect(error(geocode, 200, { status: 'OK' })).toBeNull();
    expect(error(geocode, 200, { status: 'ZERO_RESULTS' })).toBeNull();
    expect(error(geocode, 200, undefined)).toBeNull();
    expect(error(geocode, 500, { status: 'UNKNOWN_ERROR' })).toBeNull();
    expect(error(places, 200, { status: 'REQUEST_DENIED' })).toBeNull();
  });

  it('settles a matrix on more elements than requested, never fewer', () => {
    const c = adapter.classify(
      req(
        'GET',
        'https://maps.googleapis.com/maps/api/distancematrix/json?origins=A&destinations=B',
      ),
    );
    if (!c.priced) throw new Error(c.reason);
    const rows = (n: number) => ({
      rows: [{ elements: Array.from({ length: n }, () => ({})) }],
      status: 'OK',
    });
    expect(adapter.actual(c, { status: 200, headers: {}, body: rows(0) }, ctx())).toBe(5_000n);
    expect(adapter.actual(c, { status: 200, headers: {}, body: rows(3) }, ctx())).toBe(15_000n);
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
