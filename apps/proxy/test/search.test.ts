import {
  BraveAdapter,
  ExaAdapter,
  type ProviderAdapter,
  SerpApiAdapter,
  TavilyAdapter,
} from '@spend-brake/catalog';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticSecretStore } from '../src/secrets.js';
import { type Harness, MockGoogle, newKey, newOrg, startProxy, startValkey } from './harness.js';

// Trimmed real response shapes.
const TAVILY = { query: 'x', results: [{ url: 'https://a', content: 'a' }], usage: { credits: 1 } };
const EXA = { requestId: 'r', results: [{ url: 'https://a' }], costDollars: { total: 0.007 } };
const BRAVE = { type: 'search', web: { results: [] } };
const SERP = { search_metadata: { status: 'Success' }, organic_results: [] };

let container: StartedTestContainer;
let mock: MockGoogle;
let h: Harness;

const adapters = (): ProviderAdapter[] => [
  new TavilyAdapter(),
  new ExaAdapter(),
  new BraveAdapter(),
  new SerpApiAdapter(),
];

beforeAll(async () => {
  let url: string;
  ({ container, url } = await startValkey());
  mock = await new MockGoogle().start();
  h = await startProxy(url, mock, {
    adapters: adapters(),
    secrets: new StaticSecretStore({
      'cred-tavily': 'tvly-real',
      'cred-exa': 'exa-real',
      'cred-brave': 'brave-real',
      'cred-serpapi': 'serp-real',
    }),
    upstreamOverrides: Object.fromEntries(
      adapters()
        .flatMap((a) => a.upstreams)
        .map((u) => [u.origin, mock.url]),
    ),
  });
  mock.respond = (req, reply) => {
    if (req.url.startsWith('/search?') || req.url.startsWith('/search.json')) {
      return reply.send(SERP);
    }
    if (req.url === '/search') {
      // Tavily and Exa share the path; Exa clients send x-api-key.
      return reply.send(req.headers['x-api-key'] ? EXA : TAVILY);
    }
    return reply.send(BRAVE);
  };
});

afterAll(async () => {
  await h.proxy.close();
  await h.valkey.quit();
  await mock.app.close();
  await container.stop();
});

const CREDENTIALS = {
  tavily: 'cred-tavily',
  exa: 'cred-exa',
  brave: 'cred-brave',
  serpapi: 'cred-serpapi',
};

describe('search providers through the proxy, each with its own SDK key slot', () => {
  it('Tavily: bearer virtual key, settles on the credits reported', async () => {
    const { token } = await newKey(h, newOrg(), { credentials: CREDENTIALS });
    const res = await h.proxy.inject({
      method: 'POST',
      url: '/tavily/search',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // auto_parameters reserves 2 credits; Tavily reported 1.
      payload: { query: 'x', auto_parameters: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TAVILY);
    expect(res.headers['x-brake-cost-micros']).toBe('8000');
    expect(mock.last().headers.authorization).toBe('Bearer tvly-real');
    expect(h.logs.text()).not.toContain('tvly-real');
  });

  it('Exa: x-api-key virtual key, settles on costDollars', async () => {
    const { token } = await newKey(h, newOrg(), { credentials: CREDENTIALS });
    const res = await h.proxy.inject({
      method: 'POST',
      url: '/exa/search',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      payload: { query: 'x', numResults: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-brake-cost-micros']).toBe('7000');
    expect(mock.last().headers['x-api-key']).toBe('exa-real');
  });

  it('Brave: X-Subscription-Token virtual key', async () => {
    const { token } = await newKey(h, newOrg(), { credentials: CREDENTIALS });
    const res = await h.proxy.inject({
      url: '/brave/res/v1/web/search?q=x',
      headers: { 'x-subscription-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-brake-cost-micros']).toBe('5000');
    expect(mock.last().headers['x-subscription-token']).toBe('brave-real');
    expect(h.logs.text()).not.toContain(token);
  });

  it('SerpApi: api_key virtual key', async () => {
    const { token } = await newKey(h, newOrg(), { credentials: CREDENTIALS });
    const res = await h.proxy.inject(`/serpapi/search.json?engine=google&q=x&api_key=${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-brake-cost-micros']).toBe('25000');
    const sent = new URL(mock.last().url, 'http://x');
    expect(sent.searchParams.getAll('api_key')).toEqual(['serp-real']);
  });
});

describe('one agent session budget across search providers', () => {
  it('stops the session once Tavily and Exa together reach its cap', async () => {
    const { token } = await newKey(h, newOrg(), {
      credentials: CREDENTIALS,
      sessionCapMicros: '20000',
    });
    const session = { 'x-brake-key': token, 'x-brake-session': 'research-1' };
    const tavily = () =>
      h.proxy.inject({
        method: 'POST',
        url: '/tavily/search',
        headers: session,
        payload: { query: 'x' },
      });
    const exa = () =>
      h.proxy.inject({
        method: 'POST',
        url: '/exa/search',
        headers: session,
        payload: { query: 'y' },
      });

    expect((await tavily()).statusCode).toBe(200); // $0.008
    await h.proxy.brakeDrain();
    expect((await exa()).statusCode).toBe(200); // $0.007, $0.015 in total
    await h.proxy.brakeDrain();
    const before = mock.seen.length;
    for (const next of [exa, tavily]) {
      const res = await next();
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({
        error: 'budget_exceeded',
        scope: 'sess:research-1',
        cap: 20_000,
      });
    }
    expect(mock.seen.length).toBe(before);
    // A new session on the same key starts its own budget.
    const fresh = await h.proxy.inject({
      method: 'POST',
      url: '/exa/search',
      headers: { ...session, 'x-brake-session': 'research-2' },
      payload: { query: 'y' },
    });
    expect(fresh.statusCode).toBe(200);
  });
});
