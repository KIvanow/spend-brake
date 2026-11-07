import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildApi } from '@spend-brake/api';
import { bootstrapOrg } from '@spend-brake/api/bootstrap';
import { BudgetEngine, Registry } from '@spend-brake/budget';
import { ExaAdapter, GoogleMapsAdapter, TavilyAdapter } from '@spend-brake/catalog';
import { type Db, auditLog, createDb, eq, migrate } from '@spend-brake/db';
import { buildServer } from '@spend-brake/proxy';
import { StaticSecretStore } from '@spend-brake/proxy/secrets';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';

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
let searchCalls = 0;

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
  // Tavily and Exa both search at POST /search; Exa authenticates with x-api-key.
  mock.post('/search', (req) => {
    searchCalls++;
    return req.headers['x-api-key']
      ? { results: [{ url: 'https://exa.example' }], costDollars: { total: 0.004 } }
      : { results: [{ url: 'https://tavily.example' }], usage: { credits: 1 } };
  });
  const mockUrl = await mock.listen({ port: 0, host: '127.0.0.1' });

  api = await buildApi({ db, valkey, wrapper: null, authCacheMs: 0, rateLimitPerMinute: 100_000 });
  apiUrl = await api.listen({ port: 0, host: '127.0.0.1' });
  proxy = buildServer({
    valkey,
    adapters: [new GoogleMapsAdapter(), new TavilyAdapter(), new ExaAdapter()],
    secrets: new StaticSecretStore({
      'cred-google': 'AIza-real',
      'cred-tavily': 'tvly-real',
      'cred-exa': 'exa-real',
    }),
    upstreamOverrides: {
      'https://maps.googleapis.com': mockUrl,
      'https://api.tavily.com': mockUrl,
      'https://api.exa.ai': mockUrl,
    },
  });
  proxyUrl = await proxy.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await Promise.all([proxy.close(), api.close(), mock.close()]);
  await valkey.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

function brake(args: string[], env: Record<string, string>, cwd?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      ...(cwd ? { cwd } : {}),
      env: { PATH: process.env.PATH ?? '', BRAKE_URL: proxyUrl, BRAKE_API_URL: apiUrl, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    // 'close', not 'exit': the output may still be arriving when the process exits.
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function parentKey(opts: { canMintSessions: boolean; credentials?: Record<string, string> }) {
  const orgId = `org_${randomBytes(3).toString('hex')}`;
  await bootstrapOrg({ db, registry }, { id: orgId, name: orgId });
  // The key exists in Valkey (what the proxy and the session endpoint read) and Postgres.
  const { token, record } = await registry.createKey({
    id: `key_parent_${randomBytes(3).toString('hex')}`,
    orgId,
    credentials: opts.credentials ?? { 'google-maps': 'cred-google' },
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

describe('brake doctor end to end', () => {
  it('--prove: a $0 budget stops a priced call before the provider sees it', async () => {
    const parent = await parentKey({ canMintSessions: true });
    await engine.setCap(parent.orgId, { kind: 'key', id: parent.keyId }, 'd', {
      hard: 1_000_000n,
      soft: null,
    });
    const home = mkdtempSync(join(tmpdir(), 'brake-doctor-e2e-'));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const before = googleCalls;
    const r = await brake(
      ['doctor', '--prove'],
      { BRAKE_KEY: parent.token, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
      home,
    );
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      checks: { id: string; status: string; detail?: string }[];
    };
    const probe = report.checks.find((c) => c.id === 'enforcement.exhausted-budget')!;
    expect(probe, probe.detail).toMatchObject({ status: 'pass' });
    expect(probe.detail).toContain('402 budget_exceeded');
    // The proof: the upstream received nothing.
    expect(googleCalls - before).toBe(0);
    expect(report.checks.find((c) => c.id === 'key.capped')!.status).toBe('pass');
    expect(report.ok).toBe(true);
    expect(r.code).toBe(0);

    // The probe session is ended, and it spent nothing.
    const sessions = await db.query.virtualKeys.findMany({
      where: (k, { eq: e }) => e(k.orgId, parent.orgId),
    });
    const probeKey = sessions.find((k) => k.id !== parent.keyId)!;
    expect(probeKey.status).toBe('revoked');
    const [status] = await engine.status(parent.orgId, [{ kind: 'key', id: parent.keyId }], 'UTC');
    expect(status!.spent).toBe(0n);
  });
});

describe('brake mcp end to end', () => {
  it('serves capped Tavily and Exa search over stdio until the session cap stops it', async () => {
    const parent = await parentKey({
      canMintSessions: true,
      credentials: { tavily: 'cred-tavily', exa: 'cred-exa' },
    });
    // Tavily basic is $0.008 and Exa lite $0.004: a $0.016 session fits three searches.
    const child = spawn(
      process.execPath,
      [CLI, 'session', '--budget', '0.016', '--agent', 'mcp', '--', process.execPath, CLI, 'mcp'],
      {
        env: {
          PATH: process.env.PATH ?? '',
          BRAKE_URL: proxyUrl,
          BRAKE_API_URL: apiUrl,
          BRAKE_KEY: parent.token,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    // Also when an assertion fails or a reply never comes: no session process outlives the test.
    onTestFinished(async () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    });
    const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let id = 0;
    // One request at a time, so which call meets the cap is fixed.
    const rpc = async (method: string, params: object = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
      const line = await replies.next();
      return (JSON.parse(line.value as string) as { result: Record<string, unknown> }).result;
    };
    const tool = async (name: string, args: object = {}) =>
      (await rpc('tools/call', { name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };

    expect(
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
    ).toMatchObject({
      serverInfo: { name: 'spend-brake' },
    });
    const before = searchCalls;
    const first = await tool('tavily_search', { query: 'valkey' });
    expect(JSON.parse(first.content[0]!.text)).toMatchObject({
      cost: '$0.0080',
      result: { results: [{ url: 'https://tavily.example' }] },
    });
    expect((await tool('exa_search', { query: 'valkey', type: 'lite' })).isError).toBeUndefined();
    expect((await tool('exa_search', { query: 'valkey', type: 'lite' })).isError).toBeUndefined();
    const stopped = await tool('tavily_search', { query: 'valkey' });
    expect(stopped.isError).toBe(true);
    expect(stopped.content[0]!.text).toMatch(/^STOP\. Spend cap reached for key:key_/);
    expect(searchCalls - before).toBe(3);

    const budget = JSON.parse((await tool('brake_budget')).content[0]!.text) as {
      caps: { scope: string; remaining: string }[];
    };
    expect(budget.caps.find((c) => c.scope.startsWith('key:'))).toMatchObject({
      remaining: '$0.0000',
    });

    child.stdin.end();
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);
  });
});
