import { randomBytes } from 'node:crypto';
import { loadGoogleMapsCatalog } from '@spend-brake/catalog';
import {
  type Db,
  createDb,
  eq,
  migrate,
  orgs,
  reconciliationConfigs,
  reconciliationResults,
  usageEvents,
} from '@spend-brake/db';
import { LocalKeyWrapper, billingExportContext, encryptSecret } from '@spend-brake/shared';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BillingRow,
  billingDay,
  billingQuery,
  daysToCheck,
  reconcileDay,
  validExportTable,
} from '../src/reconcile.js';
import { Worker } from '../src/worker.js';

const catalog = loadGoogleMapsCatalog();
const SA = JSON.stringify({
  project_id: 'p',
  client_email: 'reader@p.iam.gserviceaccount.com',
  private_key: 'PRIVATE-KEY-MATERIAL',
});

describe('billing export query', () => {
  it('only accepts project.dataset.table names and sums cost into integer micros in BigQuery', () => {
    expect(validExportTable('billing-proj.billing_ds.gcp_billing_export_v1_0123')).toBe(true);
    for (const bad of ['a.b', 'a.b.c; DROP', 'a.b.`c`', 'a.b.c.d', ''])
      expect(validExportTable(bad), bad).toBe(false);
    const q = billingQuery('p.ds.t');
    expect(q).toContain('FROM `p.ds.t`');
    expect(q).toContain('CAST(ROUND(SUM(cost) * 1000000) AS INT64)');
    expect(q).toContain('sku.id IN UNNEST(@sku_ids)');
    expect(() => billingQuery('p.ds.t`; x')).toThrow();
  });

  it('cuts billing days in Pacific time', () => {
    // PDT (UTC-7) on Oct 29 2026, PST (UTC-8) after Nov 1.
    expect(billingDay('2026-10-29', 'America/Los_Angeles')).toEqual({
      start: new Date('2026-10-29T07:00:00Z'),
      end: new Date('2026-10-30T07:00:00Z'),
    });
    expect(billingDay('2026-11-01', 'America/Los_Angeles')).toEqual({
      start: new Date('2026-11-01T07:00:00Z'),
      end: new Date('2026-11-02T08:00:00Z'),
    });
    expect(daysToCheck(new Date('2026-10-29T20:00:00Z'), 'America/Los_Angeles')).toEqual([
      '2026-10-28',
      '2026-10-27',
      '2026-10-26',
    ]);
  });
});

let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: Redis;
let queueConn: Redis;

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
});

afterAll(async () => {
  await valkey.quit();
  await queueConn.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

let n = 0;
async function orgWithUsage(costs: [sku: string, micros: bigint, at: string][]) {
  const orgId = `rec${++n}`;
  await db.insert(orgs).values({ id: orgId, name: orgId });
  if (costs.length === 0) return orgId;
  await db.insert(usageEvents).values(
    costs.map(([sku, cost, at], i) => ({
      orgId,
      ts: new Date(at),
      streamId: `${i}-0`,
      type: 'usage',
      provider: 'google-maps',
      sku,
      costMicros: cost,
      status: 200,
    })),
  );
  return orgId;
}

const fixed = (rows: BillingRow[]) => ({ costs: () => Promise.resolve(rows) });

describe('reconcileDay', () => {
  it('compares ledger and bill per SKU family and in total, within the Pacific billing day', async () => {
    const orgId = await orgWithUsage([
      ['places.text_search.pro', 32_000n, '2026-10-28T08:00:00Z'], // Oct 28 PT
      ['places.text_search.enterprise', 35_000n, '2026-10-28T20:00:00Z'],
      ['legacy.places.details', 25_000n, '2026-10-28T21:00:00Z'], // base + contact + atmosphere
      ['geocoding', 5_000n, '2026-10-28T06:59:59Z'], // still Oct 27 PT: not counted
    ]);
    const r = await reconcileDay(
      db,
      fixed([
        { skuId: '4FDA-34B1-A910', currency: 'USD', costMicros: 32_000n }, // text search pro
        { skuId: 'E967-44BC-B44D', currency: 'USD', costMicros: 35_000n }, // text search enterprise
        { skuId: 'FC5C-DF28-543F', currency: 'USD', costMicros: 17_000n }, // legacy details
        { skuId: 'F095-CD01-81B2', currency: 'USD', costMicros: 3_000n }, // contact data
        { skuId: 'D63D-5CC5-302A', currency: 'USD', costMicros: 5_000n }, // atmosphere data
      ]),
      catalog,
      { orgId, projectIds: [] },
      '2026-10-28',
    );
    expect(r.families).toEqual([
      { family: 'legacy.places', ledgerMicros: 25_000n, billedMicros: 25_000n, driftRatio: 0 },
      { family: 'places.text_search', ledgerMicros: 67_000n, billedMicros: 67_000n, driftRatio: 0 },
    ]);
    expect(r.total).toMatchObject({ ledgerMicros: 92_000n, billedMicros: 92_000n, driftRatio: 0 });
    expect(r.alert).toBeNull();
    const stored = await db
      .select()
      .from(reconciliationResults)
      .where(eq(reconciliationResults.orgId, orgId));
    expect(stored.map((s) => s.family).sort()).toEqual([
      'legacy.places',
      'places.text_search',
      'total',
    ]);
  });

  it('alerts when the bill and the ledger differ by more than 5%', async () => {
    const orgId = await orgWithUsage([['geocoding', 1_000_000n, '2026-10-28T12:00:00Z']]);
    const r = await reconcileDay(
      db,
      fixed([{ skuId: 'BAC8-4E68-E261', currency: 'USD', costMicros: 1_100_000n }]),
      catalog,
      { orgId, projectIds: [] },
      '2026-10-28',
    );
    expect(r.total.driftRatio).toBeCloseTo(0.0909, 3);
    expect(r.alert).toMatchObject({
      type: 'reconcile_drift',
      dedupeId: `reconcile:${orgId}:2026-10-28`,
      data: { day: '2026-10-28', ledgerMicros: '1000000', billedMicros: '1100000' },
    });
  });

  it('does not alert on tiny days or within 5%', async () => {
    const small = await orgWithUsage([['geocoding', 5_000n, '2026-10-28T12:00:00Z']]);
    const a = await reconcileDay(
      db,
      fixed([{ skuId: 'BAC8-4E68-E261', currency: 'USD', costMicros: 10_000n }]),
      catalog,
      { orgId: small, projectIds: [] },
      '2026-10-28',
    );
    expect(a.alert).toBeNull();
    const close = await orgWithUsage([['geocoding', 2_000_000n, '2026-10-28T12:00:00Z']]);
    const b = await reconcileDay(
      db,
      fixed([{ skuId: 'BAC8-4E68-E261', currency: 'USD', costMicros: 2_080_000n }]),
      catalog,
      { orgId: close, projectIds: [] },
      '2026-10-28',
    );
    expect(b.alert).toBeNull();
  });

  it('refuses exports in another currency', async () => {
    const orgId = await orgWithUsage([]);
    await expect(
      reconcileDay(
        db,
        fixed([{ skuId: 'BAC8-4E68-E261', currency: 'EUR', costMicros: 1n }]),
        catalog,
        { orgId, projectIds: [] },
        '2026-10-28',
      ),
    ).rejects.toThrow(/EUR/);
  });
});

describe('worker reconciliation loop', () => {
  it('decrypts the service account, checks the last three days, alerts, records the metric and errors', async () => {
    const wrapper = new LocalKeyWrapper(randomBytes(32).toString('base64'));
    const orgId = await orgWithUsage([['geocoding', 2_000_000n, '2026-10-28T12:00:00Z']]);
    const broken = await orgWithUsage([]);
    for (const id of [orgId, broken]) {
      await db.insert(reconciliationConfigs).values({
        orgId: id,
        exportTable: 'p.ds.t',
        envelope: await encryptSecret(wrapper, SA, billingExportContext(id)),
        serviceAccount: 'reader@p.iam.gserviceaccount.com',
      });
    }
    const seen: { table: string; sa: string }[] = [];
    const worker = new Worker({
      db,
      valkey,
      queueConnection: queueConn,
      workerId: 'rec',
      log: { info() {}, warn() {}, error() {} },
      wrapper,
      now: () => new Date('2026-10-29T20:00:00Z'),
      billingSource: (table, sa) => {
        seen.push({ table, sa });
        if (seen.length === 2)
          return Promise.reject(
            new Error('permission denied for PRIVATE-KEY-MATERIAL? no: bigquery.jobs.create'),
          );
        return Promise.resolve(
          fixed([{ skuId: 'BAC8-4E68-E261', currency: 'USD', costMicros: 3_000_000n }]),
        );
      },
    });
    await worker.alerts.queue.obliterate({ force: true });
    expect(await worker.reconcileOnce()).toBe(3);
    expect(seen[0]).toEqual({ table: 'p.ds.t', sa: SA });
    const jobs = await worker.alerts.queue.getJobs(['waiting', 'delayed']);
    expect(jobs.map((j) => (j.data as { type: string }).type)).toContain('reconcile_drift');
    expect(await worker.metrics.registry.metrics()).toMatch(
      new RegExp(`brake_reconcile_drift_ratio\\{org="${orgId}"\\} 0.333333`),
    );
    const [ok] = await db
      .select()
      .from(reconciliationConfigs)
      .where(eq(reconciliationConfigs.orgId, orgId));
    expect(ok).toMatchObject({ lastError: null });
    expect(ok!.lastRunAt).toBeInstanceOf(Date);
    const [bad] = await db
      .select()
      .from(reconciliationConfigs)
      .where(eq(reconciliationConfigs.orgId, broken));
    expect(bad!.lastError).toContain('bigquery.jobs.create');
    expect(bad!.lastError).not.toContain('PRIVATE-KEY-MATERIAL');
    await worker.stop();
  });
});
