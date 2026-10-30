import { describe, expect, it } from 'vitest';
import { BraveAdapter } from '../src/search/brave.js';
import { ExaAdapter } from '../src/search/exa.js';
import { SerpApiAdapter } from '../src/search/serpapi.js';
import { TavilyAdapter } from '../src/search/tavily.js';
import type { IncomingReq, OutgoingReq, PricedClassified, ProviderAdapter } from '../src/types.js';
import { ctx, req } from './helpers.js';

const tavily = new TavilyAdapter();
const exa = new ExaAdapter();
const brave = new BraveAdapter();
const serpapi = new SerpApiAdapter();
const TV = 'https://api.tavily.com';
const EX = 'https://api.exa.ai';
const BR = 'https://api.search.brave.com';
const SP = 'https://serpapi.com';

function price(adapter: ProviderAdapter, r: IncomingReq): bigint | string {
  const c = adapter.classify(r);
  if (!c.priced) return `unpriced: ${c.reason}`;
  return adapter.worstCase(c, ctx());
}

function settle(adapter: ProviderAdapter, r: IncomingReq, body: unknown, status = 200): bigint {
  const c = adapter.classify(r) as PricedClassified;
  expect(c.priced).toBe(true);
  return adapter.actual(c, { status, headers: {}, body }, ctx());
}

const post = (url: string, body: unknown) => req('POST', url, { body });

describe('Tavily credit costs ($0.008 per credit)', () => {
  const cases: [string, IncomingReq, bigint][] = [
    ['search, default depth', post(`${TV}/search`, { query: 'x' }), 8_000n],
    ['search, fast', post(`${TV}/search`, { query: 'x', search_depth: 'fast' }), 8_000n],
    [
      'search, ultra-fast',
      post(`${TV}/search`, { query: 'x', search_depth: 'ultra-fast' }),
      8_000n,
    ],
    ['search, advanced', post(`${TV}/search`, { query: 'x', search_depth: 'advanced' }), 16_000n],
    [
      'search, auto_parameters',
      post(`${TV}/search`, { query: 'x', auto_parameters: true }),
      16_000n,
    ],
    [
      'search, auto_parameters pinned to basic',
      post(`${TV}/search`, { query: 'x', auto_parameters: true, search_depth: 'basic' }),
      8_000n,
    ],
    // 1 credit per 5 URLs, priced per URL: 7 URLs = 1.4 credits.
    ['extract 7 urls, basic', post(`${TV}/extract`, { urls: Array(7).fill('u') }), 11_200n],
    ['extract 1 url as a string', post(`${TV}/extract`, { urls: 'https://a' }), 1_600n],
    [
      'extract 5 urls, advanced',
      post(`${TV}/extract`, { urls: Array(5).fill('u'), extract_depth: 'advanced' }),
      16_000n,
    ],
    // 1 credit per 10 pages; default limit 50.
    ['map, default limit', post(`${TV}/map`, { url: 'a' }), 40_000n],
    [
      'map, instructions',
      post(`${TV}/map`, { url: 'a', limit: 10, instructions: 'docs' }),
      16_000n,
    ],
    // 10 pages mapped (1 credit) + 10 extracted (2 credits) = 3 credits, as in Tavily's example.
    ['crawl 10 pages, basic', post(`${TV}/crawl`, { url: 'a', limit: 10 }), 24_000n],
    [
      'research, mini (110 credits)',
      post(`${TV}/research`, { input: 'x', model: 'mini' }),
      880_000n,
    ],
    ['research, default (pro, 250)', post(`${TV}/research`, { input: 'x' }), 2_000_000n],
    ['usage is free', req('GET', `${TV}/usage`), 0n],
    ['research poll is free', req('GET', `${TV}/research/abc-123`), 0n],
  ];
  it.each(cases)('%s', (_name, r, micros) => expect(price(tavily, r)).toBe(micros));

  it('denies what it cannot price', () => {
    for (const r of [
      post(`${TV}/search`, { query: 'x', search_depth: 'deep' }),
      post(`${TV}/extract`, { urls: Array(21).fill('u') }),
      post(`${TV}/extract`, { urls: ['u'], extract_depth: 'max' }),
      post(`${TV}/map`, { url: 'a', limit: 0 }),
      post(`${TV}/research`, { input: 'x', model: 'ultra' }),
      post(`${TV}/search`, { query: 'x', api_key: 'tvly-own' }),
      req('POST', `${TV}/search`),
      post(`${TV}/unknown`, {}),
    ]) {
      expect(price(tavily, r)).toMatch(/^unpriced/);
    }
  });

  it('settles from what Tavily reports, never above the worst case', () => {
    const auto = post(`${TV}/search`, { query: 'x', auto_parameters: true });
    expect(settle(tavily, auto, { results: [], usage: { credits: 1 } })).toBe(8_000n);
    expect(settle(tavily, auto, { results: [] })).toBe(16_000n);
    const extract = post(`${TV}/extract`, { urls: Array(10).fill('u') });
    expect(settle(tavily, extract, { results: [1, 2, 3], failed_results: [4] })).toBe(4_800n);
    expect(settle(tavily, extract, { results: Array(30).fill(0) })).toBe(16_000n);
    const crawl = post(`${TV}/crawl`, { url: 'a', limit: 10 });
    // Mapping stays at the limit; extraction settles on the 4 pages returned.
    expect(settle(tavily, crawl, { results: Array(4).fill(0) })).toBe(8_000n + 6_400n);
    expect(settle(tavily, extract, { detail: 'bad' }, 400)).toBe(0n);
  });

  it('sends the key as a bearer token', () => {
    const out: OutgoingReq = { origin: TV, headers: {}, query: new URLSearchParams() };
    tavily.injectCredential(out, 'tvly-real');
    expect(out.headers.authorization).toBe('Bearer tvly-real');
  });
});

describe('Exa prices', () => {
  const cases: [string, IncomingReq, bigint][] = [
    ['search, default auto', post(`${EX}/search`, { query: 'x' }), 7_000n],
    ['search, lite', post(`${EX}/search`, { query: 'x', type: 'lite' }), 4_000n],
    ['search, legacy instant', post(`${EX}/search`, { query: 'x', type: 'instant' }), 4_000n],
    ['search, deep', post(`${EX}/search`, { query: 'x', type: 'deep' }), 12_000n],
    [
      'search, deep-reasoning',
      post(`${EX}/search`, { query: 'x', type: 'deep-reasoning' }),
      15_000n,
    ],
    // 25 results: 15 above the 10 included at $1/1k.
    ['search, 25 results', post(`${EX}/search`, { query: 'x', numResults: 25 }), 22_000n],
    [
      'search with text and highlights for 10 results',
      post(`${EX}/search`, {
        query: 'x',
        contents: { text: true, highlights: { maxCharacters: 9 } },
      }),
      27_000n,
    ],
    [
      'search, legacy top-level summary',
      post(`${EX}/search`, { query: 'x', numResults: 5, summary: {} }),
      12_000n,
    ],
    [
      'contents of 3 urls, text by default',
      post(`${EX}/contents`, { urls: ['a', 'b', 'c'] }),
      3_000n,
    ],
    [
      'contents of 2 urls, text + summary',
      post(`${EX}/contents`, { urls: ['a', 'b'], text: true, summary: { query: 'q' } }),
      4_000n,
    ],
    ['answer', post(`${EX}/answer`, { query: 'x' }), 5_000n],
  ];
  it.each(cases)('%s', (_name, r, micros) => expect(price(exa, r)).toBe(micros));

  it('denies unknown types, subpages and unpriced endpoints', () => {
    for (const r of [
      post(`${EX}/search`, { query: 'x', type: 'neural' }),
      post(`${EX}/search`, { query: 'x', numResults: 500 }),
      post(`${EX}/search`, { query: 'x', contents: { subpages: 5 } }),
      post(`${EX}/findSimilar`, { url: 'a' }),
      req('GET', `${EX}/research/v1`),
      post(`${EX}/contents`, {}),
    ]) {
      expect(price(exa, r)).toMatch(/^unpriced/);
    }
  });

  it('settles from costDollars, and at the worst case without it or when streamed', () => {
    const r = post(`${EX}/search`, { query: 'x', numResults: 25 });
    expect(settle(exa, r, { results: [], costDollars: { total: 0.015 } })).toBe(15_000n);
    expect(settle(exa, r, { results: [], costDollars: { total: 0.0071234 } })).toBe(7_124n);
    expect(settle(exa, r, { results: [] })).toBe(22_000n);
    // What Exa bills stands even above the estimate (the proxy flags the catalog).
    expect(settle(exa, r, { costDollars: { total: 0.03 } })).toBe(30_000n);
    const streamed = exa.classify(post(`${EX}/answer`, { query: 'x', stream: true }));
    expect(streamed.priced && exa.needsBody(streamed)).toBe(false);
  });

  it('sends the key as x-api-key and drops a client bearer token', () => {
    const out: OutgoingReq = {
      origin: EX,
      headers: { authorization: 'Bearer client' },
      query: new URLSearchParams(),
    };
    exa.injectCredential(out, 'exa-real');
    expect(out.headers).toEqual({ 'x-api-key': 'exa-real' });
  });
});

describe('Brave prices', () => {
  const cases: [string, IncomingReq, bigint][] = [
    ['web search', req('GET', `${BR}/res/v1/web/search?q=x`), 5_000n],
    ['news search', req('GET', `${BR}/res/v1/news/search?q=x`), 5_000n],
    ['videos search', req('GET', `${BR}/res/v1/videos/search?q=x`), 5_000n],
    ['images search', req('GET', `${BR}/res/v1/images/search?q=x`), 5_000n],
    ['LLM context GET', req('GET', `${BR}/res/v1/llm/context?q=x`), 5_000n],
    ['LLM context POST', post(`${BR}/res/v1/llm/context`, { q: 'x' }), 5_000n],
    ['autosuggest ($5 / 10k)', req('GET', `${BR}/res/v1/suggest/search?q=x`), 500n],
    ['spellcheck ($5 / 10k)', req('GET', `${BR}/res/v1/spellcheck/search?q=x`), 500n],
  ];
  it.each(cases)('%s', (_name, r, micros) => expect(price(brave, r)).toBe(micros));

  it('denies answers, local lookups and the summarizer', () => {
    for (const path of [
      '/res/v1/chat/completions',
      '/res/v1/local/pois',
      '/res/v1/summarizer/search',
    ]) {
      expect(price(brave, req('GET', `${BR}${path}?ids=1`))).toMatch(/^unpriced/);
    }
  });

  it('recognises a rejected token', () => {
    expect(
      brave.credentialRejected({
        status: 422,
        headers: {},
        body: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } },
      }),
    ).toBe(true);
    expect(brave.credentialRejected({ status: 422, headers: {}, body: {} })).toBe(false);
  });
});

describe('SerpApi prices (plan fee / searches)', () => {
  it('prices a search at the configured plan, Starter by default', () => {
    const search = req('GET', `${SP}/search.json?engine=google&q=x`);
    expect(price(serpapi, search)).toBe(25_000n);
    expect(price(new SerpApiAdapter({ plan: 'production' }), search)).toBe(10_000n);
    // $275 / 30,000 rounds up.
    expect(price(new SerpApiAdapter({ plan: 'big_data' }), search)).toBe(9_167n);
    expect(price(serpapi, req('GET', `${SP}/search?engine=bing&q=x`))).toBe(25_000n);
  });

  it('archive, account and locations are free; other paths are denied', () => {
    expect(price(serpapi, req('GET', `${SP}/searches/abc123.json`))).toBe(0n);
    expect(price(serpapi, req('GET', `${SP}/account.json`))).toBe(0n);
    expect(price(serpapi, req('GET', `${SP}/locations.json?q=Austin`))).toBe(0n);
    expect(price(serpapi, req('GET', `${SP}/search/raw`))).toMatch(/^unpriced/);
    expect(price(serpapi, req('POST', `${SP}/search.json`))).toMatch(/^unpriced/);
  });

  it('injects api_key over whatever the client sent', () => {
    const out: OutgoingReq = {
      origin: SP,
      headers: {},
      query: new URLSearchParams('q=x&api_key=client'),
    };
    serpapi.injectCredential(out, 'serp-real');
    expect(out.query.getAll('api_key')).toEqual(['serp-real']);
  });

  it('refuses an unknown plan', () => {
    expect(() => new SerpApiAdapter({ plan: 'gold' as never })).toThrow(/unknown SerpApi plan/);
  });
});
