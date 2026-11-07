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

  it('fails without a key, and when nothing caps the key', async () => {
    const none = await doctor({}, healthy(me()));
    expect(none.code).toBe(EXIT.error);
    expect(none.status('key.present')).toBe('fail');

    const uncapped = await doctor({ BRAKE_KEY: KEY }, healthy(me({ scopes: [] })));
    expect(uncapped.code).toBe(EXIT.error);
    expect(uncapped.status('key.capped')).toBe('fail');
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

    const key = await doctor(
      { BRAKE_KEY: KEY },
      healthy(me({ killed: true, killedProviders: [] })),
    );
    expect(key.report!.checks.find((x) => x.id === 'key.killed')!.detail).toContain('the org');
  });

  it('says what it could not check against an older server or an unreachable one', async () => {
    const old = await doctor({ BRAKE_KEY: KEY }, healthy(me({}, null)));
    expect(old.status('key.policy')).toBe('unknown');
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
        ? { status: 200, body: {} }
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
          if (c.method === 'DELETE') return { status: 200, body: { spentMicros: 0 } };
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
      });
      const probe = d.f.calls.find((c) => c.url.startsWith('https://proxy/google-maps/'))!;
      expect(probe.headers['x-brake-key']).toBe(session.body.token);
      expect(d.f.calls.at(-1)).toMatchObject({
        method: 'DELETE',
        url: 'https://api/v1/sessions/key_probe',
      });
    });

    it('fails loudly if the proxy forwards past a $0 budget', async () => {
      const d = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE') return { status: 200, body: { spentMicros: 5000 } };
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

    it('keeps the report and ends the session when the probe gets no answer', async () => {
      const d = await doctor(
        { BRAKE_KEY: KEY },
        healthy(minting, (c) => {
          if (c.url.endsWith('/v1/sessions')) return session;
          if (c.method === 'DELETE') return { status: 200, body: { spentMicros: 0 } };
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
          if (c.method === 'DELETE') return { status: 200, body: { spentMicros: 0 } };
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
          if (c.method === 'DELETE') return { status: 200, body: { spentMicros: 0 } };
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

  it('reports a key it could not check, rather than a bad key, when the API errs', async () => {
    const d = await doctor({ BRAKE_KEY: KEY }, (c) =>
      c.url.endsWith('/readyz') ? { status: 200, body: {} } : { status: 503, body: {} },
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
