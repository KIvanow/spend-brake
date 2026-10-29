import { auditLog, usageEvents } from '@spend-brake/db';
import { type SQL, and, desc, eq, gte, lt, or, sql } from '@spend-brake/db';
import { z } from 'zod';
import { type Ctx, id, n } from '../common.js';
import { ApiError, type Router } from '../route.js';
import { orgTimeZone } from './budget.js';

const GROUPS = {
  key: usageEvents.keyId,
  sku: usageEvents.sku,
  provider: usageEvents.provider,
  session: usageEvents.session,
  env: usageEvents.env,
  agent: usageEvents.agentId,
} as const;

const cursor = {
  encode: (parts: (string | number)[]) => Buffer.from(JSON.stringify(parts)).toString('base64url'),
  decode: (c: string): unknown[] => {
    try {
      const v = JSON.parse(Buffer.from(c, 'base64url').toString()) as unknown;
      if (Array.isArray(v)) return v;
    } catch {
      // fall through
    }
    throw new ApiError(400, 'invalid_request', 'Bad cursor.');
  },
};

export function ledgerRoutes(r: Router, ctx: Ctx): void {
  r.add({
    method: 'get',
    path: '/v1/spend',
    role: 'viewer',
    tag: 'Spend',
    summary: 'Spend from the ledger, grouped by key, SKU, day, ...',
    query: z.object({
      groupBy: z
        .string()
        .default('day')
        .transform((s) => s.split(',').map((g) => g.trim()))
        .pipe(z.array(z.enum(['key', 'sku', 'day', 'provider', 'session', 'env', 'agent'])).min(1)),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
    }),
    response: z.object({
      items: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
    }),
    handler: async ({ auth, query }) => {
      const tz = await orgTimeZone(ctx, auth.orgId);
      const cols: Record<string, SQL> = {};
      for (const g of query.groupBy) {
        cols[g] =
          g === 'day'
            ? sql`to_char(${usageEvents.ts} at time zone ${tz}, 'YYYY-MM-DD')`
            : sql`${GROUPS[g]}`;
      }
      // Settlement adjustments (signed) correct the cost of sends priced later (Twilio).
      const where = [
        eq(usageEvents.orgId, auth.orgId),
        sql`${usageEvents.type} in ('usage', 'adjustment')`,
      ];
      if (query.from) where.push(gte(usageEvents.ts, new Date(query.from)));
      if (query.to) where.push(lt(usageEvents.ts, new Date(query.to)));
      // Group by position: a parameterized expression (the time zone) appears twice otherwise,
      // and Postgres treats $1 and $2 as different expressions.
      const positions = sql.raw(
        Object.keys(cols)
          .map((_, i) => String(i + 1))
          .join(', '),
      );
      const rows = await ctx.db
        .select({
          ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.mapWith(String)])),
          costMicros: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)::text`,
          requests: sql<string>`(count(*) filter (where ${usageEvents.type} = 'usage'))::text`,
        })
        .from(usageEvents)
        .where(and(...where))
        .groupBy(positions)
        .orderBy(positions);
      return {
        items: rows.map((row) => ({
          ...row,
          costMicros: Number(row.costMicros),
          requests: Number(row.requests),
        })),
      };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/events',
    role: 'viewer',
    tag: 'Events',
    summary: 'Usage events (newest first), or the audit log with source=audit',
    query: z.object({
      source: z.enum(['usage', 'audit']).default('usage'),
      type: z.string().max(64).optional(),
      keyId: id.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      cursor: z.string().max(500).optional(),
    }),
    response: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      nextCursor: z.string().nullable(),
    }),
    handler: async ({ auth, query }) => {
      if (query.source === 'audit') {
        const where = [eq(auditLog.orgId, auth.orgId)];
        if (query.type) where.push(eq(auditLog.action, query.type));
        if (query.cursor) {
          const raw = String(cursor.decode(query.cursor)[0]);
          if (!/^\d{1,19}$/.test(raw)) throw new ApiError(400, 'invalid_request', 'Bad cursor.');
          where.push(lt(auditLog.id, BigInt(raw)));
        }
        const rows = await ctx.db
          .select()
          .from(auditLog)
          .where(and(...where))
          .orderBy(desc(auditLog.id))
          .limit(query.limit);
        return {
          items: rows.map((a) => ({ ...a, id: a.id.toString(), at: a.at.toISOString() })),
          nextCursor:
            rows.length === query.limit ? cursor.encode([rows.at(-1)!.id.toString()]) : null,
        };
      }
      const where = [eq(usageEvents.orgId, auth.orgId)];
      if (query.type) where.push(eq(usageEvents.type, query.type));
      if (query.keyId) where.push(eq(usageEvents.keyId, query.keyId));
      if (query.cursor) {
        const [ts, streamId] = cursor.decode(query.cursor);
        const at = new Date(String(ts));
        if (Number.isNaN(at.getTime()) || typeof streamId !== 'string') {
          throw new ApiError(400, 'invalid_request', 'Bad cursor.');
        }
        where.push(
          or(
            lt(usageEvents.ts, at),
            and(eq(usageEvents.ts, at), lt(usageEvents.streamId, String(streamId))),
          )!,
        );
      }
      const rows = await ctx.db
        .select()
        .from(usageEvents)
        .where(and(...where))
        .orderBy(desc(usageEvents.ts), desc(usageEvents.streamId))
        .limit(query.limit);
      const last = rows.at(-1);
      return {
        items: rows.map((e) => ({
          ...e,
          ts: e.ts.toISOString(),
          worstMicros: n(e.worstMicros),
          costMicros: n(e.costMicros),
        })),
        nextCursor:
          rows.length === query.limit && last
            ? cursor.encode([last.ts.toISOString(), last.streamId])
            : null,
      };
    },
  });
}
