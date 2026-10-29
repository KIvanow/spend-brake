import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Partitioned by month on `ts` (see drizzle/0001_usage_events.sql); not part of drizzle-kit's
// schema so generate never tries to recreate it as a plain table.
export const usageEvents = pgTable('usage_events', {
  orgId: text('org_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  /** Stream entry id; with org_id and ts it makes inserts idempotent on replay. */
  streamId: text('stream_id').notNull(),
  type: text('type').notNull(),
  reqId: text('req_id'),
  keyId: text('key_id'),
  provider: text('provider'),
  route: text('route'),
  sku: text('sku'),
  skus: text('skus'),
  worstMicros: bigint('worst_micros', { mode: 'bigint' }),
  costMicros: bigint('cost_micros', { mode: 'bigint' }),
  status: integer('status'),
  latencyMs: real('latency_ms'),
  session: text('session'),
  env: text('env'),
  agentId: text('agent_id'),
  underpriced: boolean('underpriced').notNull().default(false),
  hash: text('hash'),
  data: jsonb('data').notNull().default({}),
});
