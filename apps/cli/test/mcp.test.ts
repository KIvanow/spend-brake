import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/io.js';
import { run } from '../src/program.js';
import { type Call, fake } from './fake.js';

const ENV = { BRAKE_URL: 'http://proxy', BRAKE_API_URL: 'http://api', BRAKE_KEY: 'sb_live_parent' };

type Responder = (c: Call) => { status: number; body: unknown; headers?: Record<string, string> };

const found = {
  status: 200,
  body: { results: [{ url: 'https://valkey.io' }] },
  headers: { 'x-brake-cost-micros': '8000', 'x-brake-remaining-micros': '4992000' },
};

interface Reply {
  id: number | null;
  result?: Record<string, unknown> & {
    content?: { text: string }[];
    isError?: boolean;
    tools?: { name: string }[];
  };
  error?: { code: number; message: string };
}

/** Feed messages to `brake mcp` on stdin, close it, and collect every line it wrote. */
async function mcp(
  messages: (object | string)[],
  respond: Responder = () => found,
  opts: { env?: Record<string, string>; args?: string[] } = {},
) {
  const f = fake(opts.env ?? ENV, respond);
  const stdin = new PassThrough();
  f.io.stdin = stdin;
  const done = run(['mcp', ...(opts.args ?? [])], f.io);
  for (const m of messages) stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  stdin.end();
  const code = await done;
  const replies = f.out.map((l) => JSON.parse(l) as Reply);
  const byId = (id: number) => replies.find((r) => r.id === id)!;
  return { code, replies, byId, f };
}

const init = (version = '2025-06-18') => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id: number, name: string, args: object = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('brake mcp', () => {
  it('negotiates the protocol version and lists the spend tools', async () => {
    const m = await mcp([init(), initialized, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect(m.code).toBe(EXIT.ok);
    // The notification gets no answer.
    expect(m.replies).toHaveLength(2);
    expect(String(m.byId(1).result!.instructions)).toContain('do not switch to another tool');
    expect(m.byId(1).result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'spend-brake', title: 'Spend Brake' },
    });
    // jsonArg marks free JSON with a symbol, so the published schema stays plain JSON Schema.
    expect(JSON.stringify(m.byId(2).result!.tools)).not.toContain('x-json');
    expect(m.byId(2).result!.tools!.map((t) => t.name)).toEqual([
      'tavily_search',
      'exa_search',
      'brave_search',
      'serpapi_search',
      'maps_search',
      'maps_nearby',
      'maps_details',
      'maps_geocode',
      'maps_reverse',
      'maps_route',
      'brake_call',
      'brake_budget',
    ]);
    // The searches spend money, and a repeat spends it again; only the budget is read-only.
    const hints = Object.fromEntries(
      (m.byId(2).result!.tools as unknown as { name: string; annotations: object }[]).map((t) => [
        t.name,
        t.annotations,
      ]),
    );
    for (const name of ['tavily_search', 'exa_search']) {
      expect(hints[name]).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    }
    expect(hints.brake_budget).toMatchObject({ readOnlyHint: true });

    const old = await mcp([init('2024-11-05')]);
    expect(old.byId(1).result!.protocolVersion).toBe('2024-11-05');
    const future = await mcp([init('2099-01-01')]);
    expect(future.byId(1).result!.protocolVersion).toBe('2025-11-25');
  });

  it('offers only the providers asked for', async () => {
    const m = await mcp([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], undefined, {
      args: ['--tools', 'exa'],
    });
    expect(m.byId(2).result!.tools!.map((t) => t.name)).toEqual(['exa_search', 'brake_budget']);
    const only = await mcp([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], undefined, {
      args: ['--tools', 'tavily'],
    });
    expect(only.byId(2).result!.tools!.map((t) => t.name)).toEqual([
      'tavily_search',
      'brake_budget',
    ]);
    const f = fake(ENV, () => found);
    f.io.stdin = new PassThrough();
    expect(await run(['mcp', '--tools', 'google'], f.io)).toBe(EXIT.usage);
    const both = fake(ENV, () => found);
    both.io.stdin = new PassThrough();
    expect(await run(['mcp', '--admin', '--tools', 'tavily'], both.io)).toBe(EXIT.usage);
    const owner = fake(ENV, () => found);
    owner.io.stdin = new PassThrough();
    expect(await run(['mcp', '--owner'], owner.io)).toBe(EXIT.usage);
  });

  it('sends a Tavily search through the proxy with cheap defaults and reports the cost', async () => {
    const m = await mcp([init(), call(2, 'tavily_search', { query: 'valkey lua' })]);
    const c = m.f.calls[0]!;
    expect(c.url).toBe('http://proxy/tavily/search');
    expect(c.headers['x-brake-key']).toBe('sb_live_parent');
    expect(JSON.parse(c.body!)).toEqual({
      search_depth: 'basic',
      max_results: 5,
      query: 'valkey lua',
    });
    const r = m.byId(2).result!;
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content![0]!.text)).toMatchObject({
      cost: '$0.0080',
      remaining: '$4.9920',
      result: { results: [{ url: 'https://valkey.io' }] },
    });
    expect(r.structuredContent).toMatchObject({ cost: '$0.0080' });
  });

  it('sends an Exa search, asking for page text only when told', async () => {
    const m = await mcp([
      init('2025-03-26'),
      call(2, 'exa_search', { query: 'q', numResults: 12, type: 'lite' }),
      call(3, 'exa_search', { query: 'q', text: true }),
    ]);
    const bodies = m.f.calls.map((c) => JSON.parse(c.body!) as Record<string, unknown>);
    expect(m.f.calls.every((c) => c.url === 'http://proxy/exa/search')).toBe(true);
    expect(bodies).toContainEqual({ type: 'lite', numResults: 12, query: 'q' });
    expect(bodies).toContainEqual({
      type: 'auto',
      numResults: 5,
      query: 'q',
      contents: { text: true },
    });
    // No structuredContent before 2025-06-18.
    expect(m.byId(2).result!.structuredContent).toBeUndefined();
  });

  it('turns a cap refusal into a STOP the model can read, and never retries', async () => {
    const m = await mcp([init(), call(2, 'tavily_search', { query: 'q' })], () => ({
      status: 402,
      body: { error: 'budget_exceeded', scope: 'sess:sess_ab12', cap: 5_000_000 },
    }));
    expect(m.f.calls).toHaveLength(1);
    expect(m.byId(2).result).toMatchObject({
      isError: true,
      content: [
        {
          text: 'STOP. Spend cap reached for sess:sess_ab12 (cap $5.00). Do not retry; ask the user to raise the cap.',
        },
      ],
    });
  });

  it('rejects bad arguments as a tool error without calling the proxy', async () => {
    const m = await mcp([
      init(),
      call(2, 'tavily_search', {}),
      call(3, 'tavily_search', { query: 'q', max_results: 50 }),
      call(4, 'exa_search', { query: 'q', api_key: 'x' }),
      call(5, 'nope'),
    ]);
    expect(m.f.calls).toHaveLength(0);
    expect(m.byId(2).result!.content![0]!.text).toContain('query is required');
    expect(m.byId(3).result!.content![0]!.text).toContain(
      'max_results must be an integer from 1 to 20',
    );
    expect(m.byId(4).result!.content![0]!.text).toContain('unknown argument api_key');
    expect(m.byId(5).error!.code).toBe(-32602);

    // Names every object has are not arguments either.
    const proto = await mcp([
      init(),
      call(2, 'tavily_search', { query: 'q', constructor: 'x' }),
      call(3, 'exa_search', { query: 'q', toString: 'x' }),
    ]);
    expect(proto.f.calls).toHaveLength(0);
    expect(proto.byId(2).result!.content![0]!.text).toContain('unknown argument constructor');
    expect(proto.byId(3).result!.content![0]!.text).toContain('unknown argument toString');
  });

  it('answers a batch with one array, and an empty batch with an error', async () => {
    const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
    const m = await mcp([
      init('2025-03-26'),
      [initialized, ping(2), ping(3)],
      [],
      [initialized],
      [{ ...init('2025-03-26'), id: 4 }],
    ]);
    // Messages are answered concurrently, so in any order; the all-notification batch, never.
    const out = m.f.out.map((l) => JSON.parse(l) as Reply | Reply[]);
    expect(out).toHaveLength(4);
    expect((out.find((o) => !Array.isArray(o) && o.id === 1) as Reply).result).toMatchObject({
      protocolVersion: '2025-03-26',
    });
    const batches = out.filter((o): o is Reply[] => Array.isArray(o));
    const pings = batches.find((b) => b.length === 2)!;
    expect(pings.map((r) => r.id).sort()).toEqual([2, 3]);
    // initialize may not be part of a batch.
    expect(batches.find((b) => b.length === 1)![0]).toMatchObject({
      id: 4,
      error: { code: -32600 },
    });
    expect((out.find((o) => !Array.isArray(o) && o.id === null) as Reply).error!.code).toBe(-32600);
  });

  it('refuses batches from 2025-06-18 on, where the protocol dropped them', async () => {
    const m = await mcp([init('2025-06-18'), [{ jsonrpc: '2.0', id: 2, method: 'ping' }]]);
    const out = m.f.out.map((l) => JSON.parse(l) as Reply);
    expect(out.find((o) => o.id === null)!.error!.code).toBe(-32600);
    expect(out.some((o) => o.id === 2)).toBe(false);
  });

  it('gives every proxy and budget request a deadline', async () => {
    const m = await mcp(
      [init(), call(2, 'tavily_search', { query: 'q' }), call(3, 'brake_budget')],
      (c) =>
        c.url.endsWith('/v1/me')
          ? { status: 200, body: { keyId: 'k', sessionId: null, killed: false, scopes: [] } }
          : found,
    );
    expect(m.f.calls).toHaveLength(2);
    for (const c of m.f.calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the remaining budget read-only from /v1/me', async () => {
    const m = await mcp([init(), call(2, 'brake_budget')], () => ({
      status: 200,
      body: {
        keyId: 'key_1',
        sessionId: 'sess_1',
        killed: false,
        killedProviders: ['exa'],
        scopes: [
          {
            scope: 'key:key_1',
            window: 'm:2026-11',
            spent: 8000,
            held: 0,
            hard: 5_000_000,
            remaining: 4_992_000,
          },
          {
            scope: 'agent:claude',
            window: 'd:2026-11-07',
            spent: 8000,
            held: 0,
            hard: null,
            remaining: null,
          },
        ],
      },
    }));
    expect(m.f.calls[0]).toMatchObject({ url: 'http://api/v1/me', method: 'GET' });
    expect(JSON.parse(m.byId(2).result!.content![0]!.text)).toEqual({
      killed: false,
      killedProviders: ['exa'],
      notShown: 'Org, environment and SKU caps also apply and are not visible to a key.',
      caps: [
        {
          scope: 'key:key_1',
          window: 'm:2026-11',
          cap: '$5.00',
          spent: '$0.0080',
          held: '$0.0000',
          remaining: '$4.9920',
        },
      ],
    });
  });

  it('explains a missing key on the first call instead of failing to start', async () => {
    const m = await mcp([init(), call(2, 'tavily_search', { query: 'q' })], undefined, {
      env: { BRAKE_URL: 'http://proxy' },
    });
    expect(m.byId(2).result).toMatchObject({ isError: true });
    expect(m.byId(2).result!.content![0]!.text).toContain(
      'add a Spend Brake virtual key to the "env" of its entry',
    );
  });

  it('answers protocol errors and pings', async () => {
    const m = await mcp([
      'not json',
      { jsonrpc: '2.0', id: 7, method: 'resources/list' },
      { jsonrpc: '2.0', id: 8, method: 'ping' },
      { id: 9, method: 'ping' },
    ]);
    expect(m.replies.find((r) => r.id === null)!.error!.code).toBe(-32700);
    expect(m.byId(7).error!.code).toBe(-32601);
    expect(m.byId(8).result).toEqual({});
    expect(m.byId(9).error!.code).toBe(-32600);
    // stdout is protocol only.
    expect(m.f.out.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
  });

  it('reports the session the server was started in, and takes no arguments', async () => {
    const m = await mcp(
      [init(), call(2, 'brake_budget', { scope: 'org' }), call(3, 'brake_budget')],
      () => ({ status: 200, body: { keyId: 'k', sessionId: null, killed: false, scopes: [] } }),
      { env: { ...ENV, BRAKE_SESSION: 'run-7' } },
    );
    expect(m.byId(2).result).toMatchObject({ isError: true });
    expect(m.byId(2).result!.content![0]!.text).toContain('unknown argument scope');
    expect(m.f.calls).toHaveLength(1);
    expect(m.f.calls[0]!.headers['x-brake-session']).toBe('run-7');
  });

  it('tells an unavailable budget from a refused key', async () => {
    const m = await mcp([init(), call(2, 'brake_budget')], () => ({ status: 503, body: {} }));
    expect(m.byId(2).result!.content![0]!.text).toContain('unavailable right now (HTTP 503)');
  });

  it("passes the server's reason through when the budget is refused", async () => {
    const m = await mcp(
      [init(), call(2, 'brake_budget')],
      () => ({
        status: 400,
        body: {
          error: 'invalid_request',
          message: 'This key has no session budget; drop X-Brake-Session.',
        },
      }),
      { env: { ...ENV, BRAKE_SESSION: 'run-7' } },
    );
    expect(m.byId(2).result!.content![0]!.text).toContain(
      'This key has no session budget; drop X-Brake-Session.',
    );
  });

  it('never invites a retry of a search that timed out: it may have been charged', async () => {
    const m = await mcp([init(), call(2, 'exa_search', { query: 'q' })], () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const t = m.byId(2).result!.content![0]!.text;
    expect(m.byId(2).result!.isError).toBe(true);
    expect(t).toMatch(/^STOP\./);
    expect(t).toContain('may already have been forwarded and charged');
    expect(t).toContain('brake_budget');
    expect(t).not.toContain('cannot reach');

    // Any other failure to connect is not a timeout.
    const down = await mcp([init(), call(2, 'exa_search', { query: 'q' })], () => {
      throw new TypeError('fetch failed');
    });
    expect(down.byId(2).result!.content![0]!.text).toContain('cannot reach the proxy');
  });

  it("shows a short excerpt of the provider's error, so the model can fix its arguments", async () => {
    const m = await mcp(
      [init(), call(2, 'tavily_search', { query: 'q' }), call(3, 'exa_search', { query: 'q' })],
      (c) =>
        c.url.includes('/tavily/')
          ? { status: 400, body: { detail: { error: 'Invalid topic' } } }
          : { status: 422, body: `${'x'.repeat(1000)}` },
    );
    const tavily = m.byId(2).result!.content![0]!.text;
    expect(tavily).toContain('HTTP 400');
    expect(tavily).toContain('Invalid topic');
    const exa = m.byId(3).result!.content![0]!.text;
    expect(exa).toContain('HTTP 422');
    expect(exa.length).toBeLessThan(400);
  });

  it('says STOP, with the charge, when the provider timed out behind the proxy', async () => {
    const m = await mcp([init(), call(2, 'tavily_search', { query: 'q' })], () => ({
      status: 504,
      body: { error: 'upstream_timeout', message: 'Provider did not answer in time.' },
      headers: { 'x-brake-cost-micros': '8000', 'x-brake-remaining-micros': '4992000' },
    }));
    const r = m.byId(2).result!;
    expect(r.isError).toBe(true);
    expect(r.content![0]!.text).toMatch(
      /^STOP\. The provider did not answer in time; charged \$0\.0080\./,
    );
    expect(r.content![0]!.text).toContain('do not retry it blindly');
  });

  it('names the charge on any other failed call that was charged', async () => {
    const m = await mcp([init(), call(2, 'exa_search', { query: 'q' })], () => ({
      status: 502,
      body: { error: 'upstream_error', message: 'Bad gateway.' },
      headers: { 'x-brake-cost-micros': '5000' },
    }));
    expect(m.byId(2).result!.content![0]!.text).toContain('charged $0.0050');
  });

  it('sends Brave, SerpApi, Maps and brake_call with the cheap defaults', async () => {
    const m = await mcp([
      init(),
      call(2, 'brave_search', { query: 'coffee' }),
      call(3, 'serpapi_search', { query: 'coffee', engine: 'bing', num: 3 }),
      call(4, 'maps_search', { query: 'pizza' }),
      call(5, 'maps_nearby', { lat: '42.7', lng: '23.3' }),
      call(6, 'maps_details', { placeId: 'ChIJabc' }),
      call(7, 'maps_geocode', { address: '1 Main St' }),
      call(8, 'maps_reverse', { lat: '42.7', lng: '23.3' }),
      call(9, 'maps_route', { origin: 'Sofia', destination: '42.14,24.75' }),
      call(10, 'brake_call', {
        provider: 'mapbox',
        method: 'GET',
        path: '/styles/v1/mapbox/streets-v12',
        query: { limit: '1' },
      }),
    ]);
    // Calls run concurrently, so match each request rather than the arrival order.
    const seen = m.f.calls.map((c) => {
      const u = new URL(c.url);
      return {
        method: c.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        body: c.body ? (JSON.parse(c.body) as unknown) : undefined,
        mask: c.headers['x-goog-fieldmask'],
      };
    });
    const one = (path: string, queryKey?: string) => {
      const hits = seen.filter((s) => s.path === path && (!queryKey || queryKey in s.query));
      expect(hits).toHaveLength(1);
      return hits[0]!;
    };
    expect(seen).toHaveLength(9);
    expect(one('/brave/res/v1/web/search')).toMatchObject({
      method: 'GET',
      query: { q: 'coffee' },
    });
    expect(one('/serpapi/search.json')).toMatchObject({
      method: 'GET',
      query: { engine: 'bing', q: 'coffee', num: '3' },
    });
    expect(one('/google-places/v1/places:searchText')).toMatchObject({
      method: 'POST',
      body: { textQuery: 'pizza' },
      mask: 'places.id,places.name',
    });
    expect(one('/google-places/v1/places:searchNearby')).toMatchObject({
      method: 'POST',
      body: {
        locationRestriction: {
          circle: { center: { latitude: 42.7, longitude: 23.3 }, radius: 500 },
        },
      },
      mask: 'places.id,places.displayName,places.formattedAddress,places.location',
    });
    expect(one('/google-places/v1/places/ChIJabc')).toMatchObject({
      method: 'GET',
      mask: 'id,formattedAddress,location,types',
    });
    expect(one('/google-maps/maps/api/geocode/json', 'address')).toMatchObject({
      method: 'GET',
      query: { address: '1 Main St' },
    });
    expect(one('/google-maps/maps/api/geocode/json', 'latlng')).toMatchObject({
      method: 'GET',
      query: { latlng: '42.7,23.3' },
    });
    expect(one('/google-routes/directions/v2:computeRoutes')).toMatchObject({
      method: 'POST',
      body: {
        origin: { address: 'Sofia' },
        destination: { location: { latLng: { latitude: 42.14, longitude: 24.75 } } },
        travelMode: 'DRIVE',
      },
      mask: 'routes.duration,routes.distanceMeters',
    });
    expect(one('/mapbox/styles/v1/mapbox/streets-v12')).toMatchObject({
      method: 'GET',
      query: { limit: '1' },
    });
  });

  it('refuses a brake_call that would read a file, spoof the key, or leave the provider', async () => {
    const m = await mcp([
      init(),
      call(2, 'brake_call', { provider: '..', method: 'GET', path: '/x' }),
      call(3, 'brake_call', { provider: 'foo/bar', method: 'GET', path: '/x' }),
      call(4, 'brake_call', {
        provider: 'mapbox',
        method: 'POST',
        path: '/x',
        body: '@secret.json',
      }),
      call(5, 'brake_call', {
        provider: 'mapbox',
        method: 'GET',
        path: '/x',
        headers: { 'X-Brake-Key': 'sb_live_stolen' },
      }),
    ]);
    expect(m.f.calls).toHaveLength(0);
    expect(m.byId(2).result!.content![0]!.text).toContain('invalid provider');
    expect(m.byId(3).result!.content![0]!.text).toContain('invalid provider');
    expect(m.byId(4).result!.content![0]!.text).toContain('cannot read a file');
    expect(m.byId(5).result!.content![0]!.text).toContain(
      'X-Brake-Key is set by the server from BRAKE_KEY',
    );
  });

  it('keeps admin tools on their own server, and owner tools behind --owner', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const listed = await mcp([init(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }], undefined, {
      args: ['--admin'],
      env,
    });
    const adminNames = listed.byId(2).result!.tools!.map((t) => t.name);
    expect(adminNames).toContain('kill');
    expect(adminNames).toContain('caps_list');
    expect(adminNames).not.toContain('tavily_search');
    expect(adminNames).not.toContain('tokens_create');
    expect(listed.byId(1).result!.serverInfo).toMatchObject({ title: 'Spend Brake admin' });
    const owner = await mcp([init(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }], undefined, {
      args: ['--admin', '--owner'],
      env,
    });
    expect(owner.byId(2).result!.tools!.map((t) => t.name)).toContain('tokens_create');
  });

  it('warns when the spend server can see an admin token, and still lists only spend tools', async () => {
    const m = await mcp([init(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }], undefined, {
      env: { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' },
    });
    expect(m.f.err.join('')).toContain('Admin tools are not offered here');
    expect(m.f.err.join('')).toContain('BRAKE_ADMIN_TOKEN is set on the spend server');
    expect(m.f.out.join('')).not.toContain('Admin tools are not offered here');
    const names = m.byId(2).result!.tools!.map((t) => t.name);
    expect(names).toContain('tavily_search');
    expect(names).not.toContain('kill');
  });

  it('lists caps, passes a pending cap change through, and maps a 403', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const caps = await mcp(
      [init(), call(2, 'caps_list'), call(3, 'caps_set', { scope: 'org', day: '5' })],
      (c) =>
        c.url.endsWith('/v1/caps')
          ? { status: 200, body: { items: [] } }
          : { status: 200, body: { pending: true, scope: 'org' } },
      { args: ['--admin'], env },
    );
    const listed = caps.f.calls.find((c) => c.url === 'http://api/v1/caps')!;
    const set = caps.f.calls.find((c) => c.url === 'http://api/v1/caps/org')!;
    expect(listed).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer sbt_test' },
    });
    expect(JSON.parse(caps.byId(2).result!.content![0]!.text)).toEqual({ items: [] });
    expect(set).toMatchObject({ method: 'PUT' });
    // Only the hard cap was given: the soft value is the current one (none here).
    expect(JSON.parse(set.body!)).toEqual({ day: { hard: '5000000', soft: null } });
    expect(JSON.parse(caps.byId(3).result!.content![0]!.text)).toMatchObject({ pending: true });

    const refused = await mcp(
      [init(), call(2, 'kill', { target: 'org' })],
      () => ({
        status: 403,
        body: { error: 'license_required', message: 'This install does not include that feature.' },
      }),
      { args: ['--admin'], env },
    );
    expect(refused.f.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api/v1/kill',
    });
    expect(JSON.parse(refused.f.calls[0]!.body!)).toEqual({ target: 'org' });
    expect(refused.byId(2).result).toMatchObject({ isError: true });
    expect(refused.byId(2).result!.content![0]!.text).toContain(
      'This install does not include that feature.',
    );
  });

  it('caps_set keeps the value a window is not given, instead of removing it', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const m = await mcp(
      [
        init(),
        // An alert only: the $10 hard cap must stay. A hard cap only: the $8 alert must stay.
        call(2, 'caps_set', { scope: 'key:abc', softDay: '8' }),
        call(3, 'caps_set', { scope: 'key:abc', month: '50' }),
      ],
      (c) =>
        c.method === 'GET'
          ? {
              status: 200,
              body: {
                items: [
                  { scope: 'key:abc', kind: 'd', hard: 10_000_000, soft: null },
                  { scope: 'key:abc', kind: 'm', hard: 40_000_000, soft: 8_000_000 },
                  { scope: 'org', kind: 'd', hard: 1, soft: 1 },
                ],
              },
            }
          : { status: 200, body: { items: [] } },
      { args: ['--admin'], env },
    );
    const puts = m.f.calls
      .filter((c) => c.method === 'PUT')
      .map((c) => JSON.parse(c.body!) as unknown);
    expect(puts).toContainEqual({ day: { hard: '10000000', soft: '8000000' } });
    expect(puts).toContainEqual({ month: { hard: '50000000', soft: '8000000' } });
  });

  it('says an admin write that timed out may have been applied', async () => {
    const m = await mcp(
      [init(), call(2, 'kill', { target: 'org' })],
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      { args: ['--admin'], env: { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' } },
    );
    const t = m.byId(2).result!.content![0]!.text;
    expect(m.byId(2).result!.isError).toBe(true);
    expect(t).toContain('A change might have been applied: check before sending it again.');
  });

  it('says an admin read that timed out changed nothing', async () => {
    const m = await mcp(
      [init(), call(2, 'keys_list', {})],
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      { args: ['--admin'], env: { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' } },
    );
    const t = m.byId(2).result!.content![0]!.text;
    expect(m.byId(2).result!.isError).toBe(true);
    expect(t).toContain('Nothing was changed.');
    expect(t).not.toContain('might have been applied');
  });

  it('refuses a brake_call path with dot segments, and sends a string body as JSON', async () => {
    const bad = await mcp([
      init(),
      call(2, 'brake_call', { provider: 'brave', method: 'GET', path: '/../google-places/v1/x' }),
      call(3, 'brake_call', { provider: 'brave', method: 'GET', path: '/a/%2e%2e/%2E%2E/x' }),
      call(4, 'brake_call', { provider: 'brave', method: 'GET', path: '/a\\..\\x' }),
      call(5, 'brake_call', {
        provider: 'mapbox',
        method: 'GET',
        path: '/x',
        headers: { ' X-Brake-Session': 'x' },
      }),
    ]);
    expect(bad.f.calls).toHaveLength(0);
    for (const id of [2, 3, 4]) {
      expect(bad.byId(id).result!.content![0]!.text).toContain('must not contain . or ..');
    }
    expect(bad.byId(5).result!.content![0]!.text).toContain('is set by the server from BRAKE_KEY');

    const sent = await mcp([
      init(),
      call(2, 'brake_call', { provider: 'mapbox', method: 'POST', path: '/x', body: 'hello' }),
    ]);
    expect(sent.f.calls[0]!.body).toBe('"hello"');
  });

  it('publishes a nullable alertEmail as JSON Schema, and sends null to clear it', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const m = await mcp(
      [
        init(),
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        call(3, 'org_update', { alertEmail: null }),
      ],
      () => ({ status: 200, body: { ok: true } }),
      { args: ['--admin', '--owner'], env },
    );
    const tools = m.byId(2).result!.tools as unknown as {
      name: string;
      inputSchema: { properties: Record<string, { type: unknown; nullable?: unknown }> };
    }[];
    const email = tools.find((t) => t.name === 'org_update')!.inputSchema.properties.alertEmail!;
    expect(email.type).toEqual(['string', 'null']);
    expect(email.nullable).toBeUndefined();
    expect(JSON.parse(m.f.calls[0]!.body!)).toEqual({ alertEmail: null });
  });

  it('strips show fields from a custom API write and refuses a mismatched id', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const shown = {
      id: 'acme',
      name: 'Acme',
      origin: 'https://acme.example',
      auth: { type: 'header', name: 'Authorization' },
      routes: [],
      billed: '2xx',
      timeoutBilled: false,
      proxyPath: '/custom/acme',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const kept = {
      id: 'acme',
      name: 'Acme',
      origin: 'https://acme.example',
      auth: { type: 'header', name: 'Authorization' },
      routes: [],
      billed: '2xx',
      timeoutBilled: false,
    };
    const m = await mcp(
      [
        init(),
        call(2, 'custom_apis_add', { definition: shown }),
        call(3, 'custom_apis_update', { id: 'acme', definition: shown }),
      ],
      // The update reads the current definition first (same origin here).
      (c) =>
        c.method === 'GET' ? { status: 200, body: shown } : { status: 200, body: { id: 'acme' } },
      { args: ['--admin'], env },
    );
    const post = m.f.calls.find((c) => c.method === 'POST')!;
    const put = m.f.calls.find((c) => c.method === 'PUT')!;
    expect(post).toMatchObject({ url: 'http://api/v1/custom-apis' });
    expect(JSON.parse(post.body!)).toEqual(kept);
    expect(put).toMatchObject({ url: 'http://api/v1/custom-apis/acme' });
    const updated = Object.fromEntries(Object.entries(kept).filter(([k]) => k !== 'id'));
    expect(JSON.parse(put.body!)).toEqual(updated);

    const bad = await mcp(
      [
        init(),
        call(2, 'custom_apis_update', { id: 'acme', definition: { ...shown, id: 'other' } }),
      ],
      () => ({ status: 200, body: {} }),
      { args: ['--admin'], env },
    );
    expect(bad.f.calls).toHaveLength(0);
    expect(bad.byId(2).result).toMatchObject({ isError: true });
    expect(bad.byId(2).result!.content![0]!.text).toContain('"other"');
  });

  it('sends a provider secret and does not echo it', async () => {
    const secret = 'tvly-secret-value';
    const m = await mcp(
      [init(), call(2, 'credentials_add', { provider: 'tavily', name: 'main', secret })],
      () => ({ status: 201, body: { id: 'cred_1', provider: 'tavily', name: 'main' } }),
      { args: ['--admin'], env: { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' } },
    );
    expect(JSON.parse(m.f.calls[0]!.body!)).toMatchObject({ secret });
    expect(m.byId(2).result!.content![0]!.text).not.toContain(secret);
    expect(m.f.err.join('')).not.toContain(secret);
    expect(m.f.out.join('')).not.toContain(secret);
  });

  it('explains a missing admin token on the first call instead of failing to start', async () => {
    const m = await mcp([init(), call(2, 'caps_list')], undefined, {
      args: ['--admin'],
      env: { BRAKE_API_URL: 'http://api' },
    });
    expect(m.f.calls).toHaveLength(0);
    expect(m.byId(2).result).toMatchObject({ isError: true });
    expect(m.byId(2).result!.content![0]!.text).toContain(
      'add an admin token to the "env" of its entry',
    );
  });

  it('pages through a cut audit export from the last line kept', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    // Audit lines carry their row id, which is what the cursor is.
    const page = (n: number) =>
      `${Array.from({ length: n }, (_, i) => JSON.stringify({ id: String(1000 + i) })).join('\n')}\n`;
    const cut = await mcp(
      [init(), call(2, 'audit_export')],
      () => ({ status: 200, body: page(5000), headers: { 'x-next-cursor': '5999' } }),
      { args: ['--admin'], env },
    );
    const cutBody = JSON.parse(cut.byId(2).result!.content![0]!.text) as {
      lines: string[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(cutBody.truncated).toBe(true);
    expect(cutBody.lines).toHaveLength(200);
    // Not the API's cursor (it would skip lines 200 to 4999): the last line kept.
    expect(cutBody.nextCursor).toBe('1199');

    const whole = await mcp(
      [init(), call(2, 'audit_export')],
      () => ({ status: 200, body: page(1), headers: { 'x-next-cursor': 'page-2' } }),
      { args: ['--admin'], env },
    );
    expect(JSON.parse(whole.byId(2).result!.content![0]!.text)).toMatchObject({
      truncated: false,
      nextCursor: 'page-2',
      lines: ['{"id":"1000"}'],
    });
  });

  it('keeps stored secrets with their host: telemetry headers and custom API origins', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const stored = {
      otlp: {
        endpoint: 'https://otlp.honeycomb.io/v1/traces',
        enabled: false,
        headerNames: ['x-api-key'],
      },
    };
    const m = await mcp(
      [
        init(),
        // Another host, no headers: refused, nothing written.
        call(2, 'telemetry_set', { endpoint: 'https://evil.example/v1/traces' }),
        // Same host, no headers: kept, and a disabled export stays disabled.
        call(3, 'telemetry_set', { endpoint: 'https://otlp.honeycomb.io/v2/traces' }),
        // Another host with headers given again: allowed.
        call(4, 'telemetry_set', { endpoint: 'https://collector.example', headers: {} }),
      ],
      (c) =>
        c.method === 'GET' ? { status: 200, body: stored } : { status: 200, body: { otlp: null } },
      { args: ['--admin'], env },
    );
    expect(m.byId(2).result!.content![0]!.text).toContain('give headers again');
    const puts = m.f.calls
      .filter((c) => c.method === 'PUT')
      .map((c) => JSON.parse(c.body!) as unknown);
    expect(puts).toEqual([
      { endpoint: 'https://otlp.honeycomb.io/v2/traces', enabled: false },
      { endpoint: 'https://collector.example', headers: {}, enabled: false },
    ]);

    const shown = { id: 'acme', name: 'Acme', origin: 'https://acme.example', routes: [] };
    const moved = { ...shown, origin: 'https://evil.example' };
    const c = await mcp(
      [
        init(),
        call(2, 'custom_apis_update', { id: 'acme', definition: moved }),
        call(3, 'custom_apis_update', { id: 'acme', definition: moved, moveOrigin: true }),
      ],
      (r) => (r.method === 'GET' ? { status: 200, body: shown } : { status: 200, body: moved }),
      { args: ['--admin'], env },
    );
    expect(c.byId(2).result!.content![0]!.text).toContain('Pass moveOrigin: true');
    expect(c.f.calls.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it('marks the tools that loosen spend or reach outside hosts as destructive', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const hints = async (args: string[], e: Record<string, string>) => {
      const m = await mcp([init(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }], undefined, {
        args,
        env: e,
      });
      const tools = m.byId(2).result!.tools as unknown as {
        name: string;
        annotations: { destructiveHint?: boolean; openWorldHint?: boolean };
      }[];
      return Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    };
    const owner = await hints(['--admin', '--owner'], env);
    for (const name of [
      'caps_set',
      'keys_resume',
      'org_update',
      'sso_set',
      'users_update',
      'license_install',
      'telemetry_set',
      'custom_apis_update',
    ]) {
      expect(owner[name]!.destructiveHint, name).toBe(true);
    }
    expect(owner.telemetry_set!.openWorldHint).toBe(true);
    expect(owner.custom_apis_update!.openWorldHint).toBe(true);
    // The owner-only policy route is offered with --owner only; listing people needs admin.
    const adminOnly = await hints(['--admin'], env);
    expect(adminOnly.approvals_set_policy).toBeUndefined();
    expect(owner.approvals_set_policy).toBeDefined();
    expect(adminOnly.users_list).toBeDefined();
    const spend = await hints([], ENV);
    expect(spend.brake_call!.destructiveHint).toBe(true);
  });

  it('names the field an admin request failed on, and converts dollars to micros', async () => {
    const env = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' };
    const refused = await mcp(
      [init(), call(2, 'keys_list')],
      () => ({
        status: 400,
        body: {
          error: 'invalid_request',
          message: 'Request failed validation.',
          issues: [{ in: 'body', path: 'expiresAt', message: 'Invalid ISO datetime' }],
        },
      }),
      { args: ['--admin'], env },
    );
    expect(refused.byId(2).result!.content![0]!.text).toBe(
      'Request failed validation. (expiresAt: Invalid ISO datetime)',
    );

    const minted = await mcp(
      [init(), call(2, 'sessions_mint', { parentKeyId: 'key_p', budget: '1.25', dayBudget: '10' })],
      () => ({ status: 201, body: { sessionId: 's', keyId: 'k', token: 't' } }),
      { args: ['--admin'], env },
    );
    expect(JSON.parse(minted.f.calls[0]!.body!)).toMatchObject({
      parentKeyId: 'key_p',
      budgetMicros: '1250000',
      dayBudgetMicros: '10000000',
    });
  });

  it('answers a timeout while caps_set reads the current caps as a tool error', async () => {
    const m = await mcp(
      [init(), call(2, 'caps_set', { scope: 'org', softDay: '1' })],
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      { args: ['--admin'], env: { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' } },
    );
    expect(m.byId(2).result).toMatchObject({ isError: true });
    expect(m.byId(2).result!.content![0]!.text).toContain('Nothing was changed');
  });

  it('cuts metrics at a line end', async () => {
    const line = 'brake_requests_total{provider="x"} 1\n';
    const body = line.repeat(Math.ceil(110_000 / line.length));
    const m = await mcp([init(), call(2, 'metrics')], () => ({ status: 200, body }), {
      args: ['--admin'],
      env: { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_test' },
    });
    const out = JSON.parse(m.byId(2).result!.content![0]!.text) as {
      text: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith('\n')).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(100_001);
  });
});
