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
  it('negotiates the protocol version and lists its three tools', async () => {
    const m = await mcp([init(), initialized, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect(m.code).toBe(EXIT.ok);
    // The notification gets no answer.
    expect(m.replies).toHaveLength(2);
    expect(String(m.byId(1).result!.instructions)).toContain(
      'do not switch to the other search tool',
    );
    expect(m.byId(1).result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'spend-brake' },
    });
    expect(m.byId(2).result!.tools!.map((t) => t.name)).toEqual([
      'tavily_search',
      'exa_search',
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
    const f = fake(ENV, () => found);
    f.io.stdin = new PassThrough();
    expect(await run(['mcp', '--tools', 'google'], f.io)).toBe(EXIT.usage);
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
});
