import { describe, expect, it } from 'vitest';
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

  it('validates its input', async () => {
    for (const args of [
      ['call', 'acme', 'TRACE', '/x'],
      ['call', 'acme', 'GET', 'x'],
      ['call', '../evil', 'GET', '/x'],
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
