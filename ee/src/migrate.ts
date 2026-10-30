import { fileURLToPath } from 'node:url';
import { type Db, migrateFolder } from '@spend-brake/db';

/** Apply the ee migrations (after the core ones), tracked in their own table. */
export async function migrateEe(db: Db): Promise<void> {
  await migrateFolder(db, {
    folder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    lock: 7_212_025,
    table: '__drizzle_migrations_ee',
  });
}
