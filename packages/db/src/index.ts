import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { usageEvents } from './ledger.js';
import * as schema from './schema.js';

export * from './schema.js';
export { usageEvents } from './ledger.js';

export const tables = { ...schema, usageEvents };

export function createDb(url: string, max = 10) {
  const pool = new pg.Pool({ connectionString: url, max });
  return { db: drizzle(pool, { schema: tables }), pool };
}

export type Db = ReturnType<typeof createDb>['db'];

const MIGRATION_LOCK = 7_212_024;

/**
 * Apply migrations. Several services run this on start (API, worker); a session-level advisory
 * lock makes them take turns, so two fresh processes never race to create the same tables.
 */
export async function migrate(db: Db): Promise<void> {
  const lock = await db.$client.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await runMigrations(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    lock.release();
  }
}

/** Create the monthly ledger partitions for this month and the next. */
export async function ensureUsagePartitions(db: Db, now = new Date()): Promise<string[]> {
  const names: string[] = [];
  for (const offset of [0, 1]) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const res = await db.execute<{ name: string }>(
      sql`select ensure_usage_partition(${month.toISOString().slice(0, 10)}::date) as name`,
    );
    names.push(res.rows[0]!.name);
  }
  return names;
}

// Apps import query helpers from here so there is one drizzle-orm instance (a second copy with
// different optional peers has incompatible types).
export { type SQL, and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
