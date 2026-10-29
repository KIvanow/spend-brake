import { sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Db,
  createDb,
  ensureUsagePartitions,
  migrate,
  orgs,
  usageEvents,
} from '../src/index.js';

let container: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };

beforeAll(async () => {
  container = await new GenericContainer('postgres:16')
    .withEnvironment({ POSTGRES_PASSWORD: 'p', POSTGRES_USER: 'brake', POSTGRES_DB: 'brake' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  ({ db, pool } = createDb(
    `postgres://brake:p@${container.getHost()}:${container.getMappedPort(5432)}/brake`,
  ));
  await migrate(db);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('migrations', () => {
  it('are idempotent', async () => {
    await migrate(db);
  });

  it('are safe to run from several processes at once on a fresh database', async () => {
    await db.execute(sql`create database fresh`);
    const url = `postgres://brake:p@${container.getHost()}:${container.getMappedPort(5432)}/fresh`;
    const many = Array.from({ length: 4 }, () => createDb(url, 2));
    try {
      await Promise.all(many.map((m) => migrate(m.db)));
      const r = await many[0]!.db.execute<{ n: string }>(
        sql`select count(*)::text as n from information_schema.tables where table_name = 'api_tokens'`,
      );
      expect(r.rows[0]!.n).toBe('1');
    } finally {
      await Promise.all(many.map((m) => m.pool.end()));
    }
  });

  it('partition the usage ledger by month', async () => {
    const names = await ensureUsagePartitions(db, new Date('2026-12-15T00:00:00Z'));
    expect(names).toEqual(['usage_events_202612', 'usage_events_202701']);
    await ensureUsagePartitions(db, new Date('2026-12-15T00:00:00Z'));

    await db.insert(orgs).values({ id: 'o1', name: 'O1' });
    const row = {
      orgId: 'o1',
      streamId: '1-0',
      type: 'usage',
      costMicros: 5000n,
    };
    await db.insert(usageEvents).values([
      { ...row, ts: new Date('2026-12-20T00:00:00Z') },
      { ...row, ts: new Date('2027-01-02T00:00:00Z'), streamId: '2-0' },
      { ...row, ts: new Date('2030-01-01T00:00:00Z'), streamId: '3-0' },
    ]);
    const where = await db.execute<{ part: string; n: string }>(
      sql`select tableoid::regclass::text as part, count(*)::text as n from usage_events group by 1 order by 1`,
    );
    expect(where.rows).toEqual([
      { part: 'usage_events_202612', n: '1' },
      { part: 'usage_events_202701', n: '1' },
      { part: 'usage_events_default', n: '1' },
    ]);
    // Replays of the same stream entry are rejected by the primary key.
    await expect(
      db.insert(usageEvents).values({ ...row, ts: new Date('2026-12-20T00:00:00Z') }),
    ).rejects.toThrow();
  });
});
