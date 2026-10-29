import { caps, virtualKeys } from '@spend-brake/db';
import { orgs } from '@spend-brake/db';
import { and, eq } from '@spend-brake/db';
import { z } from 'zod';
import {
  type Ctx,
  audit,
  killLabel,
  micros,
  n,
  scopeLabel,
  toKillTarget,
  toScope,
} from '../common.js';
import { type Router, notFound } from '../route.js';

const capValues = z.object({ hard: micros.nullable(), soft: micros.nullable().optional() });

const capView = z
  .object({
    scope: z.string(),
    kind: z.enum(['d', 'm']),
    hard: z.number().nullable(),
    soft: z.number().nullable(),
    version: z.number(),
  })
  .openapi('Cap');

export async function orgTimeZone(ctx: Ctx, orgId: string): Promise<string> {
  const [org] = await ctx.db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) throw notFound('Org');
  return org.timeZone;
}

export function budgetRoutes(r: Router, ctx: Ctx): void {
  r.add({
    method: 'put',
    path: '/v1/caps/{scope}',
    role: 'admin',
    tag: 'Caps',
    summary: 'Set hard / soft caps for a scope, per day and/or month (null removes a limit)',
    params: z.object({ scope: scopeLabel }),
    body: z
      .object({ day: capValues.optional(), month: capValues.optional() })
      .refine((b) => b.day || b.month, 'Give day and/or month.'),
    response: z.object({ items: z.array(capView) }),
    handler: async ({ auth, params, body }) => {
      const scope = toScope(params.scope);
      const items = [];
      for (const [kind, values] of [
        ['d', body.day],
        ['m', body.month],
      ] as const) {
        if (!values) continue;
        const hard = values.hard;
        const soft = values.soft ?? null;
        // Valkey first: enforcement changes on the next request.
        const version = await ctx.engine.setCap(auth.orgId, scope, kind, { hard, soft });
        const row = {
          orgId: auth.orgId,
          scope: params.scope,
          kind,
          hardMicros: hard,
          softMicros: soft,
          version,
          updatedAt: ctx.now(),
        };
        await ctx.db
          .insert(caps)
          .values(row)
          .onConflictDoUpdate({ target: [caps.orgId, caps.scope, caps.kind], set: row });
        await audit(ctx, auth, 'cap.set', `${params.scope}:${kind}`, {
          hard: n(hard),
          soft: n(soft),
          version,
        });
        items.push({ scope: params.scope, kind, hard: n(hard), soft: n(soft), version });
      }
      return { items };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/caps',
    role: 'viewer',
    tag: 'Caps',
    summary: 'List caps',
    response: z.object({ items: z.array(capView) }),
    handler: async ({ auth }) => {
      const rows = await ctx.db.select().from(caps).where(eq(caps.orgId, auth.orgId));
      return {
        items: rows.map((c) => ({
          scope: c.scope,
          kind: c.kind,
          hard: n(c.hardMicros),
          soft: n(c.softMicros),
          version: c.version,
        })),
      };
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/caps/{scope}',
    role: 'admin',
    tag: 'Caps',
    summary: 'Remove the caps of a scope',
    params: z.object({ scope: scopeLabel }),
    query: z.object({ kind: z.enum(['d', 'm']).optional() }),
    response: z.object({ scope: z.string(), deleted: z.array(z.enum(['d', 'm'])) }),
    handler: async ({ auth, params, query }) => {
      const kinds = query.kind ? [query.kind] : (['d', 'm'] as const);
      for (const kind of kinds) {
        await ctx.engine.deleteCap(auth.orgId, toScope(params.scope), kind);
        await ctx.db
          .delete(caps)
          .where(
            and(eq(caps.orgId, auth.orgId), eq(caps.scope, params.scope), eq(caps.kind, kind)),
          );
      }
      await audit(ctx, auth, 'cap.delete', params.scope, { kinds });
      return { scope: params.scope, deleted: [...kinds] };
    },
  });

  const killBody = z.object({ target: killLabel, reason: z.string().max(500).optional() });
  const killView = z.object({ killed: z.array(z.string()) }).openapi('KillSet');

  r.add({
    method: 'post',
    path: '/v1/kill',
    role: 'admin',
    tag: 'Kill switch',
    summary: 'Stop all spend for an org, provider, key or session (immediate)',
    body: killBody,
    response: killView,
    handler: async ({ auth, body }) => {
      await ctx.engine.kill(auth.orgId, toKillTarget(body.target));
      await audit(ctx, auth, 'kill', body.target, {}, body.reason ?? null);
      return { killed: await ctx.engine.killed(auth.orgId) };
    },
  });

  r.add({
    method: 'post',
    path: '/v1/unkill',
    role: 'admin',
    tag: 'Kill switch',
    summary: 'Lift a kill',
    body: killBody,
    response: killView,
    handler: async ({ auth, body }) => {
      await ctx.engine.unkill(auth.orgId, toKillTarget(body.target));
      await audit(ctx, auth, 'unkill', body.target, {}, body.reason ?? null);
      return { killed: await ctx.engine.killed(auth.orgId) };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/status',
    role: 'viewer',
    tag: 'Spend',
    summary: 'Live remaining budget per scope (from Valkey)',
    query: z.object({
      scope: z
        .union([scopeLabel, z.array(scopeLabel)])
        .optional()
        .openapi({ description: 'Defaults to the org and every active key' }),
    }),
    response: z.object({
      killed: z.array(z.string()),
      scopes: z.array(
        z.object({
          scope: z.string(),
          window: z.string(),
          spent: z.number(),
          held: z.number(),
          hard: z.number().nullable(),
          soft: z.number().nullable(),
          remaining: z.number().nullable(),
        }),
      ),
    }),
    handler: async ({ auth, query }) => {
      let labels = query.scope === undefined ? [] : [query.scope].flat();
      if (labels.length === 0) {
        const keys = await ctx.db
          .select({ id: virtualKeys.id })
          .from(virtualKeys)
          .where(and(eq(virtualKeys.orgId, auth.orgId), eq(virtualKeys.status, 'active')));
        labels = ['org', ...keys.map((k) => `key:${k.id}`)];
      }
      const tz = await orgTimeZone(ctx, auth.orgId);
      const status = await ctx.engine.status(auth.orgId, labels.map(toScope), tz, ctx.now());
      return {
        killed: await ctx.engine.killed(auth.orgId),
        scopes: status.map((s) => ({
          scope: s.scope,
          window: s.window,
          spent: Number(s.spent),
          held: Number(s.held),
          hard: n(s.hard),
          soft: n(s.soft),
          remaining: n(s.remaining),
        })),
      };
    },
  });
}
