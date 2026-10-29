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

export async function migrate(db: Db): Promise<void> {
  await runMigrations(db, {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  });
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
export { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
