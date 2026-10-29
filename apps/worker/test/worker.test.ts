import { BudgetEngine } from '@spend-brake/budget';
import { type Db, createDb, migrate, orgs, sql, usageEvents } from '@spend-brake/db';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerConsumer, LEDGER_GROUP } from '../src/ledger.js';
import { Metrics } from '../src/metrics.js';
import { Worker, catalogSourceUrls } from '../src/worker.js';

const NOW = new Date('2026-10-29T12:00:00Z');
let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: Redis;
let queueConn: Redis;
let engine: BudgetEngine;
let pages: Record<string, string>;
let worker: Worker;
const quiet = { info() {}, warn() {}, error() {} };

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
  const url = `redis://${vk.getHost()}:${vk.getMappedPort(6379)}`;
  valkey = new Redis(url);
  queueConn = new Redis(url, { maxRetriesPerRequest: null });
  engine = new BudgetEngine(valkey);
  pages = {};
  worker = new Worker({
    db,
    valkey,
    queueConnection: queueConn,
    workerId: 'w-test',
    log: quiet,
    fetchPage: (u) => Promise.resolve(pages[u] ?? '<table><tr><td>$1.00</td></tr></table>'),
    now: () => NOW,
  });
  await worker.partitionsOnce();
});

afterAll(async () => {
  await worker.stop();
  await valkey.quit();
  await queueConn.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

let orgN = 0;
async function newOrg(): Promise<string> {
  const id = `o${++orgN}`;
  await db.insert(orgs).values({ id, name: id });
  await worker.refreshOrgs();
  return id;
}

async function usage(org: string, fields: Record<string, string>) {
  return engine.emit(org, { type: 'usage', provider: 'google-maps', ...fields });
}

const jobs = async () =>
  (await worker.alerts.queue.getJobs(['waiting', 'delayed', 'active', 'completed'])).map((j) => ({
    id: j.id,
    ...(j.data as { type: string } & Record<string, unknown>),
  }));

beforeEach(async () => {
  await worker.alerts.queue.obliterate({ force: true });
});

describe('ledger', () => {
  it('copies stream events into Postgres and acks them', async () => {
    const org = await newOrg();
    await usage(org, {
      reqId: 'r1',
      keyId: 'k1',
      route: 'geocoding',
      skus: 'geocoding',
      worstMicros: '5000',
      costMicros: '5000',
      status: '200',
      latencyMs: '1.5',
      session: 's1',
    });
    await engine.emit(org, {
      type: 'blocked',
      reason: 'budget_exceeded',
      scope: 'key:k1',
      window: 'd:20261029',
      keyId: 'k1',
    });
    expect(await worker.ledgerOnce()).toBe(2);
    const rows = await db
      .select()
      .from(usageEvents)
      .where(sql`org_id = ${org}`);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.type === 'usage')).toMatchObject({
      reqId: 'r1',
      keyId: 'k1',
      sku: 'geocoding',
      costMicros: 5000n,
      status: 200,
      latencyMs: 1.5,
      session: 's1',
    });
    expect(rows.find((r) => r.type === 'blocked')?.data).toMatchObject({
      reason: 'budget_exceeded',
      scope: 'key:k1',
    });
    expect(await worker.ledgerOnce()).toBe(0);
    const pending = (await valkey.xpending(`bk:{o:${org}}:events`, LEDGER_GROUP)) as [number];
    expect(pending[0]).toBe(0);
  });

  it('replays unacked entries after a crash without duplicating rows', async () => {
    const org = await newOrg();
    await usage(org, { reqId: 'r1', costMicros: '1' });
    await usage(org, { reqId: 'r2', costMicros: '2' });
    // Consumer A inserts the rows, then dies before acking.
    const crashed = new LedgerConsumer(db, valkey, 'crashed', () =>
      Promise.reject(new Error('crash')),
    );
    await expect(crashed.runOnce([org])).rejects.toThrow('crash');
    // Consumer B claims the pending entries and writes them again; the primary key absorbs it.
    const b = new LedgerConsumer(db, valkey, 'survivor');
    expect(await b.claimStale([org], 0)).toBe(2);
    const rows = await db
      .select()
      .from(usageEvents)
      .where(sql`org_id = ${org}`);
    expect(rows.map((r) => r.reqId).sort()).toEqual(['r1', 'r2']);
    const pending = (await valkey.xpending(`bk:{o:${org}}:events`, LEDGER_GROUP)) as [number];
    expect(pending[0]).toBe(0);
  });

  it('trims only what the ledger consumed and reports lag', async () => {
    const org = await newOrg();
    for (let i = 0; i < 5; i++) await usage(org, { reqId: `t${i}` });
    expect(await worker.ledger.lag([org])).toBe(5);
    await worker.ledgerOnce();
    expect(await valkey.xlen(`bk:{o:${org}}:events`)).toBeLessThanOrEqual(1);
    expect(await worker.ledger.lag([org])).toBe(0);
    // New events after the trim are still delivered.
    await usage(org, { reqId: 't5' });
    expect(await worker.ledgerOnce()).toBe(1);
  });

  it('never trims entries another consumer has not acked', async () => {
    const org = await newOrg();
    await usage(org, { reqId: 'p1' });
    await worker.ledgerOnce();
    await usage(org, { reqId: 'p2' });
    // Delivered to a consumer that has not acked yet.
    await valkey.xreadgroup('GROUP', LEDGER_GROUP, 'slow', 'STREAMS', `bk:{o:${org}}:events`, '>');
    await worker.ledger.trim(org);
    const left = await valkey.xrange(`bk:{o:${org}}:events`, '-', '+');
    expect(left.map(([, f]) => f[f.indexOf('reqId') + 1])).toContain('p2');
  });

  it('picks up events written before the first run', async () => {
    const org = `early${orgN++}`;
    await usage(org, { reqId: 'before' });
    await db.insert(orgs).values({ id: org, name: org });
    await worker.refreshOrgs();
    await worker.ledgerOnce();
    const rows = await db
      .select()
      .from(usageEvents)
      .where(sql`org_id = ${org}`);
    expect(rows.map((r) => r.reqId)).toEqual(['before']);
  });
});

describe('alerts', () => {
  it('queues the alerts the doc lists, deduped per window', async () => {
    const org = await newOrg();
    await usage(org, {
      reqId: 'r1',
      keyId: 'k1',
      crossings: JSON.stringify([{ scope: 'key:k1', window: 'd:20261029', mark: '80' }]),
    });
    await usage(org, {
      reqId: 'r2',
      underpriced: '1',
      route: 'geocoding',
      costMicros: '9',
      worstMicros: '5',
    });
    await usage(org, { reqId: 'r3', status: '403', keyId: 'k1' });
    await usage(org, { reqId: 'r4', status: '403', keyId: 'k1' });
    for (let i = 0; i < 3; i++) {
      await engine.emit(org, {
        type: 'blocked',
        reason: 'budget_exceeded',
        scope: 'key:k1',
        window: 'd:20261029',
      });
    }
    await engine.emit(org, { type: 'loop', reason: 'loop_detected', keyId: 'k1', hash: 'h' });
    await worker.ledgerOnce();
    const types = (await jobs()).map((j) => j.type).sort();
    expect(types).toEqual([
      'blocked',
      'catalog_underpriced',
      'loop',
      'threshold',
      'upstream_key_error',
    ]);
    expect((await jobs()).find((j) => j.type === 'threshold')).toMatchObject({
      orgId: org,
      scope: 'key:k1',
      mark: '80',
    });
  });
});

describe('sweeper', () => {
  it('commits abandoned reservations at worst case, counts them and alerts', async () => {
    const org = await newOrg();
    await engine.reserve({
      orgId: org,
      reqId: 'abandoned',
      amount: 7000n,
      scopes: [{ kind: 'org' }],
      killTargets: [],
      timeZone: 'UTC',
      now: new Date(NOW.getTime() - 300_000),
    });
    const before = (await worker.metrics.reservationsExpired.get()).values[0]?.value ?? 0;
    expect(await worker.sweepOnce()).toBe(1);
    const [s] = await engine.status(org, [{ kind: 'org' }], 'UTC', NOW);
    expect(s).toMatchObject({ spent: 7000n, held: 0n });
    expect((await worker.metrics.reservationsExpired.get()).values[0]?.value).toBe(before + 1);
    expect((await jobs()).map((j) => j.type)).toEqual(['reservations_expired']);
  });
});

describe('catalog drift', () => {
  it('records a baseline, then alerts only when a pricing table changes', async () => {
    const [pricing] = catalogSourceUrls();
    pages[pricing!] = '<nav>x</nav><table><tr><td>Text Search Pro</td><td>$32.00</td></tr></table>';
    expect(await worker.driftOnce()).toBe(0);
    pages[pricing!] =
      '<nav>changed nav</nav><table><tr><td>Text Search Pro</td><td>$32.00</td></tr></table>';
    expect(await worker.driftOnce()).toBe(0);
    pages[pricing!] = '<table><tr><td>Text Search Pro</td><td>$35.00</td></tr></table>';
    expect(await worker.driftOnce()).toBe(1);
    expect((await jobs()).find((j) => j.type === 'catalog_drift')).toMatchObject({ url: pricing });
    expect(await worker.driftOnce()).toBe(0);
  });
});

describe('metrics', () => {
  it('serves Prometheus metrics', async () => {
    const m = new Metrics();
    m.reservationsExpired.inc(2);
    const server = m.serve(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const body = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(body).toContain('brake_reservations_expired_total 2');
    server.close();
  });
});

describe('partitions', () => {
  it('creates this and next month', async () => {
    const res = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from pg_class where relname in ('usage_events_202610', 'usage_events_202611')`,
    );
    expect(res.rows[0]!.n).toBe('2');
  });
});
