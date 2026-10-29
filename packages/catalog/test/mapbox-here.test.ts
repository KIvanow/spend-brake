import { describe, expect, it } from 'vitest';
import { HereAdapter, matrixTransactions } from '../src/here/adapter.js';
import { MapboxAdapter } from '../src/mapbox/adapter.js';
import type { ClassifyOptions, IncomingReq, OutgoingReq } from '../src/types.js';
import { ctx, req } from './helpers.js';

const mapbox = new MapboxAdapter();
const here = new HereAdapter();
const MB = 'https://api.mapbox.com';

function price(
  adapter: MapboxAdapter | HereAdapter,
  r: IncomingReq,
  opts: ClassifyOptions = {},
): bigint | string {
  const c = adapter.classify(r, opts);
  if (!c.priced) return `unpriced: ${c.reason}`;
  return adapter.worstCase(c, ctx());
}

describe('Mapbox golden prices (no free tier, first paid band)', () => {
  const cases: [string, IncomingReq, bigint, ClassifyOptions?][] = [
    ['geocode v6 forward', req('GET', `${MB}/search/geocode/v6/forward?q=Sofia`), 750n],
    [
      'geocode v6 reverse',
      req('GET', `${MB}/search/geocode/v6/reverse?longitude=1&latitude=2`),
      750n,
    ],
    [
      'geocode v6 permanent',
      req('GET', `${MB}/search/geocode/v6/forward?q=Sofia&permanent=true`),
      5_000n,
    ],
    [
      'geocode v6 batch of 3',
      req('POST', `${MB}/search/geocode/v6/batch`, { body: [{ q: 'a' }, { q: 'b' }, { q: 'c' }] }),
      2_250n,
    ],
    ['geocode v5 places', req('GET', `${MB}/geocoding/v5/mapbox.places/Sofia.json`), 750n],
    [
      'geocode v5 permanent batch of 3',
      req('GET', `${MB}/geocoding/v5/mapbox.places-permanent/a%3Bb%3Bc.json`),
      15_000n,
    ],
    [
      'directions driving-traffic',
      req('GET', `${MB}/directions/v5/mapbox/driving-traffic/1,2;3,4;5,6`),
      2_000n,
    ],
    ['directions walking', req('GET', `${MB}/directions/v5/mapbox/walking/1,2;3,4`), 2_000n],
    ['matrix 3x3', req('GET', `${MB}/directions-matrix/v1/mapbox/driving/1,2;3,4;5,6`), 18_000n],
    [
      'matrix 1 source x 2 destinations',
      req(
        'GET',
        `${MB}/directions-matrix/v1/mapbox/driving/1,2;3,4;5,6?sources=0&destinations=1;2`,
      ),
      4_000n,
    ],
    [
      'searchbox first suggest opens a session',
      req('GET', `${MB}/search/searchbox/v1/suggest?q=caf&session_token=s1`),
      11_500n,
      { billingSessionCalls: 0 },
    ],
    [
      'searchbox later suggest in the session',
      req('GET', `${MB}/search/searchbox/v1/suggest?q=cafe&session_token=s1`),
      0n,
      { billingSessionCalls: 7 },
    ],
    [
      'searchbox 51st suggest opens a new session',
      req('GET', `${MB}/search/searchbox/v1/suggest?q=cafe&session_token=s1`),
      11_500n,
      { billingSessionCalls: 50 },
    ],
    [
      'searchbox retrieve closing a session',
      req('GET', `${MB}/search/searchbox/v1/retrieve/abc?session_token=s1`),
      0n,
      { billingSessionCalls: 3 },
    ],
    [
      'searchbox retrieve on its own',
      req('GET', `${MB}/search/searchbox/v1/retrieve/abc?session_token=s2`),
      11_500n,
    ],
    ['searchbox forward', req('GET', `${MB}/search/searchbox/v1/forward?q=cafe`), 1_700n],
    ['searchbox category', req('GET', `${MB}/search/searchbox/v1/category/cafe`), 1_700n],
    [
      'searchbox reverse',
      req('GET', `${MB}/search/searchbox/v1/reverse?longitude=1&latitude=2`),
      1_700n,
    ],
    [
      'static image',
      req('GET', `${MB}/styles/v1/mapbox/streets-v12/static/-122.4,37.8,10/300x200`),
      1_000n,
    ],
  ];
  it.each(cases)('%s', (_name, r, expected, opts) => {
    expect(price(mapbox, r, opts)).toBe(expected);
  });

  it('leaves tiles, styles, unknown endpoints and malformed requests unpriced', () => {
    for (const r of [
      req('GET', `${MB}/styles/v1/mapbox/streets-v12/tiles/512/1/1/1`),
      req('GET', `${MB}/v4/mapbox.satellite/1/1/1.png`),
      req('GET', `${MB}/styles/v1/mapbox/streets-v12`),
      req('GET', `${MB}/isochrone/v1/mapbox/driving/1,2`),
      req('GET', `${MB}/search/searchbox/v1/suggest?q=caf`),
      req('POST', `${MB}/search/geocode/v6/batch`, { body: {} }),
      req('GET', `${MB}/directions-matrix/v1/mapbox/driving/1,2;3,4?sources=0;5`),
      req('GET', `${MB}/directions-matrix/v1/mapbox/driving/1,2`),
      req('DELETE', `${MB}/search/geocode/v6/forward?q=a`),
    ]) {
      expect(mapbox.classify(r).priced, r.path).toBe(false);
    }
  });

  it('walks the volume bands and applies the free tier only when trusted', () => {
    const c = mapbox.classify(
      req('POST', `${MB}/search/geocode/v6/batch`, { body: [{ q: 'a' }, { q: 'b' }] }),
    );
    if (!c.priced) throw new Error(c.reason);
    // One at $0.75/1000 (event 500,000) and one at $0.60/1000 (500,001).
    expect(mapbox.worstCase(c, ctx({ 'mapbox.geocoding.temporary': 499_999n }))).toBe(1_350n);
    expect(mapbox.worstCase(c, ctx({}, true))).toBe(0n);
  });

  it('opens Search Box sessions on /suggest (sliding 180 s) and closes them on /retrieve', () => {
    expect(
      mapbox.billingSession(req('GET', `${MB}/search/searchbox/v1/suggest?q=a&session_token=t`)),
    ).toEqual({ token: 't', ttlSec: 180, sliding: true });
    expect(
      mapbox.billingSession(req('GET', `${MB}/search/searchbox/v1/retrieve/x?session_token=t`)),
    ).toEqual({ token: 't', ttlSec: 180, ends: true });
    expect(mapbox.billingSession(req('GET', `${MB}/search/searchbox/v1/forward?q=a`))).toBeNull();
  });

  it('injects the token as access_token and drops client credentials', () => {
    const out: OutgoingReq = {
      origin: MB,
      headers: { authorization: 'Bearer x' },
      query: new URLSearchParams('access_token=sb_live_abc&q=a'),
    };
    mapbox.injectCredential(out, 'pk.real');
    expect(out.query.get('access_token')).toBe('pk.real');
    expect(out.query.getAll('access_token')).toHaveLength(1);
    expect(out.headers.authorization).toBeUndefined();
    expect(mapbox.credentialRejected({ status: 401, headers: {} })).toBe(true);
    expect(mapbox.billedOnStatus(422)).toBe(false);
  });

  it('keeps the token and session out of the loop-detection hash', () => {
    const a = mapbox.classify(
      req('GET', `${MB}/search/searchbox/v1/suggest?q=a&session_token=1&access_token=x`),
    );
    const b = mapbox.classify(
      req('GET', `${MB}/search/searchbox/v1/suggest?q=a&session_token=2&access_token=y`),
    );
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });
});

describe('HERE golden prices (no free tier, first paid band)', () => {
  const routes = 'https://router.hereapi.com/v8/routes?origin=1,2&destination=3,4';
  const matrix = (origins: number, destinations?: number) =>
    req('POST', 'https://matrix.router.hereapi.com/v8/matrix?async=false', {
      body: {
        origins: Array.from({ length: origins }, () => ({ lat: 1, lng: 2 })),
        ...(destinations === undefined
          ? {}
          : { destinations: Array.from({ length: destinations }, () => ({ lat: 3, lng: 4 })) }),
        regionDefinition: { type: 'world' },
      },
    });
  const cases: [string, IncomingReq, bigint][] = [
    ['geocode', req('GET', 'https://geocode.search.hereapi.com/v1/geocode?q=Sofia'), 880n],
    [
      'reverse geocode',
      req('GET', 'https://revgeocode.search.hereapi.com/v1/revgeocode?at=1,2'),
      880n,
    ],
    [
      'discover',
      req('GET', 'https://discover.search.hereapi.com/v1/discover?q=cafe&at=1,2'),
      2_920n,
    ],
    [
      'autosuggest',
      req('GET', 'https://autosuggest.search.hereapi.com/v1/autosuggest?q=caf&at=1,2'),
      2_920n,
    ],
    [
      'autocomplete',
      req('GET', 'https://autocomplete.search.hereapi.com/v1/autocomplete?q=Sof'),
      880n,
    ],
    ['car route, time-aware by default', req('GET', `${routes}&transportMode=car`), 2_920n],
    [
      'car route, departureTime=any',
      req('GET', `${routes}&transportMode=car&departureTime=any`),
      880n,
    ],
    [
      'pedestrian route, traffic disabled',
      req('GET', `${routes}&transportMode=pedestrian&traffic%5Bmode%5D=disabled`),
      880n,
    ],
    ['bicycle route, time-aware', req('GET', `${routes}&transportMode=bicycle`), 2_920n],
    ['truck route', req('GET', `${routes}&transportMode=truck`), 2_920n],
    ['matrix 3x3: 9 transactions', matrix(3, 3), 52_470n],
    ['matrix 4x100: 400 transactions', matrix(4, 100), 2_332_000n],
    ['matrix 10x10: 50 transactions', matrix(10, 10), 291_500n],
    ['matrix 5 origins as destinations: 25', matrix(5), 145_750n],
    [
      'matrix status poll',
      req('GET', 'https://matrix.router.hereapi.com/v8/matrix/abc-123/status'),
      0n,
    ],
  ];
  it.each(cases)('%s', (_name, r, expected) => {
    expect(price(here, r)).toBe(expected);
  });

  it('counts matrix transactions as HERE does', () => {
    expect(matrixTransactions(1, 1)).toBe(1);
    expect(matrixTransactions(4, 10_000)).toBe(40_000);
    expect(matrixTransactions(5, 5)).toBe(25);
    expect(matrixTransactions(100, 5)).toBe(500);
  });

  it('leaves untranscribed modes and features unpriced', () => {
    for (const r of [
      req('GET', `${routes}&transportMode=scooter`),
      req('GET', `${routes}&transportMode=taxi`),
      req('GET', routes),
      req('GET', `${routes}&transportMode=car&ev%5BfreeFlowSpeedTable%5D=0,0.2`),
      req('GET', `${routes}&transportMode=car&departureTime=any&return=summary,tolls`),
      req('GET', 'https://lookup.search.hereapi.com/v1/lookup?id=x'),
      req('POST', 'https://matrix.router.hereapi.com/v8/matrix', { body: { origins: [] } }),
      req('POST', 'https://matrix.router.hereapi.com/v8/matrix', {
        body: { origins: [{}], destinations: 'x' },
      }),
    ]) {
      expect(here.match(r) ? here.classify(r).priced : false, `${r.origin}${r.path}`).toBe(false);
    }
  });

  it('injects an API key or a bearer token and drops client credentials', () => {
    const out = (): OutgoingReq => ({
      origin: 'https://geocode.search.hereapi.com',
      headers: { authorization: 'Bearer sb_live_x' },
      query: new URLSearchParams('apiKey=sb_live_y&q=a'),
    });
    const key = out();
    here.injectCredential(key, 'real-api-key');
    expect(key.query.get('apiKey')).toBe('real-api-key');
    expect(key.headers.authorization).toBeUndefined();
    const token = out();
    here.injectCredential(token, 'Bearer eyJ.real');
    expect(token.query.has('apiKey')).toBe(false);
    expect(token.headers.authorization).toBe('Bearer eyJ.real');
  });
});

describe('requests the provider could read differently', () => {
  const routes = 'https://router.hereapi.com/v8/routes?origin=1,2&destination=3,4';

  it('takes the dearer reading of repeated parameters', () => {
    expect(
      price(
        mapbox,
        req('GET', `${MB}/search/geocode/v6/forward?q=a&permanent=false&permanent=true`),
      ),
    ).toBe(5_000n);
    expect(
      price(
        here,
        req(
          'GET',
          `${routes}&transportMode=car&departureTime=any&departureTime=2026-11-01T10:00:00`,
        ),
      ),
    ).toBe(2_920n);
    expect(
      here.classify(
        req('GET', `${routes}&transportMode=pedestrian&departureTime=any&transportMode=truck`),
      ).priced,
    ).toBe(false);
    // traffic off but a departure time given: still time-aware.
    expect(
      price(
        here,
        req(
          'GET',
          `${routes}&transportMode=car&traffic%5Bmode%5D=disabled&departureTime=2026-11-01T10:00:00`,
        ),
      ),
    ).toBe(2_920n);
  });

  it('bills routes with more than 100 waypoints as 2 transactions', () => {
    const via = (n: number) => Array.from({ length: n }, (_, i) => `&via=${i},${i}`).join('');
    expect(price(here, req('GET', `${routes}&transportMode=car&departureTime=any${via(98)}`))).toBe(
      880n,
    );
    expect(price(here, req('GET', `${routes}&transportMode=car&departureTime=any${via(99)}`))).toBe(
      1_760n,
    );
  });

  it('prices POST routes only when the body holds nothing that changes the price', () => {
    const post = (body: unknown) =>
      req('POST', `${routes}&transportMode=car&departureTime=any`, { body });
    expect(price(here, post({ avoid: { areas: [] } }))).toBe(880n);
    expect(price(here, post(undefined))).toBe(880n);
    for (const body of [{ ev: { a: 1 } }, { via: [] }, { departureTime: 'now' }, [], 'x']) {
      expect(here.classify(post(body)).priced, JSON.stringify(body)).toBe(false);
    }
  });

  it('only prices Static Images paths of the documented shape', () => {
    expect(
      price(mapbox, req('GET', `${MB}/styles/v1/u/s/static/pin-s+555(1,2)/1,2,10/600x400@2x`)),
    ).toBe(1_000n);
    for (const path of [
      '/styles/v1/u/s/static/a/b/c/d/geocoding',
      '/styles/v1/u/s/static/1,2,10',
    ]) {
      expect(mapbox.classify(req('GET', `${MB}${path}`)).priced, path).toBe(false);
    }
  });
});
