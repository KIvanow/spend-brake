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
  await migrateFolder(db, {
    folder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    lock: MIGRATION_LOCK,
  });
}

/** Apply a folder of drizzle migrations under an advisory lock, tracked in `table`. */
export async function migrateFolder(
  db: Db,
  opts: { folder: string; lock: number; table?: string },
): Promise<void> {
  const lock = await db.$client.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [opts.lock]);
    await runMigrations(db, {
      migrationsFolder: opts.folder,
      ...(opts.table ? { migrationsTable: opts.table } : {}),
    });
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [opts.lock]).catch(() => undefined);
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
export {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
