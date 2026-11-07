import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/io.js';
import { run } from '../src/program.js';
import { type Call, fake } from './fake.js';

const KEY = `sb_live_${'k'.repeat(22)}`;
const ADMIN = `sbt_${'a'.repeat(32)}`;

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
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'brake-doctor-'));
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'brake-doctor-cwd-'));
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
    const home = mkdtempSync(join(tmpdir(), 'brake-doctor-'));
    mkdirSync(join(home, '.config', 'brake'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'brake', 'config.json'),
      JSON.stringify({ adminToken: ADMIN }),
    );
    const cwd = mkdtempSync(join(tmpdir(), 'brake-doctor-cwd-'));
    writeFileSync(
      join(cwd, '.env.local'),
      `# keys\nexport EXA_API_KEY="0123456789abcdef0123"\nNOTE=hello\n`,
    );
    writeFileSync(join(cwd, '.env.example'), 'TAVILY_API_KEY=your-key-here\n');
    const tavily = `tvly-${'x'.repeat(24)}`;
    const d = await doctor(
      {
        BRAKE_KEY: KEY,
        SOME_TOKEN: ADMIN,
        SEARCH: tavily,
        GOOGLE_MAPS_KEY: 'whatever',
        OTHER_KEY: `sb_live_${'o'.repeat(22)}`,
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
    for (const id of [
      'transport.tls',
      'key.expiry',
      'key.fail-open',
      'providers.scope',
      'providers.unpriced',
    ]) {
      expect(d.status(id), id).toBe('warn');
    }
  });

  it('says what it could not check against an older server or an unreachable one', async () => {
    const old = await doctor({ BRAKE_KEY: KEY }, healthy(me({}, null)));
    expect(old.status('key.policy')).toBe('unknown');
    expect(old.status('key.capped')).toBe('pass');

    const down = await doctor({ BRAKE_KEY: KEY }, () => ({ status: 503, body: { ok: false } }));
    expect(down.status('proxy.reachable')).toBe('fail');
    expect(down.status('api.reachable')).toBe('fail');
    expect(down.status('key.capped')).toBeUndefined();
    expect(down.status('key.valid')).toBe('unknown');
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
      body: { keyId: 'key_probe', token: `sb_live_${'p'.repeat(22)}` },
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
});
