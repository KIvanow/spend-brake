import { and, desc, eq, isNull, webhookDeliveries, webhooks } from '@spend-brake/db';
import { encryptSecret, newWebhookSecret } from '@spend-brake/shared';
import { z } from 'zod';
import { type Ctx, audit, id } from '../common.js';
import { newId } from '../ids.js';
import { ApiError, type Router, notFound } from '../route.js';

/** Org alerts a webhook can subscribe to (catalog drift goes to the operator). */
const ALERT_TYPES = [
  'threshold',
  'blocked',
  'loop',
  'catalog_underpriced',
  'upstream_key_error',
  'reservations_expired',
  'reconcile_drift',
] as const;

/** Envelope context for webhook URLs and signing secrets. */
export const webhookContext = (orgId: string, webhookId: string, field: 'url' | 'secret') => ({
  purpose: `webhook-${field}`,
  orgId,
  webhookId,
});

const view = z
  .object({
    id: z.string(),
    name: z.string(),
    preset: z.enum(['raw', 'slack', 'discord', 'teams']),
    urlHint: z.string(),
    events: z.array(z.string()),
    createdAt: z.string(),
  })
  .openapi('Webhook');

const toView = (w: typeof webhooks.$inferSelect) => ({
  id: w.id,
  name: w.name,
  preset: w.preset,
  urlHint: w.urlHint,
  events: w.events,
  createdAt: w.createdAt.toISOString(),
});

export function webhookRoutes(r: Router, ctx: Ctx): void {
  r.add({
    method: 'post',
    path: '/v1/webhooks',
    role: 'admin',
    tag: 'Alerts',
    summary: 'Add an alert webhook (the signing secret is shown once)',
    status: 201,
    body: z.object({
      name: z.string().min(1).max(200),
      url: z.url({ protocol: /^https?$/ }).max(2048),
      preset: z.enum(['raw', 'slack', 'discord', 'teams']).default('raw'),
      events: z.array(z.enum(ALERT_TYPES)).default([]),
      secret: z.string().min(16).max(200).optional(),
    }),
    response: view.extend({ secret: z.string() }),
    handler: async ({ auth, body }) => {
      if (!ctx.wrapper) {
        throw new ApiError(503, 'no_master_key', 'Set BRAKE_MASTER_KEY or BRAKE_KMS_KEY_ID first.');
      }
      const hookId = newId('wh');
      const secret = body.secret ?? newWebhookSecret();
      const url = new URL(body.url);
      const [row] = await ctx.db
        .insert(webhooks)
        .values({
          id: hookId,
          orgId: auth.orgId,
          name: body.name,
          preset: body.preset,
          urlEnvelope: await encryptSecret(
            ctx.wrapper,
            body.url,
            webhookContext(auth.orgId, hookId, 'url'),
          ),
          urlHint: `${url.protocol}//${url.host}`,
          secretEnvelope: await encryptSecret(
            ctx.wrapper,
            secret,
            webhookContext(auth.orgId, hookId, 'secret'),
          ),
          events: body.events,
          createdAt: ctx.now(),
        })
        .returning();
      await audit(ctx, auth, 'webhook.create', hookId, { preset: body.preset, host: url.host });
      return { ...toView(row!), secret };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/webhooks',
    role: 'viewer',
    tag: 'Alerts',
    summary: 'List alert webhooks',
    response: z.object({ items: z.array(view) }),
    handler: async ({ auth }) => {
      const rows = await ctx.db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.orgId, auth.orgId), isNull(webhooks.deletedAt)));
      return { items: rows.map(toView) };
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/webhooks/{id}',
    role: 'admin',
    tag: 'Alerts',
    summary: 'Delete an alert webhook',
    params: z.object({ id }),
    response: view,
    handler: async ({ auth, params }) => {
      const [row] = await ctx.db
        .update(webhooks)
        .set({ deletedAt: ctx.now() })
        .where(
          and(
            eq(webhooks.id, params.id),
            eq(webhooks.orgId, auth.orgId),
            isNull(webhooks.deletedAt),
          ),
        )
        .returning();
      if (!row) throw notFound('Webhook');
      await audit(ctx, auth, 'webhook.delete', row.id);
      return toView(row);
    },
  });

  r.add({
    method: 'get',
    path: '/v1/webhooks/{id}/deliveries',
    role: 'viewer',
    tag: 'Alerts',
    summary: 'Delivery log of a webhook (newest first)',
    params: z.object({ id }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
    response: z.object({
      items: z.array(
        z.object({
          alertId: z.string(),
          type: z.string(),
          attempt: z.number(),
          ok: z.boolean(),
          httpStatus: z.number().nullable(),
          error: z.string().nullable(),
          at: z.string(),
        }),
      ),
    }),
    handler: async ({ auth, params, query }) => {
      const [hook] = await ctx.db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.id, params.id), eq(webhooks.orgId, auth.orgId)))
        .limit(1);
      if (!hook) throw notFound('Webhook');
      const rows = await ctx.db
        .select()
        .from(webhookDeliveries)
        .where(
          and(eq(webhookDeliveries.webhookId, hook.id), eq(webhookDeliveries.orgId, auth.orgId)),
        )
        .orderBy(desc(webhookDeliveries.id))
        .limit(query.limit);
      return {
        items: rows.map((d) => ({
          alertId: d.alertId,
          type: d.type,
          attempt: d.attempt,
          ok: d.ok,
          httpStatus: d.httpStatus,
          error: d.error,
          at: d.at.toISOString(),
        })),
      };
    },
  });
}
