import { and, eq, sql, telemetryExports, virtualKeys } from '@spend-brake/db';
import {
  type Envelope,
  type GuardedClient,
  decryptSecret,
  encryptSecret,
  orgMetricsKey,
  otlpHeadersContext,
  otlpQueueKey,
  postSpans,
  renderOrgMetrics,
  testSpan,
} from '@spend-brake/shared';
import { z } from 'zod';
import { type Ctx, audit, toScope } from '../common.js';
import { entitlementsOf, requireFeature } from '../entitlements.js';
import { ApiError, type Router } from '../route.js';
import { orgTimeZone } from './budget.js';

// Headers the exporter sets itself, or that would change what the request is.
const RESERVED = new Set([
  'content-type',
  'content-length',
  'host',
  'user-agent',
  'transfer-encoding',
]);
const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'Header names are letters, digits and dashes.')
  .refine((h) => !RESERVED.has(h.toLowerCase()), 'Spend Brake sets this header itself.');

const endpoint = z
  .url()
  .max(500)
  .refine((u) => {
    const url = new URL(u);
    // Plain HTTP only to this machine (a local collector in development).
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }, 'Use an https:// URL without credentials (put API keys in headers).');

const otlpView = z.object({
  endpoint: z.string(),
  headerNames: z.array(z.string()),
  enabled: z.boolean(),
  planAllows: z.boolean().openapi({
    description: "False when the org's plan no longer includes export: nothing is sent",
  }),
  lastSuccessAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
  queued: z.number(),
});

/**
 * The org's own telemetry: its Prometheus metrics, and where its calls go as OpenTelemetry
 * spans (sent by the worker).
 */
export function telemetryRoutes(r: Router, ctx: Ctx, dispatcher: GuardedClient): void {
  r.add({
    method: 'get',
    path: '/v1/metrics',
    role: 'viewer',
    tag: 'Telemetry',
    summary: "The org's calls, cost, latency and budget in the Prometheus text format",
    response: z.string(),
    handler: async ({ auth, reply }) => {
      const hash = await ctx.valkey.hgetall(orgMetricsKey(auth.orgId));
      const keys = await ctx.db
        .select({ id: virtualKeys.id })
        .from(virtualKeys)
        .where(
          and(
            eq(virtualKeys.orgId, auth.orgId),
            eq(virtualKeys.status, 'active'),
            // Agent session keys come and go: one series each would grow without bound.
            sql`${virtualKeys.config}->>'sessionId' is null`,
          ),
        );
      const tz = await orgTimeZone(ctx, auth.orgId);
      const status = await ctx.engine.status(
        auth.orgId,
        ['org', ...keys.map((k) => `key:${k.id}`)].map(toScope),
        tz,
        ctx.now(),
      );
      const body = renderOrgMetrics(
        hash,
        status.map((s) => ({
          scope: s.scope,
          // Stable label values: "day" and "month", not the date.
          window: s.window.startsWith('d:') ? 'day' : 'month',
          spentMicros: Number(s.spent + s.held),
          hardMicros: s.hard === null ? null : Number(s.hard),
          remainingMicros: s.remaining === null ? null : Number(s.remaining),
        })),
      );
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return body;
    },
  });

  const load = async (orgId: string) => {
    const [row] = await ctx.db
      .select()
      .from(telemetryExports)
      .where(eq(telemetryExports.orgId, orgId))
      .limit(1);
    return row ?? null;
  };
  const view = async (row: typeof telemetryExports.$inferSelect) => ({
    endpoint: row.endpoint,
    headerNames: row.headerNames,
    enabled: row.enabled,
    planAllows: (await entitlementsOf(ctx, row.orgId))?.otelExport ?? true,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastError: row.lastError,
    queued: await ctx.valkey.llen(otlpQueueKey(row.orgId)),
  });

  r.add({
    method: 'get',
    path: '/v1/telemetry/otlp',
    role: 'viewer',
    tag: 'Telemetry',
    summary: 'Where calls go as OpenTelemetry spans (null when nowhere)',
    response: z.object({ otlp: otlpView.nullable() }),
    handler: async ({ auth }) => {
      const row = await load(auth.orgId);
      return { otlp: row ? await view(row) : null };
    },
  });

  r.add({
    method: 'put',
    path: '/v1/telemetry/otlp',
    role: 'admin',
    tag: 'Telemetry',
    summary: "Send every call as a span to the org's OTLP/HTTP collector",
    body: z.object({
      endpoint,
      /** Omit to keep the stored headers; {} removes them. */
      headers: z.record(headerName, z.string().min(1).max(2000)).optional(),
      enabled: z.boolean().default(true),
    }),
    response: otlpView,
    handler: async ({ auth, body }) => {
      await requireFeature(ctx, auth.orgId, 'otelExport');
      if (!ctx.wrapper) {
        throw new ApiError(503, 'no_master_key', 'Set BRAKE_MASTER_KEY or BRAKE_KMS_KEY_ID first.');
      }
      const existing = await load(auth.orgId);
      if (Object.keys(body.headers ?? {}).length > 10) {
        throw new ApiError(400, 'invalid_request', 'At most 10 headers.');
      }
      const headers = body.headers ?? null;
      const envelope =
        headers !== null || !existing
          ? await encryptSecret(
              ctx.wrapper,
              JSON.stringify(headers ?? {}),
              otlpHeadersContext(auth.orgId),
            )
          : existing.headersEnvelope;
      const names = headers !== null ? Object.keys(headers) : (existing?.headerNames ?? []);
      const row = {
        orgId: auth.orgId,
        endpoint: body.endpoint,
        headersEnvelope: envelope,
        headerNames: names,
        enabled: body.enabled,
        updatedAt: ctx.now(),
        lastError: null,
        lastErrorAt: null,
      };
      const [saved] = await ctx.db
        .insert(telemetryExports)
        .values({ ...row, createdAt: ctx.now() })
        .onConflictDoUpdate({ target: telemetryExports.orgId, set: row })
        .returning();
      await audit(ctx, auth, 'telemetry.otlp.set', null, {
        endpoint: new URL(body.endpoint).origin,
        headerNames: names,
        enabled: body.enabled,
      });
      return view(saved!);
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/telemetry/otlp',
    role: 'admin',
    tag: 'Telemetry',
    summary: 'Stop sending spans (and drop the ones waiting)',
    response: z.object({ deleted: z.boolean() }),
    handler: async ({ auth }) => {
      const rows = await ctx.db
        .delete(telemetryExports)
        .where(eq(telemetryExports.orgId, auth.orgId))
        .returning();
      await ctx.valkey.del(otlpQueueKey(auth.orgId));
      await audit(ctx, auth, 'telemetry.otlp.delete', null);
      return { deleted: rows.length > 0 };
    },
  });

  r.add({
    method: 'post',
    path: '/v1/telemetry/otlp/test',
    role: 'admin',
    tag: 'Telemetry',
    summary: 'Send one test span to the configured collector now',
    response: z.object({
      ok: z.boolean(),
      status: z.number().nullable(),
      error: z.string().nullable(),
    }),
    handler: async ({ auth }) => {
      await requireFeature(ctx, auth.orgId, 'otelExport');
      const row = await load(auth.orgId);
      if (!row) throw new ApiError(404, 'not_found', 'No OTLP endpoint is configured.');
      if (!ctx.wrapper) {
        throw new ApiError(503, 'no_master_key', 'Set BRAKE_MASTER_KEY or BRAKE_KMS_KEY_ID first.');
      }
      const headers = JSON.parse(
        await decryptSecret(
          ctx.wrapper,
          row.headersEnvelope as Envelope,
          otlpHeadersContext(auth.orgId),
        ),
      ) as Record<string, string>;
      return postSpans(row.endpoint, headers, auth.orgId, [testSpan(auth.orgId, ctx.now())], {
        dispatcher,
        timeoutMs: 8_000,
      });
    },
  });
}
