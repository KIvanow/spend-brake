import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { EXIT, durationSec, microsToUsd, usdToMicros } from '../src/io.js';
import { run } from '../src/program.js';
import { type Call, fake } from './fake.js';

const ENV = { BRAKE_URL: 'http://proxy', BRAKE_API_URL: 'http://api', BRAKE_KEY: 'sb_live_parent' };
const ok = {
  status: 200,
  body: { results: [] },
  headers: {
    'x-brake-cost-micros': '5000',
    'x-brake-remaining-micros': '4995000',
    'x-brake-request-id': 'r1',
  },
};

describe('money and durations', () => {
  it('parses dollars exactly and prints micros as dollars', () => {
    expect(usdToMicros('5')).toBe(5_000_000n);
    expect(usdToMicros('0.012')).toBe(12_000n);
    expect(usdToMicros('$20.50')).toBe(20_500_000n);
    expect(() => usdToMicros('1e3')).toThrow();
    expect(microsToUsd(5000)).toBe('$0.0050');
    expect(microsToUsd(25_000_000, 2)).toBe('$25.00');
    expect(durationSec('12h')).toBe(43_200);
    expect(durationSec('90')).toBe(90);
    expect(() => durationSec('soon')).toThrow();
  });
});

describe('brake maps', () => {
  const runMaps = async (args: string[], env: Record<string, string> = ENV) => {
    const f = fake(env, () => ok);
    const code = await run(['maps', ...args], f.io);
    return { code, call: f.calls[0]!, f };
  };
  const json = (c: Call) => JSON.parse(c.body!) as unknown;

  it('search: IDs-only field mask by default (free), --fields opts in', async () => {
    const { code, call, f } = await runMaps(['search', 'pizza', 'in', 'Sofia', '--limit', '5']);
    expect(code).toBe(0);
    expect(call).toMatchObject({
      url: 'http://proxy/google-places/v1/places:searchText',
      method: 'POST',
    });
    expect(call.headers).toMatchObject({
      'x-brake-key': 'sb_live_parent',
      'x-goog-fieldmask': 'places.id,places.name',
    });
    expect(json(call)).toEqual({ textQuery: 'pizza in Sofia', pageSize: 5 });
    expect(JSON.parse(f.out[0]!)).toMatchObject({
      ok: true,
      status: 200,
      costMicros: 5000,
      cost: '$0.0050',
      remainingMicros: 4995000,
      requestId: 'r1',
    });
    const custom = await runMaps(['search', 'x', '--fields', 'places.displayName']);
    expect(custom.call.headers['x-goog-fieldmask']).toBe('places.displayName');
  });

  it('nearby, details, geocode, reverse and route build the right requests', async () => {
    const nearby = await runMaps([
      'nearby',
      '--lat',
      '42.69',
      '--lng',
      '23.32',
      '--radius',
      '300',
      '--type',
      'cafe',
    ]);
    expect(json(nearby.call)).toEqual({
      locationRestriction: {
        circle: { center: { latitude: 42.69, longitude: 23.32 }, radius: 300 },
      },
      includedTypes: ['cafe'],
    });
    const details = await runMaps(['details', 'ChIJabc']);
    expect(details.call).toMatchObject({
      url: 'http://proxy/google-places/v1/places/ChIJabc',
      method: 'GET',
    });
    expect(details.call.headers['x-goog-fieldmask']).toBe('id,formattedAddress,location,types');
    expect((await runMaps(['geocode', '1', 'Main', 'St'])).call.url).toBe(
      'http://proxy/google-maps/maps/api/geocode/json?address=1+Main+St',
    );
    expect((await runMaps(['reverse', '42.69', '23.32'])).call.url).toBe(
      'http://proxy/google-maps/maps/api/geocode/json?latlng=42.69%2C23.32',
    );
    const route = await runMaps(['route', '42.69,23.32', 'Plovdiv', '--mode', 'walk']);
    expect(json(route.call)).toEqual({
      origin: { location: { latLng: { latitude: 42.69, longitude: 23.32 } } },
      destination: { address: 'Plovdiv' },
      travelMode: 'WALK',
    });
    expect(route.call.headers['x-goog-fieldmask']).toBe('routes.duration,routes.distanceMeters');
  });

  it('sends the session header when BRAKE_SESSION is set', async () => {
    const { call } = await runMaps(['geocode', 'x'], { ...ENV, BRAKE_SESSION: 'run-1' });
    expect(call.headers['x-brake-session']).toBe('run-1');
  });

  it('rejects bad input with exit 2 and a missing key with exit 5', async () => {
    expect((await runMaps(['nearby', '--lat', 'north', '--lng', '1'])).code).toBe(EXIT.usage);
    expect((await runMaps(['route', 'a', 'b', '--mode', 'teleport'])).code).toBe(EXIT.usage);
    expect((await runMaps(['details', '../admin'])).code).toBe(EXIT.usage);
    const noKey = await runMaps(['geocode', 'x'], { BRAKE_URL: 'http://proxy' });
    expect(noKey.code).toBe(EXIT.auth);
  });

  it('prints a human summary with --pretty', async () => {
    const { f } = await runMaps(['geocode', 'x', '--pretty']);
    expect(f.out[0]).toMatch(/^HTTP 200 · cost \$0\.0050 · remaining \$4\.99\n/);
  });
});

describe('exit codes for proxy refusals', () => {
  const refuse = async (status: number, body: unknown) => {
    const f = fake(ENV, () => ({ status, body }));
    const code = await run(['maps', 'geocode', 'x'], f.io);
    return { code, err: f.err.join('') };
  };

  it.each([
    [
      402,
      { error: 'budget_exceeded', scope: 'sess:s1', cap: 5_000_000 },
      EXIT.budget,
      /STOP\. Spend cap reached for sess:s1 \(cap \$5\.00\)/,
    ],
    [
      403,
      { error: 'killed', target: 'key:k1' },
      EXIT.budget,
      /STOP\. Spending is switched off for key:k1/,
    ],
    [402, { error: 'unpriced_route' }, EXIT.budget, /no known price/],
    [429, { error: 'loop_detected', retryAfter: 600 }, EXIT.loop, /paused for 600 s/],
    [
      401,
      { error: 'invalid_key', message: 'Unknown or revoked virtual key.' },
      EXIT.auth,
      /revoked/,
    ],
    [500, { error: 'internal_error', message: 'boom' }, EXIT.error, /HTTP 500: boom/],
    [400, { error: { message: 'Invalid request' } }, EXIT.error, /HTTP 400/],
  ])('HTTP %i → exit %i', async (status, body, code, message) => {
    const r = await refuse(status, body);
    expect(r.code).toBe(code);
    expect(r.err).toMatch(message);
    expect(r.err.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('brake call', () => {
  it('sends any capped request through the proxy', async () => {
    const f = fake(ENV, () => ok);
    const code = await run(
      [
        'call',
        'acme',
        'post',
        '/v1/search',
        '-d',
        '{"q":"x"}',
        '-q',
        'lang=en',
        '-H',
        'X-Trace: 1',
        '-H',
        'X-Brake-Key: sb_live_spoof',
      ],
      f.io,
    );
    expect(code).toBe(0);
    expect(f.calls[0]).toMatchObject({
      url: 'http://proxy/acme/v1/search?lang=en',
      method: 'POST',
      body: '{"q":"x"}',
      headers: {
        'x-trace': '1',
        'content-type': 'application/json',
        'x-brake-key': 'sb_live_parent',
      },
    });
  });

  it('calls a custom API under /custom/<id>', async () => {
    const f = fake(ENV, () => ok);
    expect(await run(['call', 'custom/acme', 'get', '/v1/items'], f.io)).toBe(0);
    expect(f.calls[0]).toMatchObject({ url: 'http://proxy/custom/acme/v1/items', method: 'GET' });
  });

  it('validates its input', async () => {
    for (const args of [
      ['call', 'acme', 'TRACE', '/x'],
      ['call', 'acme', 'GET', 'x'],
      ['call', '../evil', 'GET', '/x'],
      ['call', 'custom/..', 'GET', '/x'],
      ['call', 'custom/a/b', 'GET', '/x'],
      ['call', 'other/acme', 'GET', '/x'],
      ['call', 'acme', 'POST', '/x', '-d', '{not json'],
    ]) {
      const f = fake(ENV, () => ok);
      expect(await run(args, f.io), args.join(' ')).toBe(EXIT.usage);
      expect(f.calls).toHaveLength(0);
    }
  });
});

describe('brake session', () => {
  const minted = {
    sessionId: 'sess_abc',
    keyId: 'key_child',
    token: 'sb_live_child',
    agentId: 'cli',
    budgetMicros: 5_000_000,
    dayBudgetMicros: 20_000_000,
    expiresAt: '2026-10-30T00:00:00Z',
  };
  const api = (c: Call) =>
    c.method === 'POST'
      ? { status: 201, body: minted }
      : {
          status: 200,
          body: { sessionId: 'sess_abc', keyId: 'key_child', spentMicros: 12_000, heldMicros: 0 },
        };

  it('warns when the command could read a saved admin token', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'brake-warn-'));
    // It holds an admin-token config: removed whether or not the test passes.
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, '.config', 'brake'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'brake', 'config.json'),
      JSON.stringify({ adminToken: 'sbt_x' }),
    );
    const f = fake({ ...ENV, HOME: home }, api);
    expect(await run(['session', '--', 'true'], f.io)).toBe(0);
    expect(f.err[0]).toContain('holds an admin token the command can read');

    // Another XDG_CONFIG_HOME hides the default config from brake, not from the command.
    const elsewhere = fake({ ...ENV, HOME: home, XDG_CONFIG_HOME: join(home, 'other') }, api);
    expect(await run(['session', '--', 'true'], elsewhere.io)).toBe(0);
    expect(elsewhere.err[0]).toContain(join(home, '.config', 'brake', 'config.json'));

    // Not JSON brake can parse is still text the command can read.
    writeFileSync(
      join(home, '.config', 'brake', 'config.json'),
      `{"adminToken": "sbt_${'a1B2'.repeat(8)}",}\n`,
    );
    const broken = fake({ ...ENV, HOME: home }, api);
    expect(await run(['session', '--', 'true'], broken.io)).toBe(0);
    expect(broken.err[0]).toContain('holds an admin token the command can read');
    expect(broken.err.join('')).not.toContain('a1B2');

    // A config that is JSON but not an object warns of nothing, and the session still ends.
    for (const text of ['null', '[]', '42']) {
      writeFileSync(join(home, '.config', 'brake', 'config.json'), text);
      const odd = fake({ ...ENV, HOME: home, XDG_CONFIG_HOME: join(home, 'other') }, api);
      expect(await run(['session', '--', 'true'], odd.io), text).toBe(0);
      expect(odd.err.join(''), text).not.toContain('admin token');
      expect(odd.calls.at(-1)?.method, text).toBe('DELETE');
    }
  });

  it('mints a key, runs the command with it, revokes it and passes the exit code through', async () => {
    const f = fake({ ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_should_not_leak' }, api, 3);
    const code = await run(
      [
        'session',
        '--budget',
        '0.50',
        '--day-budget',
        '2',
        '--agent',
        'claude',
        '--',
        'claude',
        '-p',
        'hi',
      ],
      f.io,
    );
    expect(code).toBe(3);
    expect(f.calls[0]).toMatchObject({
      url: 'http://api/v1/sessions',
      method: 'POST',
      headers: { 'x-brake-key': 'sb_live_parent' },
    });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({
      budgetMicros: '500000',
      dayBudgetMicros: '2000000',
      ttlSec: 43_200,
      agentId: 'claude',
    });
    expect(f.spawned[0]).toMatchObject({ cmd: 'claude', args: ['-p', 'hi'] });
    expect(f.spawned[0]!.env).toMatchObject({
      BRAKE_KEY: 'sb_live_child',
      BRAKE_SESSION: 'sess_abc',
      BRAKE_URL: 'http://proxy',
    });
    expect(f.spawned[0]!.env.BRAKE_ADMIN_TOKEN).toBeUndefined();
    expect(f.calls[1]).toMatchObject({
      url: 'http://api/v1/sessions/key_child',
      method: 'DELETE',
      headers: { 'x-brake-key': 'sb_live_child' },
    });
    expect(JSON.parse(f.err.at(-1)!)).toEqual({
      brakeSession: {
        session: 'sess_abc',
        keyId: 'key_child',
        exitCode: 3,
        spentMicros: 12000,
        spent: '$0.0120',
        budget: '$5.00',
      },
    });
  });

  it('can mint with an admin token and a parent key id', async () => {
    const f = fake({ BRAKE_API_URL: 'http://api', BRAKE_ADMIN_TOKEN: 'sbt_x' }, api);
    expect(await run(['session', '--parent-key', 'key_parent', '--', 'true'], f.io)).toBe(0);
    expect(f.calls[0]!.headers.authorization).toBe('Bearer sbt_x');
    expect(JSON.parse(f.calls[0]!.body!)).toMatchObject({
      parentKeyId: 'key_parent',
      budgetMicros: '5000000',
      dayBudgetMicros: '20000000',
    });
    const missing = fake({ BRAKE_API_URL: 'http://api', BRAKE_ADMIN_TOKEN: 'sbt_x' }, api);
    expect(await run(['session', '--', 'true'], missing.io)).toBe(EXIT.usage);
  });

  it('does not run the command when minting fails', async () => {
    const f = fake(ENV, () => ({
      status: 403,
      body: { error: 'forbidden', message: 'This key may not mint sessions (canMintSessions).' },
    }));
    expect(await run(['session', '--', 'true'], f.io)).toBe(EXIT.error);
    expect(f.spawned).toHaveLength(0);
    expect(f.err.join('')).toContain('canMintSessions');
  });
});

describe('brake search', () => {
  const runSearch = async (args: string[]) => {
    const f = fake(ENV, () => ok);
    const code = await run(['search', ...args], f.io);
    return { code, call: f.calls[0]!, f };
  };

  it('builds the cheapest search per provider and prints the cost', async () => {
    const tavily = await runSearch(['tavily', 'spend', 'caps', '--results', '3']);
    expect(tavily.code).toBe(0);
    expect(tavily.call).toMatchObject({ url: 'http://proxy/tavily/search', method: 'POST' });
    expect(tavily.call.headers['x-brake-key']).toBe('sb_live_parent');
    expect(JSON.parse(tavily.call.body!)).toEqual({
      query: 'spend caps',
      search_depth: 'basic',
      max_results: 3,
    });
    expect(JSON.parse(tavily.f.out[0]!)).toMatchObject({ costMicros: 5000, cost: '$0.0050' });

    const exa = await runSearch(['exa', 'llm', 'evals', '--type', 'lite']);
    expect(JSON.parse(exa.call.body!)).toEqual({ query: 'llm evals', type: 'lite' });
    expect(exa.call.url).toBe('http://proxy/exa/search');

    const brave = await runSearch(['brave', 'a b', '--results', '5']);
    expect(brave.call.url).toBe('http://proxy/brave/res/v1/web/search?q=a+b&count=5');
    expect(brave.call.method).toBe('GET');

    const serp = await runSearch(['serpapi', 'coffee', '--engine', 'bing']);
    expect(serp.call.url).toBe('http://proxy/serpapi/search.json?engine=bing&q=coffee');
  });

  it('rejects an unknown provider or result count before calling anything', async () => {
    const unknown = await runSearch(['google', 'x']);
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.f.calls).toHaveLength(0);
    const tooMany = await runSearch(['tavily', 'x', '--results', '50']);
    expect(tooMany.code).toBe(EXIT.usage);
    expect(tooMany.f.calls).toHaveLength(0);
  });

  it('stops, with the charge, when the provider timed out behind the proxy', async () => {
    const f = fake(ENV, () => ({
      status: 504,
      body: { error: 'upstream_timeout', message: 'Provider did not answer in time.' },
      headers: { 'x-brake-cost-micros': '8000' },
    }));
    // Exit 3, like a cap: a wrapper that retries on 1 would pay for it twice.
    expect(await run(['search', 'tavily', 'q'], f.io)).toBe(EXIT.budget);
    expect(f.err.join('')).toContain('STOP. The provider did not answer in time; charged $0.0080');
  });
});

describe('brake license', () => {
  it('installs a license file and shows the status', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'lic-')), 'acme.license');
    writeFileSync(file, '{"format":"spend-brake-license/1","payload":"e30","signature":"AA"}\n');
    const status = {
      status: 'active',
      readOnlyAt: null,
      license: {
        edition: 'business',
        org: 'acme',
        expiresAt: '2027-01-01T00:00:00Z',
        features: ['sso'],
      },
    };
    const f = fake({ ...ENV, BRAKE_ADMIN_TOKEN: `sbt_${'a'.repeat(32)}` }, () => ({
      status: 201,
      body: status,
    }));
    expect(await run(['license', 'install', file], f.io)).toBe(0);
    expect(f.calls[0]).toMatchObject({ url: 'http://api/v1/license', method: 'POST' });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({
      license: '{"format":"spend-brake-license/1","payload":"e30","signature":"AA"}\n',
    });
    expect(await run(['license', 'status', '--pretty'], f.io)).toBe(0);
    expect(f.out.at(-1)).toMatch(/^status +edition +org/);
    expect(f.out.at(-1)).toContain('active  business  acme');
    expect(await run(['license', 'install', '/no/such/file'], f.io)).toBe(EXIT.usage);
  });
});

describe('brake custom-apis', () => {
  it('adds one from a JSON file, lists, updates and deletes', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'capi-'));
    const definition = {
      id: 'acme',
      name: 'Acme',
      origin: 'https://api.acme.example',
      auth: { type: 'header', name: 'X-Api-Key' },
      routes: [{ path: '/v1/**', sku: 'call', pricing: { model: 'perRequest', usd: '0.01' } }],
    };
    const file = join(dir, 'acme.json');
    writeFileSync(file, JSON.stringify(definition));
    const item = { ...definition, proxyPath: '/custom/acme' };
    const f = fake({ ...ENV, BRAKE_ADMIN_TOKEN: `sbt_${'a'.repeat(32)}` }, (c) =>
      c.method === 'GET' && c.url.endsWith('/v1/custom-apis')
        ? { status: 200, body: { items: [item] } }
        : c.method === 'DELETE'
          ? {
              status: 409,
              body: { error: 'custom_api_in_use', message: 'Key "agent" calls Acme.' },
            }
          : { status: 201, body: item },
    );
    expect(await run(['custom-apis', 'add', file], f.io)).toBe(0);
    expect(f.calls[0]).toMatchObject({ url: 'http://api/v1/custom-apis', method: 'POST' });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual(definition);

    expect(await run(['custom-apis', 'list', '--pretty'], f.io)).toBe(0);
    expect(f.out.at(-1)).toMatch(/^id +name +origin +routes +path/);
    expect(f.out.at(-1)).toContain('acme  Acme  https://api.acme.example  1       /custom/acme');

    expect(await run(['custom-apis', 'update', 'acme', file], f.io)).toBe(0);
    expect(f.calls.at(-1)).toMatchObject({ url: 'http://api/v1/custom-apis/acme', method: 'PUT' });
    expect(JSON.parse(f.calls.at(-1)!.body!)).not.toHaveProperty('id');
    expect(await run(['custom-apis', 'update', 'other', file], f.io)).toBe(EXIT.usage);

    expect(await run(['custom-apis', 'delete', 'acme'], f.io)).toBe(EXIT.error);
    expect(f.err.join('')).toContain('Key "agent" calls Acme.');
    expect(await run(['custom-apis', 'add', join(dir, 'missing.json')], f.io)).toBe(EXIT.usage);
  });
});

describe('brake init without Google', () => {
  const setupApi = (credential: (c: Call) => { status: number; body: unknown }) => (c: Call) => {
    if (c.url.endsWith('/v1/setup'))
      return { status: 200, body: { orgId: 'acme', ownerToken: 'sbt_owner' } };
    if (c.url.endsWith('/v1/tokens')) return { status: 200, body: { token: 'sbt_admin' } };
    if (c.url.endsWith('/v1/caps/org')) return { status: 200, body: { items: [] } };
    if (c.url.endsWith('/v1/providers/credentials')) return credential(c);
    if (c.url.endsWith('/v1/keys'))
      return { status: 200, body: { id: 'key_1', token: 'sb_live_x' } };
    return { status: 404, body: {} };
  };
  const args = (...extra: string[]) => [
    'init',
    '--api-url',
    'http://api',
    '--proxy-url',
    'http://proxy',
    '--setup-token',
    'setup',
    '--org',
    'acme',
    '--day-cap',
    '5',
    ...extra,
  ];
  // Each holds the admin token init saves: removed after its test.
  const home = () => {
    const d = mkdtempSync(join(tmpdir(), 'brake-init-'));
    onTestFinished(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };

  it('sets up the org and caps and explains the next step', async () => {
    const f = fake(
      { HOME: home() },
      setupApi(() => ({ status: 500, body: {} })),
    );
    expect(await run(args(), f.io)).toBe(EXIT.ok);
    const out = f.out.join('');
    expect(out).toContain('Org acme is ready');
    expect(out).toContain('sbt_owner');
    expect(out).toContain('No Google key given');
    expect(out).toContain('brake keys create');
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/setup',
      '/v1/tokens',
      '/v1/caps/org',
    ]);
  });

  it('keeps the owner token when the API refuses the Google key', async () => {
    const f = fake(
      { HOME: home() },
      setupApi(() => ({
        status: 400,
        body: { error: 'invalid_key', message: 'Google says this API key is not valid.' },
      })),
    );
    expect(await run([...args('--google-key', 'AIza-bad'), '--json'], f.io)).toBe(EXIT.error);
    const result = JSON.parse(f.out.join('')) as Record<string, unknown>;
    expect(result).toMatchObject({ orgId: 'acme', ownerToken: 'sbt_owner', virtualKey: null });
    expect(String(result.googleError)).toContain('not valid');
    expect(f.err.join('')).toContain('the Google key was not added');
  });
});

describe('brake caps --pretty', () => {
  const ADMIN = { ...ENV, BRAKE_ADMIN_TOKEN: 'sbt_admin' };
  const cap = { scope: 'key:k1', kind: 'd', hard: 1_500_000, soft: null, version: 2 };

  it('set prints the caps table', async () => {
    const f = fake(ADMIN, () => ({ status: 200, body: { items: [cap] } }));
    expect(await run(['caps', 'set', 'key:k1', '--day', '1.50', '--pretty'], f.io)).toBe(0);
    expect(f.out.join('')).toMatch(
      /scope\s+window\s+hard\s+soft\s+version\nkey:k1\s+day\s+\$1\.50\s+2\n/,
    );
  });

  it('rm says what it removed', async () => {
    const f = fake(ADMIN, () => ({ status: 200, body: { scope: 'key:k1', deleted: ['d', 'm'] } }));
    expect(await run(['caps', 'rm', 'key:k1', '--pretty'], f.io)).toBe(0);
    expect(f.out.join('')).toBe('Removed the day and month cap of key:k1.\n');
  });
});

describe('brake status', () => {
  it('warns about a refused BRAKE_SESSION and still shows the key budget', async () => {
    const f = fake({ ...ENV, BRAKE_SESSION: 'run-7' }, (c) =>
      c.headers['x-brake-session']
        ? {
            status: 400,
            body: {
              error: 'invalid_request',
              message: 'This key has no session budget; drop X-Brake-Session.',
            },
          }
        : { status: 200, body: { keyId: 'k', sessionId: null, killed: false, scopes: [] } },
    );
    expect(await run(['status'], f.io)).toBe(EXIT.ok);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.headers['x-brake-session']).toBeUndefined();
    expect(f.err.join('')).toContain('BRAKE_SESSION is refused: This key has no session budget');
    expect(JSON.parse(f.out.join(''))).toMatchObject({ keyId: 'k' });

    // Without BRAKE_SESSION, a 400 is an error as before.
    const plain = fake(ENV, () => ({ status: 400, body: { message: 'nope' } }));
    expect(await run(['status'], plain.io)).toBe(EXIT.error);
  });
});
