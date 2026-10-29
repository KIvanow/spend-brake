import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildApi } from '@spend-brake/api';
import { bootstrapOrg } from '@spend-brake/api/bootstrap';
import { BudgetEngine, Registry } from '@spend-brake/budget';
import { GoogleMapsAdapter } from '@spend-brake/catalog';
import { type Db, auditLog, createDb, eq, migrate } from '@spend-brake/db';
import { buildServer } from '@spend-brake/proxy';
import { StaticSecretStore } from '@spend-brake/proxy/secrets';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The built CLI, exactly what `npx @spend-brake/cli` runs.
const CLI = fileURLToPath(new URL('../dist/brake.cjs', import.meta.url));

let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: Redis;
let api: FastifyInstance;
let proxy: FastifyInstance;
let mock: FastifyInstance;
let apiUrl = '';
let proxyUrl = '';
let registry: Registry;
let engine: BudgetEngine;
let googleCalls = 0;

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
  valkey = new Redis(`redis://${vk.getHost()}:${vk.getMappedPort(6379)}`, {
    enableAutoPipelining: true,
  });
  registry = new Registry(valkey);
  engine = new BudgetEngine(valkey);

  mock = Fastify();
  mock.get('/*', () => {
    googleCalls++;
    return { results: [{ place_id: 'ChIJ' }], status: 'OK' };
  });
  const mockUrl = await mock.listen({ port: 0, host: '127.0.0.1' });

  api = await buildApi({ db, valkey, wrapper: null, authCacheMs: 0, rateLimitPerMinute: 100_000 });
  apiUrl = await api.listen({ port: 0, host: '127.0.0.1' });
  proxy = buildServer({
    valkey,
    adapters: [new GoogleMapsAdapter()],
    secrets: new StaticSecretStore({ 'cred-google': 'AIza-real' }),
    upstreamOverrides: { 'https://maps.googleapis.com': mockUrl },
  });
  proxyUrl = await proxy.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await Promise.all([proxy.close(), api.close(), mock.close()]);
  await valkey.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

function brake(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', BRAKE_URL: proxyUrl, BRAKE_API_URL: apiUrl, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function parentKey(opts: { canMintSessions: boolean }) {
  const orgId = `org_${randomBytes(3).toString('hex')}`;
  await bootstrapOrg({ db, registry }, { id: orgId, name: orgId });
  // The key exists in Valkey (what the proxy and the session endpoint read) and Postgres.
  const { token, record } = await registry.createKey({
    id: `key_parent_${randomBytes(3).toString('hex')}`,
    orgId,
    credentials: { 'google-maps': 'cred-google' },
    canMintSessions: opts.canMintSessions,
  });
  const { virtualKeys } = await import('@spend-brake/db');
  const { hashVirtualKey } = await import('@spend-brake/budget');
  await db.insert(virtualKeys).values({
    id: record.id,
    orgId,
    name: 'parent',
    tokenHash: hashVirtualKey(token),
    prefix: token.slice(0, 12),
    config: record,
  });
  return { orgId, token, keyId: record.id };
}

describe('brake session end to end', () => {
  it('a scripted loop stops at the session cap with exit code 3', async () => {
    const parent = await parentKey({ canMintSessions: true });
    // Geocoding is $0.005 per request: a $0.012 session fits two.
    const loop = `i=0; while node "${CLI}" maps geocode "street $i" > /dev/null; do i=$((i+1)); done; echo "calls=$i"; exit 3`;
    const before = googleCalls;
    const r = await brake(
      ['session', '--budget', '0.012', '--agent', 'looper', '--', 'sh', '-c', loop],
      {
        BRAKE_KEY: parent.token,
      },
    );
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('calls=2');
    expect(googleCalls - before).toBe(2);
    expect(r.stderr).toMatch(/brake: STOP\. Spend cap reached for key:key_/);
    const summary = JSON.parse(r.stderr.trim().split('\n').at(-1)!) as {
      brakeSession: { keyId: string; exitCode: number; spentMicros: number; budget: string };
    };
    expect(summary.brakeSession).toMatchObject({
      exitCode: 3,
      spentMicros: 10_000,
      budget: '$0.01',
    });

    // The session key is revoked; its spend also counted against the parent and the agent.
    const child = summary.brakeSession.keyId;
    const status = await engine.status(
      parent.orgId,
      [
        { kind: 'key', id: parent.keyId },
        { kind: 'agent', id: 'looper' },
      ],
      'UTC',
    );
    expect(status.filter((s) => s.window.startsWith('d:')).map((s) => s.spent)).toEqual([
      10_000n,
      10_000n,
    ]);
    expect((await engine.getCap(parent.orgId, { kind: 'agent', id: 'looper' }, 'd'))?.hard).toBe(
      20_000_000n,
    );
    const audit = await db.select().from(auditLog).where(eq(auditLog.orgId, parent.orgId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['session.create', 'session.end']),
    );
    const childRecord = await db.query.virtualKeys.findFirst({
      where: (k, { eq: e }) => e(k.id, child),
    });
    expect(childRecord?.status).toBe('revoked');
  });

  it('prints cost as JSON and passes the command exit code through', async () => {
    const parent = await parentKey({ canMintSessions: true });
    const r = await brake(['session', '--', 'node', CLI, 'maps', 'geocode', 'Sofia'], {
      BRAKE_KEY: parent.token,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      status: 200,
      costMicros: 5000,
      cost: '$0.0050',
    });
  });

  it('refuses keys that may not mint sessions, and session keys minting more', async () => {
    const parent = await parentKey({ canMintSessions: false });
    const r = await brake(['session', '--', 'true'], { BRAKE_KEY: parent.token });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('canMintSessions');

    const minter = await parentKey({ canMintSessions: true });
    const nested = await brake(['session', '--', 'node', CLI, 'session', '--', 'true'], {
      BRAKE_KEY: minter.token,
    });
    expect(nested.code).toBe(1);
    expect(nested.stderr).toContain('could not start a session');
  });

  it('a killed parent stops its session keys', async () => {
    const parent = await parentKey({ canMintSessions: true });
    await engine.kill(parent.orgId, { kind: 'key', id: parent.keyId });
    const r = await brake(['session', '--', 'node', CLI, 'maps', 'geocode', 'x'], {
      BRAKE_KEY: parent.token,
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`Spending is switched off for key:${parent.keyId}`);
  });
});
