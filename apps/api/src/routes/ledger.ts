import { Readable } from 'node:stream';
import { auditLog, usageEvents, virtualKeys } from '@spend-brake/db';
import { type SQL, and, desc, eq, gte, lt, or, sql } from '@spend-brake/db';
import { outcomeOf } from '@spend-brake/shared';
import { z } from 'zod';
import { type Ctx, id, n } from '../common.js';
import { type Cell, csvRow } from '../csv.js';
import { ApiError, type Router } from '../route.js';
import { orgTimeZone } from './budget.js';
import { requireFeature } from '../entitlements.js';

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

/** An ISO 8601 time with `Z` or an offset (`+02:00`), or a plain date (a UTC day). */
const instant = (param: 'from' | 'to') =>
  z.union([z.iso.datetime({ offset: true }), z.iso.date()], {
    error: `${param} must be an ISO 8601 time with Z or an offset (2026-10-31T00:00:00+02:00) or a date (2026-10-31).`,
  });
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A plain `from` date starts at 00:00 UTC that day. */
const fromTime = (v: string) => new Date(PLAIN_DATE.test(v) ? `${v}T00:00:00Z` : v);
/** A plain `to` date includes that whole UTC day: the bound is 00:00 UTC the next day. */
function toTime(v: string): Date {
  if (!PLAIN_DATE.test(v)) return new Date(v);
  const d = new Date(`${v}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Filters shared by /v1/events and /v1/events.csv. */
const eventFilters = {
  source: z.enum(['usage', 'audit']).default('usage'),
  type: z.string().max(64).optional(),
  keyId: id.optional(),
  from: instant('from').optional().openapi({
    description:
      'Inclusive lower bound on the event time: ISO 8601 with Z or an offset, or a date (00:00 UTC).',
    example: '2026-10-01',
  }),
  to: instant('to').optional().openapi({
    description:
      'Exclusive upper bound on the event time: ISO 8601 with Z or an offset, or a date (through the end of that day, UTC).',
    example: '2026-10-31T18:00:00+02:00',
  }),
};
type EventFilters = z.output<z.ZodObject<typeof eventFilters>>;

/**
 * The days an export covers, for its file name, as the caller wrote them: `from`'s date, and the
 * last day before `to` (a `to` at midnight, such as the next local day, is exclusive).
 */
function rangeLabel(q: EventFilters): string | null {
  if (!q.from && !q.to) return null;
  let last = q.to?.slice(0, 10);
  if (q.to && !PLAIN_DATE.test(q.to) && /^T00:00(?::00(?:\.0+)?)?(?:Z|[+-])/.test(q.to.slice(10))) {
    const d = new Date(`${last}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    last = d.toISOString().slice(0, 10);
  }
  return `${q.from?.slice(0, 10) ?? 'start'}_${last ?? 'now'}`;
}

function usageWhere(orgId: string, q: EventFilters): SQL[] {
  const where = [eq(usageEvents.orgId, orgId)];
  if (q.type) where.push(eq(usageEvents.type, q.type));
  if (q.keyId) where.push(eq(usageEvents.keyId, q.keyId));
  if (q.from) where.push(gte(usageEvents.ts, fromTime(q.from)));
  if (q.to) where.push(lt(usageEvents.ts, toTime(q.to)));
  return where;
}

function auditWhere(orgId: string, q: EventFilters): SQL[] {
  const where = [eq(auditLog.orgId, orgId)];
  if (q.type) where.push(eq(auditLog.action, q.type));
  if (q.from) where.push(gte(auditLog.at, fromTime(q.from)));
  if (q.to) where.push(lt(auditLog.at, toTime(q.to)));
  return where;
}

/** Most rows one CSV export holds; narrow `from`/`to` for more (see the API README). */
export const CSV_ROW_CAP = 100_000;
const CSV_BATCH = 1_000;

const USAGE_CSV = [
  'time_utc',
  'type',
  'key_id',
  'key_name',
  'provider',
  'route',
  'sku',
  'outcome',
  'status',
  'cost_usd',
  'cost_micros',
  'worst_micros',
  'latency_ms',
  'session',
  'env',
  'agent_id',
  'request_id',
  'data',
];
const AUDIT_CSV = ['time_utc', 'actor', 'action', 'target', 'reason', 'data'];
/** A UTF-8 byte order mark first, so Excel reads the file as UTF-8 (names in any script). */
const BOM = '\uFEFF';

const json = (v: unknown): string | null =>
  v === null || v === undefined || (typeof v === 'object' && Object.keys(v).length === 0)
    ? null
    : JSON.stringify(v);

/**
 * Micro-dollars as dollars, exact: the decimal is built from integers, and a number keeps it a
 * number in the CSV (negative adjustments are not mistaken for formulas).
 */
function usdOf(m: bigint | null): number | null {
  if (m === null) return null;
  const neg = m < 0n;
  const abs = neg ? -m : m;
  return Number(
    `${neg ? '-' : ''}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`,
  );
}

export function ledgerRoutes(r: Router, ctx: Ctx): void {
  /** Usage rows, newest first, in batches by keyset, with each key's current name. */
  async function* usageCsv(orgId: string, q: EventFilters): AsyncGenerator<string> {
    yield BOM + csvRow(USAGE_CSV);
    let after: { ts: Date; streamId: string } | null = null;
    let left = CSV_ROW_CAP;
    while (left > 0) {
      const where = usageWhere(orgId, q);
      if (after) {
        where.push(
          or(
            lt(usageEvents.ts, after.ts),
            and(eq(usageEvents.ts, after.ts), lt(usageEvents.streamId, after.streamId)),
          )!,
        );
      }
      const rows = await ctx.db
        .select({ e: usageEvents, keyName: virtualKeys.name })
        .from(usageEvents)
        .leftJoin(
          virtualKeys,
          and(eq(virtualKeys.id, usageEvents.keyId), eq(virtualKeys.orgId, usageEvents.orgId)),
        )
        .where(and(...where))
        .orderBy(desc(usageEvents.ts), desc(usageEvents.streamId))
        .limit(Math.min(CSV_BATCH, left));
      let chunk = '';
      for (const { e, keyName } of rows) {
        const data = e.data as Record<string, unknown>;
        const cells: Cell[] = [
          e.ts.toISOString(),
          e.type,
          e.keyId,
          keyName,
          e.provider,
          e.route,
          e.sku,
          outcomeOf({ type: e.type, status: e.status, data }),
          e.status,
          usdOf(e.costMicros),
          n(e.costMicros),
          n(e.worstMicros),
          e.latencyMs,
          e.session,
          e.env,
          e.agentId,
          e.reqId,
          json(data),
        ];
        chunk += csvRow(cells);
      }
      if (chunk) yield chunk;
      left -= rows.length;
      const last = rows.at(-1);
      if (!last || rows.length < CSV_BATCH) return;
      after = { ts: last.e.ts, streamId: last.e.streamId };
    }
  }

  async function* auditCsv(orgId: string, q: EventFilters): AsyncGenerator<string> {
    yield BOM + csvRow(AUDIT_CSV);
    let before: bigint | null = null;
    let left = CSV_ROW_CAP;
    while (left > 0) {
      const where = auditWhere(orgId, q);
      if (before !== null) where.push(lt(auditLog.id, before));
      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(and(...where))
        .orderBy(desc(auditLog.id))
        .limit(Math.min(CSV_BATCH, left));
      let chunk = '';
      for (const a of rows) {
        chunk += csvRow([a.at.toISOString(), a.actor, a.action, a.target, a.reason, json(a.data)]);
      }
      if (chunk) yield chunk;
      left -= rows.length;
      const last = rows.at(-1);
      if (!last || rows.length < CSV_BATCH) return;
      before = last.id;
    }
  }

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
      if (query.groupBy.some((g) => g === 'session' || g === 'agent')) {
        await requireFeature(ctx, auth.orgId, 'sessionAnalytics');
      }
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
          // Calls the provider answered without an error (the outcome "ok" of /v1/metrics).
          succeeded: sql<string>`(count(*) filter (where ${usageEvents.type} = 'usage'
            and ${usageEvents.status} between 200 and 399
            and ${usageEvents.data}->>'error' is null
            and ${usageEvents.data}->>'keyError' is null
            and ${usageEvents.data}->>'providerError' is null))::text`,
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
          succeeded: Number(row.succeeded),
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
      ...eventFilters,
      limit: z.coerce.number().int().min(1).max(500).default(100),
      cursor: z.string().max(500).optional(),
    }),
    response: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      nextCursor: z.string().nullable(),
    }),
    handler: async ({ auth, query }) => {
      if (query.source === 'audit') {
        const where = auditWhere(auth.orgId, query);
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
      const where = usageWhere(auth.orgId, query);
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
          outcome: outcomeOf({
            type: e.type,
            status: e.status,
            data: e.data as Record<string, unknown>,
          }),
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
  r.add({
    method: 'get',
    path: '/v1/events.csv',
    role: 'viewer',
    tag: 'Events',
    summary: `The events of /v1/events as a CSV download, newest first (at most ${CSV_ROW_CAP.toLocaleString('en-US')} rows; X-Brake-Truncated says when more matched)`,
    query: z.object(eventFilters),
    response: z.string(),
    contentType: 'text/csv',
    handler: async ({ auth, query, reply }) => {
      // One probe past the cap says whether the export is cut short, before any row is sent.
      const probe =
        query.source === 'audit'
          ? ctx.db
              .select({ one: sql`1` })
              .from(auditLog)
              .where(and(...auditWhere(auth.orgId, query)))
          : ctx.db
              .select({ one: sql`1` })
              .from(usageEvents)
              .where(and(...usageWhere(auth.orgId, query)));
      const truncated = (await probe.offset(CSV_ROW_CAP).limit(1)).length > 0;
      // Named by the range picked, or by today's date for everything.
      const days = rangeLabel(query) ?? ctx.now().toISOString().slice(0, 10);
      reply
        .type('text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="spend-brake-${query.source === 'audit' ? 'audit' : 'requests'}-${days}.csv"`,
        )
        .header('cache-control', 'no-store')
        .header('x-brake-truncated', truncated ? 'true' : 'false');
      return Readable.from(
        query.source === 'audit' ? auditCsv(auth.orgId, query) : usageCsv(auth.orgId, query),
      );
    },
  });
}
