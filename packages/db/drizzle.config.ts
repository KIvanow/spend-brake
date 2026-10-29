import { defineConfig } from 'drizzle-kit';

// usage_events is partitioned by month, which drizzle-kit cannot generate; it lives in its own
// file outside `schema` and is created by a hand-written migration.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
