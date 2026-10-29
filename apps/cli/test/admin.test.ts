import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApi } from '@spend-brake/api';
import { Registry } from '@spend-brake/budget';
import { type Db, createDb, migrate, sql } from '@spend-brake/db';
import { LocalKeyWrapper } from '@spend-brake/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restrictionSteps } from '../src/commands/init.js';
import { EXIT, type Io } from '../src/io.js';
import { run } from '../src/program.js';

let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: Redis;
let api: FastifyInstance;
let apiUrl = '';
const home = mkdtempSync(join(tmpdir(), 'brake-home-'));

beforeAll(async () => {
  [pg, vk] = await Promise.all([
    new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_PASSWORD: 'p', POSTGRES_USER: 'brake', POSTGRES_DB: 'brake' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  ({ db, pool } = createDb(`postgres://brake:p@${pg.getHost()}:${pg.getMappedPort(5432)}/brake`));
  await migrate(db);
  valkey = new Redis(`redis://${vk.getHost()}:${vk.getMappedPort(6379)}`);
  api = await buildApi({
    db,
    valkey,
    wrapper: new LocalKeyWrapper(randomBytes(32).toString('base64')),
    setupToken: 'setup-0123456789abcdef',
    authCacheMs: 0,
    rateLimitPerMinute: 100_000,
    checkGoogleKey: () =>
      Promise.resolve({
        apiRestricted: false,
        ipRestricted: null,
        valid: true,
        warnings: ['This key has no API restrictions.'],
      }),
  });
  apiUrl = await api.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await api.close();
  await valkey.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

function cli(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { HOME: home, ...env },
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    fetch: globalThis.fetch,
    spawn: () => {
      throw new Error('not used');
    },
  };
  return {
    run: async (...args: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await run(args, io);
      return { code, out: out.join(''), err: err.join('') };
    },
  };
}

describe('brake init and admin commands', () => {
  let keyToken = '';
  let keyId = '';

  it('init sets up the org, stores the key encrypted, saves the token 0600 and prints the steps', async () => {
    const r = await cli().run(
      'init',
      '--api-url',
      apiUrl,
      '--proxy-url',
      'https://brake.example.com',
      '--setup-token',
      'setup-0123456789abcdef',
      '--org',
      'acme',
      '--google-key',
      'AIza-real-google-key',
      '--egress-ip',
      '203.0.113.7',
      '--day-cap',
      '5',
      '--month-cap',
      '50',
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Org acme is ready');
    expect(r.out).toMatch(/ {2}sb_live_[0-9A-Za-z]{22}\n/);
    expect(r.out).toContain('! This key has no API restrictions.');
    expect(r.out).toContain('--allowed-ips=203.0.113.7');
    expect(r.out).toContain('--api-target=service=places.googleapis.com');
    expect(r.out).not.toContain('AIza-real-google-key');
    keyToken = /sb_live_[0-9A-Za-z]{22}/.exec(r.out)![0];

    const path = join(home, '.config', 'brake', 'config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      adminToken: string;
      apiUrl: string;
      orgId: string;
    };
    expect(saved).toMatchObject({ apiUrl, orgId: 'acme', proxyUrl: 'https://brake.example.com' });
    expect(saved.adminToken).toMatch(/^sbt_/);

    const key = await new Registry(valkey).getKeyByToken(keyToken);
    expect(key).toMatchObject({ orgId: 'acme', canMintSessions: true });
    keyId = key!.id;
    const stored = await db.execute(sql`select envelope::text as e from provider_credentials`);
    expect(JSON.stringify(stored.rows)).not.toContain('AIza-real-google-key');

    // Second run: the install already has an org.
    const again = await cli().run(
      'init',
      '--api-url',
      apiUrl,
      '--proxy-url',
      'x',
      '--setup-token',
      'setup-0123456789abcdef',
      '--org',
      'b',
      '--google-key',
      'k',
    );
    expect(again.code).toBe(EXIT.error);
    expect(again.err).toContain('already has an org');
  });

  it('admin commands use the saved token', async () => {
    const c = cli();
    const caps = await c.run('caps', 'list', '--pretty');
    expect(caps.code).toBe(0);
    expect(caps.out).toMatch(/org\s+day\s+\$5\.00/);
    expect(caps.out).toMatch(/org\s+month\s+\$50\.00/);

    expect(
      (await c.run('caps', 'set', `key:${keyId}`, '--day', '1.50', '--soft-day', '1')).code,
    ).toBe(0);
    const status = await c.run('status', '--scope', `key:${keyId}`, '--pretty');
    expect(status.out).toMatch(
      new RegExp(`key:${keyId}\\s+d:\\d{8}\\s+\\$0\\.0000\\s+\\$1\\.50\\s+\\$1\\.5000`),
    );

    expect(JSON.parse((await c.run('kill', 'prov:google-maps', '--reason', 'test')).out)).toEqual({
      killed: ['prov:google-maps'],
    });
    expect(JSON.parse((await c.run('unkill', 'prov:google-maps')).out)).toEqual({ killed: [] });

    const keys = await c.run('keys', 'list', '--pretty');
    expect(keys.out).toContain('default');
    expect((await c.run('spend', '--group-by', 'key,day')).code).toBe(0);
    const est = await c.run('estimate', '--pretty');
    expect(est.out).toContain('Geoapify');
    expect(est.out).toContain('Open Places API');

    expect((await c.run('caps', 'set', 'org')).code).toBe(EXIT.usage);
    expect((await c.run('kill', 'everything')).code).toBe(EXIT.error);
  });

  it('status with a virtual key shows that key only', async () => {
    const r = await cli({ BRAKE_KEY: keyToken }).run('status');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ keyId, killed: false });
  });

  it('without a token, admin commands exit 5', async () => {
    const r = await cli({ HOME: mkdtempSync(join(tmpdir(), 'brake-empty-')) }).run('keys', 'list');
    expect(r.code).toBe(EXIT.auth);
    expect(r.err).toContain('brake init');
  });

  it('prints placeholder steps when the egress IP is unknown', () => {
    const steps = restrictionSteps([]);
    expect(steps).toContain('--allowed-ips=<PROXY_EGRESS_IP>');
    expect(steps).toContain('curl https://api.ipify.org');
  });
});
