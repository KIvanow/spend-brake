import { HereAdapter, MapboxAdapter } from '@spend-brake/catalog';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { unsafePath } from '../src/server.js';
import { StaticSecretStore } from '../src/secrets.js';
import {
  type Harness,
  MockGoogle,
  newKey,
  newOrg,
  startProxy,
  startValkey,
  disconnectClients,
} from './harness.js';

// Trimmed real response shapes.
const GEOCODE_V6 = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { mapbox_id: 'dXJu', name: 'Sofia' } }],
};
const SUGGEST = { suggestions: [{ name: 'Cafe', mapbox_id: 'dXJu' }], attribution: '©' };
const HERE_GEOCODE = { items: [{ title: 'Sofia, Bulgaria', id: 'here:cm:namedplace:1' }] };

let container: StartedTestContainer;
let mock: MockGoogle;
let h: Harness;

beforeAll(async () => {
  let url: string;
  ({ container, url } = await startValkey());
  mock = await new MockGoogle().start();
  const overrides = Object.fromEntries(
    [...new MapboxAdapter().upstreams, ...new HereAdapter().upstreams].map((u) => [
      u.origin,
      mock.url,
    ]),
  );
  h = await startProxy(url, mock, {
    adapters: [new MapboxAdapter(), new HereAdapter()],
    secrets: new StaticSecretStore({
      'cred-mapbox': 'pk.real-mapbox-token',
      'cred-here': 'real-here-api-key',
      'cred-here-oauth': 'Bearer eyJreal.oauth.token',
    }),
    upstreamOverrides: overrides,
  });
  mock.respond = (req, reply) => {
    if (req.url.includes('/suggest')) return reply.send(SUGGEST);
    if (req.url.includes('/v1/geocode')) return reply.send(HERE_GEOCODE);
    return reply.send(GEOCODE_V6);
  };
});

afterAll(async () => {
  await h.proxy.close();
  await h.valkey.quit();
  await mock.app.close();
  disconnectClients();
  await container.stop();
});

const mapboxKey = (org: string) => newKey(h, org, { credentials: { mapbox: 'cred-mapbox' } });

describe('Mapbox through the proxy', () => {
  it('takes the virtual key as access_token and swaps in the real token', async () => {
    const { token } = await mapboxKey(newOrg());
    const res = await h.proxy.inject(
      `/mapbox/search/geocode/v6/forward?q=Sofia&access_token=${token}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(GEOCODE_V6);
    expect(res.headers['x-brake-cost-micros']).toBe('750');
    const sent = new URL(mock.last().url, 'http://x');
    expect(sent.searchParams.getAll('access_token')).toEqual(['pk.real-mapbox-token']);
    expect(sent.searchParams.get('q')).toBe('Sofia');
    expect(h.logs.text()).not.toContain('pk.real-mapbox-token');
    expect(h.logs.text()).not.toContain(token);
  });

  it('bills a Search Box session once: first /suggest, free keystrokes, free /retrieve, then a new session', async () => {
    const { token } = await mapboxKey(newOrg());
    const call = async (path: string) => {
      const res = await h.proxy.inject({
        url: `/mapbox${path}`,
        headers: { 'x-brake-key': token },
      });
      expect(res.statusCode).toBe(200);
      await h.proxy.brakeDrain();
      return res.headers['x-brake-cost-micros'];
    };
    expect(await call('/search/searchbox/v1/suggest?q=c&session_token=tok-1')).toBe('11500');
    expect(await call('/search/searchbox/v1/suggest?q=ca&session_token=tok-1')).toBe('0');
    expect(await call('/search/searchbox/v1/suggest?q=caf&session_token=tok-1')).toBe('0');
    expect(await call('/search/searchbox/v1/retrieve/dXJu?session_token=tok-1')).toBe('0');
    // The session ended at /retrieve: reusing the token opens and bills a new one.
    expect(await call('/search/searchbox/v1/suggest?q=b&session_token=tok-1')).toBe('11500');
    expect(await call('/search/searchbox/v1/suggest?q=b&session_token=tok-2')).toBe('11500');
  });

  it('denies tiles as unpriced', async () => {
    const { token } = await mapboxKey(newOrg());
    const before = mock.seen.length;
    const res = await h.proxy.inject({
      url: '/mapbox/v4/mapbox.satellite/1/1/1.png',
      headers: { 'x-brake-key': token },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'unpriced_route' });
    expect(mock.seen.length).toBe(before);
  });
});

describe('HERE through the proxy', () => {
  it('takes the virtual key as apiKey and injects the real API key', async () => {
    const { token } = await newKey(h, newOrg(), { credentials: { here: 'cred-here' } });
    const res = await h.proxy.inject(`/here-geocode/v1/geocode?q=Sofia&apiKey=${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(HERE_GEOCODE);
    expect(res.headers['x-brake-cost-micros']).toBe('880');
    const sent = new URL(mock.last().url, 'http://x');
    expect(sent.searchParams.getAll('apiKey')).toEqual(['real-here-api-key']);
    expect(mock.last().headers.authorization).toBeUndefined();
  });

  it('takes the virtual key as a bearer token and injects the real OAuth token', async () => {
    const { token } = await newKey(h, newOrg(), { credentials: { here: 'cred-here-oauth' } });
    const res = await h.proxy.inject({
      method: 'POST',
      url: '/here-matrix/v8/matrix?async=false',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {
        origins: [
          { lat: 1, lng: 2 },
          { lat: 3, lng: 4 },
        ],
        destinations: [{ lat: 5, lng: 6 }],
        regionDefinition: { type: 'world' },
      },
    });
    expect(res.statusCode).toBe(200);
    // 2 x 1 = 2 transactions at $5.83/1000.
    expect(res.headers['x-brake-cost-micros']).toBe('11660');
    expect(mock.last().headers.authorization).toBe('Bearer eyJreal.oauth.token');
    expect(new URL(mock.last().url, 'http://x').searchParams.has('apiKey')).toBe(false);
  });

  it('prices car routes as time-aware unless traffic is off', async () => {
    const { token } = await newKey(h, newOrg(), { credentials: { here: 'cred-here' } });
    const route = (extra: string) =>
      h.proxy.inject({
        url: `/here-router/v8/routes?transportMode=car&origin=1,2&destination=3,4${extra}`,
        headers: { 'x-brake-key': token },
      });
    expect((await route('')).headers['x-brake-cost-micros']).toBe('2920');
    expect((await route('&departureTime=any')).headers['x-brake-cost-micros']).toBe('880');
  });
});

describe('paths the upstream would resolve differently', () => {
  it('recognises dot segments, encoded or not, and backslashes', () => {
    for (const p of [
      '/mapbox/styles/v1/u/s/static/../../x',
      '/mapbox/a/%2e%2e/b',
      '/mapbox/a/%2E/b',
      '/mapbox/a/.',
      '/mapbox/a\\b',
      '/mapbox/a/%5c/b',
      '/mapbox/a/%zz/b',
    ]) {
      expect(unsafePath(p), p).toBe(true);
    }
    expect(unsafePath('/mapbox/geocoding/v5/mapbox.places/a%2Fb.json?q=../x')).toBe(false);
    expect(unsafePath('/mapbox/styles/v1/u/s/static/1,2,3/10x10')).toBe(false);
  });

  it('refuses them over a real socket, before anything is priced or forwarded', async () => {
    const { token } = await mapboxKey(newOrg());
    const address = await h.proxy.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(address).port);
    const before = mock.seen.length;
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port,
          // Not normalized by the client: exactly what an attacker would send.
          path: '/mapbox/styles/v1/u/s/static/../../../../../geocoding/v5/mapbox.places-permanent/a.json',
          headers: { 'x-brake-key': token },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(400);
    expect(mock.seen.length).toBe(before);
  });

  it('closes a Search Box session even when /retrieve fails, and ignores a client token', async () => {
    const { token } = await mapboxKey(newOrg());
    const call = async (path: string) => {
      const res = await h.proxy.inject({
        url: `/mapbox${path}&access_token=pk.client-own`,
        headers: { 'x-brake-key': token },
      });
      await h.proxy.brakeDrain();
      return res;
    };
    expect(
      (await call('/search/searchbox/v1/suggest?q=a&session_token=t9')).headers[
        'x-brake-cost-micros'
      ],
    ).toBe('11500');
    expect(new URL(mock.last().url, 'http://x').searchParams.getAll('access_token')).toEqual([
      'pk.real-mapbox-token',
    ]);
    const respond = mock.respond;
    mock.respond = (_req, reply) => reply.code(404).send({ message: 'Not Found' });
    expect((await call('/search/searchbox/v1/retrieve/x?session_token=t9')).statusCode).toBe(404);
    mock.respond = respond;
    expect(
      (await call('/search/searchbox/v1/suggest?q=b&session_token=t9')).headers[
        'x-brake-cost-micros'
      ],
    ).toBe('11500');
  });
});
