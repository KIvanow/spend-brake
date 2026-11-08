import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dotenvValue } from '../src/commands/doctor.js';
import { EXIT, withTimeout } from '../src/io.js';
import { run } from '../src/program.js';
import { type Call, fake } from './fake.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Random like a real secret: doctor skips placeholders such as `xxxxxxxx`. */
const rand = (n: number) => Array.from({ length: n }, () => B62[randomInt(62)]).join('');
const KEY = `sb_live_${rand(22)}`;
const ADMIN = `sbt_${rand(32)}`;

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const me = (over: Record<string, unknown> = {}, policy: Record<string, unknown> | null = {}) => ({
  keyId: 'key_1',
  sessionId: null,
  killed: false,
  scopes: [
    {
      scope: 'key:key_1',
      window: 'd:2026-11-07',
      spent: 0,
      held: 0,
      hard: 5_000_000,
      remaining: 5_000_000,
    },
  ],
  ...(policy === null
    ? {}
    : {
        policy: {
          providers: ['tavily'],
          skus: null,
          canMintSessions: false,
          expiresAt: '2026-12-01T00:00:00.000Z',
          failOpenMicros: null,
          unpriced: { tavily: { policy: 'deny', defaultPriceMicros: null } },
          ...policy,
        },
      }),
  ...over,
});

type Responder = (c: Call) => { status: number; body: unknown; headers?: Record<string, string> };

const healthy =
  (body: unknown, more?: Responder): Responder =>
  (c) => {
    if (c.url.endsWith('/readyz')) return { status: 200, body: { ok: true } };
    if (c.url.endsWith('/v1/me')) return { status: 200, body };
    return more?.(c) ?? { status: 500, body: {} };
  };

/** Run doctor in an empty home and working directory; returns the parsed report. */
async function doctor(
  env: Record<string, string>,
  respond: Responder,
  opts: { args?: string[]; cwd?: string; home?: string } = {},
) {
  const home = opts.home ?? tmp('brake-doctor-');
  const cwd = opts.cwd ?? tmp('brake-doctor-cwd-');
  const f = fake(
    {
      BRAKE_URL: 'https://proxy',
      BRAKE_API_URL: 'https://api',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      ...env,
    },
    respond,
  );
  f.io.cwd = () => cwd;
  const code = await run(['doctor', ...(opts.args ?? [])], f.io);
  const out = f.out.join('');
  const report = opts.args?.includes('--pretty')
    ? null
    : (JSON.parse(out) as {
        ok: boolean;
        checks: { id: string; status: string; detail?: string }[];
        notVerified: string[];
      });
  const status = (id: string) => report?.checks.find((c) => c.id === id)?.status;
  return { code, report, status, out, f };
}

describe('brake doctor', () => {
  it('passes a capped key in a clean environment, and still lists what it cannot verify', async () => {
    const d = await doctor({ BRAKE_KEY: KEY }, healthy(me()));
    expect(d.code).toBe(EXIT.ok);
    expect(d.report!.ok).toBe(true);
    expect(d.report!.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(d.report!.notVerified.join(' ')).toMatch(/egress/i);
    expect(d.out).not.toMatch(/protected|safe/i);
  });

  it('does not vouch while the workload can read another virtual key', async () => {
    const env = await doctor({ BRAKE_KEY: KEY, OTHER_KEY: `sb_live_${rand(22)}` }, healthy(me()));
    expect(env.status('virtual-keys.env')).toBe('warn');
    expect(env.report!.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(env.report!.ok).toBe(false);
    expect(env.code).toBe(EXIT.error);

    const cwd = tmp('brake-doctor-cwd-');
    writeFileSync(join(cwd, '.env'), `SPARE_KEY=sb_live_${rand(22)}\n`);
    const file = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd });
    expect(file.status('virtual-keys.files')).toBe('warn');
    expect(file.status('files.cwd')).toBe('pass');
    expect(file.code).toBe(EXIT.error);
    const pretty = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd, args: ['--pretty'] });
    expect(pretty.out).toMatch(/checked the caps of BRAKE_KEY only/);
  });

  it('fails without a key, and when nothing caps the key', async () => {
    const none = await doctor({}, healthy(me()));
    expect(none.code).toBe(EXIT.error);
    expect(none.status('key.present')).toBe('fail');

    const uncapped = await doctor({ BRAKE_KEY: KEY }, healthy(me({ scopes: [] })));
    expect(uncapped.code).toBe(EXIT.error);
    expect(uncapped.status('key.capped')).toBe('fail');
  });

  it("counts only the key's own cap when the key may mint sessions", async () => {
    const agentCap = {
      scope: 'agent:x',
      window: 'd:2026-11-07',
      spent: 0,
      held: 0,
      hard: 20_000_000,
      remaining: 20_000_000,
    };
    // The agent cap binds a key that mints nothing.
    const plain = await doctor({ BRAKE_KEY: KEY }, healthy(me({ scopes: [agentCap] })));
    expect(plain.status('key.capped')).toBe('pass');
    // A minting key's sessions bring their own budgets; the first may set the agent cap itself.
    const minter = await doctor(
      { BRAKE_KEY: KEY },
      healthy(me({ scopes: [agentCap] }, { canMintSessions: true })),
    );
    expect(minter.status('key.capped')).toBe('fail');
    expect(minter.report!.checks.find((c) => c.id === 'key.capped')!.detail).toContain(
      'only a cap on this key bounds them all',
    );
    expect(minter.code).toBe(EXIT.error);
    const own = await doctor({ BRAKE_KEY: KEY }, healthy(me({}, { canMintSessions: true })));
    expect(own.status('key.capped')).toBe('pass');
  });

  it('finds cap-raising and bypass credentials without printing them', async () => {
    const home = tmp('brake-doctor-');
    mkdirSync(join(home, '.config', 'brake'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'brake', 'config.json'),
      JSON.stringify({ adminToken: ADMIN }),
    );
    const cwd = tmp('brake-doctor-cwd-');
    writeFileSync(
      join(cwd, '.env.local'),
      `# keys\nexport EXA_API_KEY="0123456789abcdef0123"\nNOTE=hello\n`,
    );
    writeFileSync(
      join(cwd, '.env.example'),
      'TAVILY_API_KEY=your_tavily_api_key_here\nSEARCH=tvly-xxxxxxxxxxxxxxxx\nEXA_API_KEY=<exa key>\n',
    );
    const tavily = `tvly-${rand(24)}`;
    const d = await doctor(
      {
        BRAKE_KEY: KEY,
        SOME_TOKEN: ADMIN,
        SEARCH: tavily,
        GOOGLE_MAPS_KEY: 'whatever',
        OTHER_KEY: `sb_live_${rand(22)}`,
      },
      healthy(me()),
      { home, cwd },
    );
    expect(d.code).toBe(EXIT.error);
    expect(d.status('admin-token.env')).toBe('fail');
    expect(d.status('admin-token.config')).toBe('fail');
    expect(d.status('provider-keys.env')).toBe('fail');
    expect(d.status('virtual-keys.env')).toBe('warn');
    const files = d.report!.checks.find((c) => c.id === 'files.cwd')!;
    expect(files.status).toBe('fail');
    expect(files.detail).toContain('.env.local: EXA_API_KEY');
    // A placeholder in an example file is not a key.
    expect(files.detail).not.toContain('.env.example');
    for (const secret of [ADMIN, tavily, 'whatever', '0123456789abcdef0123', KEY]) {
      expect(d.out).not.toContain(secret);
    }
    expect(d.out).toContain('SOME_TOKEN (admin token)');
    expect(d.out).toContain('SEARCH (Tavily key)');
  });

  it('warns on plain HTTP to a remote host, open unpriced routes, fail-open and no expiry', async () => {
    const d = await doctor(
      { BRAKE_KEY: KEY, BRAKE_URL: 'http://proxy.example.com' },
      healthy(
        me(
          {},
          {
            expiresAt: null,
            failOpenMicros: 1_000_000,
            providers: ['a', 'b', 'c', 'd', 'e', 'tavily'],
            unpriced: { tavily: { policy: 'allow-with-default-price', defaultPriceMicros: 1000 } },
          },
        ),
      ),
    );
    expect(d.code).toBe(EXIT.ok);
    expect(d.status('transport.tls.api')).toBeUndefined();
    for (const id of [
      'transport.tls.proxy',
      'key.expiry',
      'key.fail-open',
      'providers.scope',
      'providers.unpriced',
    ]) {
      expect(d.status(id), id).toBe('warn');
    }
  });

  it('warns on each plain-HTTP URL under its own id', async () => {
    const d = await doctor(
      {
        BRAKE_KEY: KEY,
        BRAKE_URL: 'http://proxy.example.com',
        BRAKE_API_URL: 'http://api.example.com',
      },
      healthy(me()),
    );
    const ids = d.report!.checks.map((c) => c.id);
    expect(ids.filter((i) => i.startsWith('transport.tls'))).toEqual([
      'transport.tls.proxy',
      'transport.tls.api',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only warns on a Google API key that may be for Gemini, but fails on a Maps key', async () => {
    const gemini = `AIza${rand(35)}`;
    const d = await doctor({ BRAKE_KEY: KEY, GOOGLE_API_KEY: gemini }, healthy(me()));
    expect(d.status('google-keys.env')).toBe('warn');
    expect(d.status('provider-keys.env')).toBe('pass');
    expect(d.code).toBe(EXIT.ok);
    expect(d.out).not.toContain(gemini);

    const shaped = await doctor({ BRAKE_KEY: KEY, LLM_KEY: gemini }, healthy(me()));
    expect(shaped.status('google-keys.env')).toBe('warn');

    const maps = await doctor({ BRAKE_KEY: KEY, GOOGLE_MAPS_API_KEY: gemini }, healthy(me()));
    expect(maps.status('provider-keys.env')).toBe('fail');
    expect(maps.status('google-keys.env')).toBe('pass');

    // Any variable named for Maps, in the environment or a .env file, holds a Maps key.
    for (const name of [
      'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY',
      'VITE_GOOGLE_MAPS_API_KEY',
      'REACT_APP_GOOGLE_MAPS_KEY',
      'MAPS_API_KEY',
      'google_maps_key',
    ]) {
      const env = await doctor({ BRAKE_KEY: KEY, [name]: gemini }, healthy(me()));
      expect(env.status('provider-keys.env'), name).toBe('fail');
      expect(env.status('google-keys.env'), name).toBe('pass');
      expect(env.out).not.toContain(gemini);

      const cwd = tmp('brake-doctor-maps-');
      writeFileSync(join(cwd, '.env.local'), `${name}=${gemini}\n`);
      const file = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd });
      expect(file.status('files.cwd'), name).toBe('fail');
      expect(file.out).toContain(`${name} (Google Maps key)`);
      expect(file.out).not.toContain(gemini);
    }

    // Generic Google key names stay a warning, in a .env file too.
    for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
      const cwd = tmp('brake-doctor-gemini-');
      writeFileSync(join(cwd, '.env'), `${name}=${gemini}\n`);
      const file = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd });
      expect(file.status('files.cwd'), name).toBe('warn');
      expect(file.out).toContain(`${name} (Google API key)`);
    }
  });

  it('names the providers when every one of them is killed', async () => {
    const d = await doctor(
      { BRAKE_KEY: KEY },
      healthy(me({ killed: true, killedProviders: ['tavily'] })),
    );
    const c = d.report!.checks.find((x) => x.id === 'key.killed') as {
      fix?: string;
      detail?: string;
    };
    expect(d.status('key.killed')).toBe('fail');
    expect(c.detail).toContain('tavily');
    expect(c.fix).toContain('brake unkill prov:tavily');
    // /v1/me cannot say whether the key or the org is killed as well.
    expect(c.fix).toContain('brake unkill key:key_1');
    expect(c.fix).toContain('brake unkill org');

    const key = await doctor(
      { BRAKE_KEY: KEY },
      healthy(me({ killed: true, killedProviders: [] })),
    );
    expect(key.report!.checks.find((x) => x.id === 'key.killed')!.detail).toContain('the org');
  });

  it('says what it could not check against an older server or an unreachable one', async () => {
    const old = await doctor({ BRAKE_KEY: KEY }, healthy(me({}, null)));
    expect(old.status('key.policy')).toBe('unknown');
    expect(old.code).toBe(EXIT.error);
    expect(old.status('key.capped')).toBe('pass');

    const down = await doctor({ BRAKE_KEY: KEY }, () => ({ status: 503, body: { ok: false } }));
    expect(down.status('proxy.reachable')).toBe('fail');
    expect(down.status('api.reachable')).toBe('fail');
    expect(down.status('key.capped')).toBe('unknown');
    expect(down.status('key.valid')).toBe('unknown');
  });

  it('does not pass a key whose caps it could not read, and still reports --prove', async () => {
    const d = await doctor(
      { BRAKE_KEY: KEY },
      (c) =>
        c.url.endsWith('/readyz') ? { status: 200, body: { ok: true } } : { status: 502, body: {} },
      { args: ['--prove'] },
    );
    expect(d.report!.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(d.status('key.capped')).toBe('unknown');
    expect(d.status('enforcement.exhausted-budget')).toBe('unknown');
    expect(d.report!.ok).toBe(false);
    expect(d.code).toBe(EXIT.error);
  });

  it('still reports --prove as not checked when BRAKE_KEY is not set', async () => {
    const d = await doctor({}, healthy(me()), { args: ['--prove'] });
    const check = d.report!.checks.find((c) => c.id === 'enforcement.exhausted-budget');
    expect(check).toMatchObject({ status: 'unknown', detail: 'BRAKE_KEY is not set.' });
    expect(d.f.calls.some((c) => c.url.endsWith('/v1/sessions'))).toBe(false);
    expect(d.code).toBe(EXIT.error);
    // Without --prove it is not reported at all.
    const plain = await doctor({}, healthy(me()));
    expect(plain.status('enforcement.exhausted-budget')).toBeUndefined();
  });

  it('does not take a web page in front of the API for readiness', async () => {
    const html = '<!doctype html><html><body>dashboard</body></html>';
    const spa = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url.startsWith('https://api/') && c.url.endsWith('/readyz')
        ? { status: 200, body: html }
        : healthy(me())(c),
    );
    expect(spa.status('api.reachable')).toBe('fail');
    expect(spa.report!.checks.find((c) => c.id === 'api.reachable')!.detail).toMatch(
      /not a Spend Brake/,
    );

    // Through the dashboard: /v1/readyz reaches the API; an older API without it falls back.
    const viaV1 = await doctor({ BRAKE_KEY: KEY }, healthy(me()));
    expect(viaV1.f.calls.some((c) => c.url === 'https://api/v1/readyz')).toBe(true);
    const old = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url === 'https://api/v1/readyz'
        ? { status: 404, body: { error: 'not_found' } }
        : healthy(me())(c),
    );
    expect(old.status('api.reachable')).toBe('pass');
    expect(old.f.calls.some((c) => c.url === 'https://api/readyz')).toBe(true);

    // An older API behind the dashboard: its own JSON 404 on /v1/readyz, the dashboard's page on
    // /readyz. The API answers, so the key is still checked.
    const behind = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url === 'https://api/v1/readyz'
        ? {
            status: 404,
            body: {
              message: 'Route GET:/v1/readyz not found',
              error: 'Not Found',
              statusCode: 404,
            },
          }
        : c.url === 'https://api/readyz'
          ? { status: 200, body: html }
          : healthy(me())(c),
    );
    expect(behind.status('api.reachable')).toBe('warn');
    expect(behind.status('key.valid')).toBe('pass');
    expect(behind.status('key.capped')).toBe('pass');

    // A JSON answer is ready only when it says ok: true.
    for (const body of [{}, { ok: 'yes' }, { status: 'ok' }]) {
      const vague = await doctor({ BRAKE_KEY: KEY }, (c) =>
        c.url.endsWith('/readyz') ? { status: 200, body } : healthy(me())(c),
      );
      expect(vague.status('proxy.reachable')).toBe('fail');
      expect(vague.status('api.reachable')).toBe('fail');
    }

    // The public /v1/readyz is rate limited: the API answered, so the key is still checked, and
    // /readyz (the dashboard's page, behind it) is not asked instead.
    const limited = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url === 'https://api/v1/readyz'
        ? { status: 429, body: { error: 'rate_limited' } }
        : c.url === 'https://api/readyz'
          ? { status: 200, body: html }
          : healthy(me())(c),
    );
    expect(limited.status('api.reachable')).toBe('warn');
    expect(limited.report!.checks.find((c) => c.id === 'api.reachable')!.detail).toMatch(
      /rate limited/,
    );
    expect(limited.f.calls.some((c) => c.url === 'https://api/readyz')).toBe(false);
    expect(limited.status('key.valid')).toBe('pass');
    expect(limited.status('key.capped')).toBe('pass');
    // The last path rate limited is not ready.
    const proxyLimited = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url === 'https://proxy/readyz'
        ? { status: 429, body: { error: 'rate_limited' } }
        : healthy(me())(c),
    );
    expect(proxyLimited.status('proxy.reachable')).toBe('fail');

    // The web server in front answers for an API that is down.
    const down = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url.startsWith('https://api/') && c.url.endsWith('/readyz')
        ? { status: 502, body: '<html>502 Bad Gateway</html>' }
        : healthy(me())(c),
    );
    expect(down.status('api.reachable')).toBe('fail');
    expect(down.report!.checks.find((c) => c.id === 'api.reachable')!.detail).toMatch(
      /HTTP 502 .*may be down/,
    );
  });

  it('fails a BRAKE_SESSION the proxy would refuse', async () => {
    const d = await doctor({ BRAKE_KEY: KEY, BRAKE_SESSION: 'run-1' }, (c) =>
      c.url.endsWith('/v1/me')
        ? {
            status: 400,
            body: {
              error: 'invalid_request',
              message: 'This key has no session budget; drop X-Brake-Session.',
            },
          }
        : healthy(me())(c),
    );
    expect(d.status('key.session')).toBe('fail');
    expect(d.report!.checks.find((c) => c.id === 'key.session')!.detail).toMatch(
      /no session budget/,
    );
    expect(d.code).toBe(EXIT.error);
  });

  it("warns when some of the key's providers are killed", async () => {
    const d = await doctor({ BRAKE_KEY: KEY }, healthy(me({ killedProviders: ['tavily'] })));
    expect(d.status('key.killed')).toBe('warn');
  });

  it('fails a revoked key and a killed one', async () => {
    const revoked = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url.endsWith('/readyz')
        ? { status: 200, body: { ok: true } }
        : { status: 401, body: { error: 'invalid_key' } },
    );
    expect(revoked.status('key.valid')).toBe('fail');
    const killed = await doctor({ BRAKE_KEY: KEY }, healthy(me({ killed: true })));
    expect(killed.status('key.killed')).toBe('fail');
  });

  describe('--prove', () => {
    const minting = me({}, { canMintSessions: true, providers: ['google-maps', 'tavily'] });
    const session = {
      status: 201,
      body: { keyId: 'key_probe', token: `sb_live_${rand(22)}` },
    };

    it('mints a $0 session, sees a priced call refused, and ends the session', async () => {
      const d = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE')
            return { status: 200, body: { spentMicros: 0, heldMicros: 0 } };
          return {
            status: 402,
            body: { error: 'budget_exceeded', scope: 'key:key_probe', cap: 0 },
            headers: { 'x-brake-cost-micros': '0', 'x-brake-request-id': 'req_1' },
          };
        }),
        { args: ['--prove'] },
      );
      expect(d.status('enforcement.exhausted-budget')).toBe('pass');
      expect(d.code).toBe(EXIT.ok);
      const mint = d.f.calls.find((c) => c.url.endsWith('/v1/sessions'))!;
      expect(JSON.parse(mint.body!)).toMatchObject({
        budgetMicros: '0',
        dayBudgetMicros: '0',
        ttlSec: 60,
        probe: true,
      });
      const probe = d.f.calls.find((c) => c.url.startsWith('https://proxy/google-maps/'))!;
      expect(probe.headers['x-brake-key']).toBe(session.body.token);
      expect(d.f.calls.at(-1)).toMatchObject({
        method: 'DELETE',
        url: 'https://api/v1/sessions/key_probe',
      });
      // Ended with the parent key: the probe's own token stops working after its 60 s.
      expect(d.f.calls.at(-1)!.headers['x-brake-key']).toBe(KEY);
    });

    it('fails a probe the proxy forwarded, whatever the provider or the proxy then answered', async () => {
      const probe = (answer: { status: number; body: unknown }) =>
        doctor(
          { BRAKE_KEY: KEY },
          healthy(minting, (c) => {
            if (c.url.endsWith('/v1/sessions')) return session;
            if (c.method === 'DELETE')
              return { status: 200, body: { spentMicros: 0, heldMicros: 0 } };
            return { ...answer, headers: { 'x-brake-cost-micros': '0' } };
          }),
          { args: ['--prove'] },
        );
      for (const answer of [
        { status: 401, body: { detail: { error: 'Unauthorized: missing or invalid API key.' } } },
        { status: 400, body: { error: 'Bad request' } },
        { status: 400, body: 'Bad Request' },
        { status: 504, body: { error: 'upstream_timeout' } },
        { status: 502, body: { error: 'upstream_unavailable' } },
      ]) {
        const d = await probe(answer);
        const check = d.report!.checks.find((c) => c.id === 'enforcement.exhausted-budget')!;
        expect(check.status, JSON.stringify(answer)).toBe('fail');
        expect(check.detail).toMatch(/FORWARDED/);
        expect(d.code).toBe(EXIT.error);
      }
      // Refused before the caps were checked: proves nothing either way.
      for (const answer of [
        { status: 401, body: { error: 'invalid_key' } },
        { status: 400, body: { error: 'invalid_request' } },
        { status: 429, body: { error: 'loop_detected' } },
        { status: 503, body: { error: 'budget_unavailable' } },
        { status: 500, body: { error: 'internal_error' } },
      ]) {
        const d = await probe(answer);
        expect(d.status('enforcement.exhausted-budget'), JSON.stringify(answer)).toBe('unknown');
        expect(d.code).toBe(EXIT.error);
      }
    });

    it('does not fail an answer from something in front of the proxy, unless the session spent', async () => {
      const probe = (
        answer: { status: number; body: unknown; headers?: Record<string, string> },
        end = { spentMicros: 0, heldMicros: 0 },
      ) =>
        doctor(
          { BRAKE_KEY: KEY },
          healthy(minting, (c) => {
            if (c.url.endsWith('/v1/sessions')) return session;
            if (c.method === 'DELETE') return { status: 200, body: end };
            return answer;
          }),
          { args: ['--prove'] },
        );
      // A CDN, WAF or load balancer page, or another server: no proxy cost header.
      for (const answer of [
        { status: 403, body: '<html><body>Access denied | Cloudflare</body></html>' },
        { status: 429, body: '<html><body>Too many requests</body></html>' },
        { status: 502, body: '<html><body>502 Bad Gateway</body></html>' },
        { status: 200, body: '<!doctype html><html></html>' },
        { status: 402, body: { error: 'budget_exceeded' } },
      ]) {
        const d = await probe(answer);
        const check = d.report!.checks.find((c) => c.id === 'enforcement.exhausted-budget')!;
        expect(check.status, JSON.stringify(answer)).toBe('unknown');
        expect(check.detail).toMatch(/in front of the proxy, not the proxy/);
        expect(d.code).toBe(EXIT.error);
      }
      // The provider's own error, passed on by the proxy with its cost header, still fails.
      const forwarded = await probe({
        status: 401,
        body: { detail: { error: 'Unauthorized' } },
        headers: { 'x-brake-cost-micros': '0' },
      });
      expect(forwarded.status('enforcement.exhausted-budget')).toBe('fail');
      // Money spent or held on the $0 session proves forwarding, whoever answered.
      for (const end of [
        { spentMicros: 5000, heldMicros: 0 },
        { spentMicros: 0, heldMicros: 5000 },
      ]) {
        const d = await probe({ status: 502, body: '<html>502</html>' }, end);
        expect(d.status('enforcement.exhausted-budget'), JSON.stringify(end)).toBe('fail');
      }
    });

    it('fails loudly if the proxy forwards past a $0 budget', async () => {
      const d = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE')
            return { status: 200, body: { spentMicros: 5000, heldMicros: 0 } };
          return { status: 200, body: { results: [] }, headers: { 'x-brake-cost-micros': '5000' } };
        }),
        { args: ['--prove'] },
      );
      expect(d.status('enforcement.exhausted-budget')).toBe('fail');
      expect(d.code).toBe(EXIT.error);
    });

    it('fails when the proxy charges for the probe, even on a refusal', async () => {
      const d = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE') throw new Error('gone');
          return {
            status: 402,
            body: { error: 'budget_exceeded' },
            headers: { 'x-brake-cost-micros': '5000' },
          };
        }),
        { args: ['--prove'] },
      );
      expect(d.status('enforcement.exhausted-budget')).toBe('fail');
    });

    it('does not pass when the probe session spend cannot be read back', async () => {
      const refusal = {
        status: 402,
        body: { error: 'budget_exceeded' },
        headers: { 'x-brake-cost-micros': '0' },
      };
      for (const end of [
        () => {
          throw new Error('connection reset');
        },
        () => ({ status: 500, body: { error: 'internal' } }),
        () => ({ status: 200, body: {} }),
      ]) {
        const d = await doctor(
          { BRAKE_KEY: KEY },
          healthy(minting, (c) => {
            if (c.url.endsWith('/v1/sessions')) return session;
            if (c.method === 'DELETE') return end();
            return refusal;
          }),
          { args: ['--prove'] },
        );
        const check = d.report!.checks.find((c) => c.id === 'enforcement.exhausted-budget')!;
        expect(check.status).toBe('unknown');
        expect(check.detail).toMatch(/spend could not be read back/);
        expect(d.code).toBe(EXIT.error);
      }
    });

    it('fails when the $0 session holds money for a call', async () => {
      const d = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE')
            return { status: 200, body: { spentMicros: 0, heldMicros: 5000 } };
          throw new Error('connection reset');
        }),
        { args: ['--prove'] },
      );
      expect(d.status('enforcement.exhausted-budget')).toBe('fail');
      expect(d.code).toBe(EXIT.error);
    });

    it('keeps the report and ends the session when the probe gets no answer', async () => {
      const d = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE')
            return { status: 200, body: { spentMicros: 0, heldMicros: 0 } };
          throw new Error('connection reset');
        }),
        { args: ['--prove'] },
      );
      expect(d.status('enforcement.exhausted-budget')).toBe('unknown');
      expect(d.f.calls.at(-1)).toMatchObject({ method: 'DELETE' });

      const noMint = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, () => {
          throw new Error('connection reset');
        }),
        { args: ['--prove'] },
      );
      expect(noMint.status('enforcement.exhausted-budget')).toBe('unknown');
    });

    it('skips killed providers, and tries the next one the proxy refuses before the caps', async () => {
      const refused = (c: Call) =>
        c.url.includes('/google-maps/')
          ? { status: 403, body: { error: 'killed', target: 'prov:google-maps' } }
          : {
              status: 402,
              body: { error: 'budget_exceeded' },
              headers: { 'x-brake-cost-micros': '0' },
            };
      const respond = (body: unknown) =>
        healthy(body, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE')
            return { status: 200, body: { spentMicros: 0, heldMicros: 0 } };
          return refused(c);
        });

      // Killed since /v1/me: the proxy says so, and doctor moves on.
      const late = await doctor({ BRAKE_KEY: KEY }, respond(minting), { args: ['--prove'] });
      expect(late.status('enforcement.exhausted-budget')).toBe('pass');
      expect(late.code).toBe(EXIT.ok);

      // Known killed: never probed.
      const known = await doctor(
        { BRAKE_KEY: KEY },
        respond({ ...minting, killedProviders: ['google-maps'] }),
        { args: ['--prove'] },
      );
      expect(known.status('enforcement.exhausted-budget')).toBe('pass');
      expect(known.f.calls.some((c) => c.url.includes('/google-maps/'))).toBe(false);

      const unpriced = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE')
            return { status: 200, body: { spentMicros: 0, heldMicros: 0 } };
          return c.url.includes('/google-maps/')
            ? { status: 403, body: { error: 'unpriced_route' } }
            : refused(c);
        }),
        { args: ['--prove'] },
      );
      expect(unpriced.status('enforcement.exhausted-budget')).toBe('pass');

      const all = await doctor(
        { BRAKE_KEY: KEY },
        respond({ ...minting, killedProviders: ['google-maps', 'tavily'] }),
        { args: ['--prove'] },
      );
      expect(all.status('enforcement.exhausted-budget')).toBe('unknown');
      expect(all.f.calls.some((c) => c.url.endsWith('/v1/sessions'))).toBe(false);
    });

    it('probes when only the session the client names is killed, not when the key is', async () => {
      const probe = healthy(minting, (c) => {
        if (c.url.endsWith('/v1/sessions')) return session;
        if (c.method === 'DELETE') return { status: 200, body: { spentMicros: 0, heldMicros: 0 } };
        return {
          status: 402,
          body: { error: 'budget_exceeded' },
          headers: { 'x-brake-cost-micros': '0' },
        };
      });
      const withSession =
        (keyKilled: boolean): Responder =>
        (c) =>
          c.url.endsWith('/v1/me')
            ? {
                status: 200,
                body: { ...minting, killed: keyKilled || Boolean(c.headers['x-brake-session']) },
              }
            : probe(c);
      const sess = await doctor({ BRAKE_KEY: KEY, BRAKE_SESSION: 'run-1' }, withSession(false), {
        args: ['--prove'],
      });
      expect(sess.status('enforcement.exhausted-budget')).toBe('pass');
      const key = await doctor({ BRAKE_KEY: KEY, BRAKE_SESSION: 'run-1' }, withSession(true), {
        args: ['--prove'],
      });
      expect(key.status('enforcement.exhausted-budget')).toBe('unknown');
      expect(key.f.calls.some((c) => c.url.endsWith('/v1/sessions'))).toBe(false);
    });

    it('mints nothing on a server too old for --prove, or for a provider it has no probe for', async () => {
      const old = await doctor({ BRAKE_KEY: KEY }, healthy(me({}, null)), { args: ['--prove'] });
      expect(old.status('enforcement.exhausted-budget')).toBe('unknown');
      expect(
        old.report!.checks.find((c) => c.id === 'enforcement.exhausted-budget')!.detail,
      ).toMatch(/too old for --prove/);
      expect(old.f.calls.some((c) => c.url.endsWith('/v1/sessions'))).toBe(false);

      const odd = await doctor(
        { BRAKE_KEY: KEY },
        healthy(me({}, { canMintSessions: true, providers: ['constructor'] })),
        { args: ['--prove'] },
      );
      expect(odd.status('enforcement.exhausted-budget')).toBe('unknown');
      expect(odd.f.calls.some((c) => c.url.endsWith('/v1/sessions'))).toBe(false);
    });

    it('cannot prove anything with a key that may not mint sessions, or a session key', async () => {
      const plain = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { args: ['--prove'] });
      expect(plain.status('enforcement.exhausted-budget')).toBe('unknown');
      expect(plain.f.calls.some((c) => c.url.endsWith('/v1/sessions'))).toBe(false);
      const sess = await doctor({ BRAKE_KEY: KEY }, healthy(me({ sessionId: 'sess_1' })), {
        args: ['--prove'],
      });
      expect(sess.status('enforcement.exhausted-budget')).toBe('unknown');
    });
  });

  it('prints a readable report that never claims protection', async () => {
    const d = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { args: ['--pretty'] });
    expect(d.out).toContain('brake doctor: 0 failed');
    expect(d.out).toContain('Not verified');
    expect(d.out).toContain('This is not a guarantee');
  });

  it('reads dotenv values with quotes and inline comments', () => {
    expect(dotenvValue(' "abc def" # prod')).toBe('abc def');
    expect(dotenvValue("'a#b'")).toBe('a#b');
    expect(dotenvValue('abc # prod')).toBe('abc');
    expect(dotenvValue('abc#def')).toBe('abc#def');
    expect(dotenvValue('"unterminated')).toBe('unterminated');
  });

  it('finds a quoted key followed by a comment, and does not pass files it could not read', async () => {
    const cwd = tmp('brake-doctor-cwd-');
    writeFileSync(join(cwd, '.env'), 'EXA_API_KEY="0123456789abcdef0123" # prod\n');
    const found = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd });
    expect(found.status('files.cwd')).toBe('fail');

    const big = tmp('brake-doctor-cwd-');
    // Sparse: the size is what counts, nothing is written.
    writeFileSync(join(big, '.env.dump'), '');
    truncateSync(join(big, '.env.dump'), 10_000_001);
    const skipped = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd: big });
    expect(skipped.status('files.cwd')).toBe('unknown');
    // It may hold another virtual key too.
    expect(skipped.status('virtual-keys.files')).toBe('unknown');
    // What doctor could not read may hold a key: it does not vouch.
    expect(skipped.report!.ok).toBe(false);

    // A Mapbox public token in a front end's .env calls Mapbox around the proxy too.
    const web = tmp('brake-doctor-cwd-');
    writeFileSync(join(web, '.env'), `NEXT_PUBLIC_MAPBOX_TOKEN=pk.eyJ${rand(40)}\n`);
    const pub = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd: web });
    expect(pub.status('files.cwd')).toBe('fail');
    expect(pub.report!.checks.find((c) => c.id === 'files.cwd')!.detail).toContain(
      'NEXT_PUBLIC_MAPBOX_TOKEN (Mapbox public key)',
    );
    expect(skipped.code).toBe(EXIT.error);

    // A Google key found elsewhere is only a warning; the file not read still stops the vouching.
    writeFileSync(join(big, '.env'), `GOOGLE_API_KEY=AIza${rand(35)}\n`);
    const mixed = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd: big });
    expect(mixed.status('files.cwd')).toBe('unknown');
    expect(mixed.code).toBe(EXIT.error);

    const gone = await doctor({ BRAKE_KEY: KEY }, healthy(me()), {
      cwd: join(tmp('brake-doctor-cwd-'), 'missing'),
    });
    expect(gone.status('files.cwd')).toBe('unknown');
    expect(gone.status('virtual-keys.files')).toBe('unknown');
    expect(gone.report!.checks.find((c) => c.id === 'files.cwd')!.detail).toContain(
      'could not be read',
    );
    expect(gone.code).toBe(EXIT.error);
  });

  it('finds the default saved config even when XDG_CONFIG_HOME points elsewhere', async () => {
    const home = tmp('brake-doctor-');
    mkdirSync(join(home, '.config', 'brake'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'brake', 'config.json'),
      JSON.stringify({ adminToken: ADMIN }),
    );
    const d = await doctor(
      { BRAKE_KEY: KEY, XDG_CONFIG_HOME: join(home, 'elsewhere') },
      healthy(me()),
      {
        home,
      },
    );
    expect(d.status('admin-token.config')).toBe('fail');
    expect(d.out).not.toContain(ADMIN);
  });

  it('finds an admin token in a config brake cannot parse, and reads odd JSON without failing', async () => {
    const home = tmp('brake-doctor-');
    const path = join(home, '.config', 'brake', 'config.json');
    mkdirSync(join(home, '.config', 'brake'), { recursive: true });
    // A trailing comma: not JSON, but the agent reads text.
    writeFileSync(path, `{\n  "apiUrl": "https://api",\n  "adminToken": "${ADMIN}",\n}\n`);
    const broken = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { home });
    expect(broken.status('admin-token.config')).toBe('fail');
    expect(broken.out).not.toContain(ADMIN);
    expect(broken.code).toBe(EXIT.error);

    for (const text of ['null', '[]', '42', '{"apiUrl": ']) {
      writeFileSync(path, text);
      const odd = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { home });
      expect(odd.status('admin-token.config'), text).toBe('pass');
      expect(odd.code, text).toBe(EXIT.ok);
    }
  });

  it('looks in the OS home when HOME is unset, and never passes a config it did not look for', async () => {
    const home = tmp('brake-doctor-');
    mkdirSync(join(home, '.config', 'brake'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'brake', 'config.json'),
      JSON.stringify({ adminToken: ADMIN }),
    );
    // A capped key: nothing else stops doctor from vouching.
    const run_ = async (homedir?: () => string) => {
      const f = fake(
        { BRAKE_URL: 'https://proxy', BRAKE_API_URL: 'https://api', BRAKE_KEY: KEY },
        healthy(me()),
      );
      const cwd = tmp('brake-doctor-cwd-');
      f.io.cwd = () => cwd;
      if (homedir) f.io.homedir = homedir;
      const code = await run(['doctor'], f.io);
      const report = JSON.parse(f.out.join('')) as {
        ok: boolean;
        checks: { id: string; status: string; detail?: string }[];
      };
      return { code, report, check: report.checks.find((c) => c.id === 'admin-token.config')! };
    };
    expect((await run_(() => home)).check.status).toBe('fail');
    for (const homedir of [
      undefined,
      () => '',
      () => {
        throw new Error('no passwd entry');
      },
    ]) {
      const none = await run_(homedir);
      expect(none.check.status).toBe('unknown');
      expect(none.report.checks.filter((c) => c.status !== 'pass')).toEqual([none.check]);
      expect(none.report.ok).toBe(false);
      expect(none.code).toBe(EXIT.error);
    }
  });

  it('reports a key it could not check, rather than a bad key, when the API errs', async () => {
    const d = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url.endsWith('/readyz') ? { status: 200, body: { ok: true } } : { status: 503, body: {} },
    );
    expect(d.status('key.valid')).toBe('unknown');
  });

  it('names the session it runs in when asking for its budget', async () => {
    const d = await doctor({ BRAKE_KEY: KEY, BRAKE_SESSION: 'run-7' }, healthy(me()));
    const meCall = d.f.calls.find((c) => c.url.endsWith('/v1/me'))!;
    expect(meCall.headers['x-brake-session']).toBe('run-7');
  });

  it('reads .env files with Windows line endings', async () => {
    const cwd = tmp('brake-doctor-cwd-');
    writeFileSync(join(cwd, '.env'), `NOTE=hi\r\nEXA_API_KEY=${rand(24)}\r\n`);
    const d = await doctor({ BRAKE_KEY: KEY }, healthy(me()), { cwd });
    expect(d.status('files.cwd')).toBe('fail');
  });

  it('does not count a session the client names as a cap on the key', async () => {
    const sess = (id: string) => ({
      scope: `sess:${id}`,
      window: 'm:2026-11',
      spent: 0,
      held: 0,
      hard: 2_000_000,
      remaining: 2_000_000,
    });
    const named = await doctor(
      { BRAKE_KEY: KEY, BRAKE_SESSION: 'run-7' },
      healthy(me({ scopes: [sess('run-7')] })),
    );
    expect(named.status('key.capped')).toBe('fail');
    expect(named.code).toBe(EXIT.error);
    // A session key's own session does bind it.
    const own = await doctor(
      { BRAKE_KEY: KEY },
      healthy(me({ sessionId: 'sess_1', scopes: [sess('sess_1')] })),
    );
    expect(own.status('key.capped')).toBe('pass');
  });

  it('fails unpriced routes charged $0, and passes ones the proxy refuses for want of a price', async () => {
    const free = await doctor(
      { BRAKE_KEY: KEY },
      healthy(
        me(
          {},
          { unpriced: { tavily: { policy: 'allow-with-default-price', defaultPriceMicros: 0 } } },
        ),
      ),
    );
    expect(free.status('providers.unpriced-free')).toBe('fail');
    expect(free.code).toBe(EXIT.error);
    const noPrice = await doctor(
      { BRAKE_KEY: KEY },
      healthy(
        me(
          {},
          {
            unpriced: { tavily: { policy: 'allow-with-default-price', defaultPriceMicros: null } },
          },
        ),
      ),
    );
    expect(noPrice.status('providers.unpriced')).toBe('pass');
    expect(noPrice.out).not.toContain('billed at no');
  });

  it('gives up on a request that does not answer in time', async () => {
    const hanging = fake({}, () => ({ status: 200, body: {} })).io;
    hanging.fetch = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      })) as typeof fetch;
    await expect(withTimeout(hanging, 20).fetch('http://api/readyz')).rejects.toThrow('timed out');

    // The caller's own signal still aborts it, long before the deadline.
    const mine = new AbortController();
    const pending = withTimeout(hanging, 60_000).fetch('http://api/readyz', {
      signal: mine.signal,
    });
    mine.abort();
    await expect(pending).rejects.toThrow('timed out');
  });
});
