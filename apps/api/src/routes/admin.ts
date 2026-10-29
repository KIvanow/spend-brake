import { DEFAULT_LOOP_POLICY } from '@spend-brake/budget';
import { apiTokens, orgs } from '@spend-brake/db';
import { and, eq, isNull } from '@spend-brake/db';
import { z } from 'zod';
import { ROLES } from '../auth.js';
import { type Ctx, audit, id, micros } from '../common.js';
import { newApiToken, newId, sha256 } from '../ids.js';
import { type Router, notFound } from '../route.js';

const tokenView = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.enum(ROLES),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi('ApiToken');

const providerSettings = z.object({
  trustFreeTier: z.boolean().default(false),
  unpricedPolicy: z.enum(['deny', 'allow-with-default-price']).default('deny'),
  defaultPriceMicros: micros.transform((v) => v.toString()).optional(),
});

const orgView = z
  .object({
    id: z.string(),
    name: z.string(),
    timeZone: z.string(),
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi('Org');

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function adminRoutes(r: Router, ctx: Ctx): void {
  r.add({
    method: 'post',
    path: '/v1/tokens',
    role: 'owner',
    tag: 'Admin',
    summary: 'Create an admin API token (shown once)',
    status: 201,
    body: z.object({
      name: z.string().min(1).max(200),
      role: z.enum(ROLES),
      expiresAt: z.iso.datetime().optional(),
    }),
    response: tokenView.extend({ token: z.string() }),
    handler: async ({ auth, body }) => {
      const token = newApiToken();
      const [row] = await ctx.db
        .insert(apiTokens)
        .values({
          id: newId('tok'),
          orgId: auth.orgId,
          name: body.name,
          role: body.role,
          tokenHash: sha256(token),
          createdAt: ctx.now(),
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        })
        .returning();
      await audit(ctx, auth, 'token.create', row!.id, { role: body.role, name: body.name });
      return { ...tokenRow(row!), token };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/tokens',
    role: 'owner',
    tag: 'Admin',
    summary: 'List admin API tokens',
    response: z.object({ items: z.array(tokenView) }),
    handler: async ({ auth }) => {
      const rows = await ctx.db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.orgId, auth.orgId), isNull(apiTokens.revokedAt)));
      return { items: rows.map(tokenRow) };
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/tokens/{id}',
    role: 'owner',
    tag: 'Admin',
    summary: 'Revoke an admin API token',
    params: z.object({ id }),
    response: tokenView,
    handler: async ({ auth, params }) => {
      const [row] = await ctx.db
        .update(apiTokens)
        .set({ revokedAt: ctx.now() })
        .where(
          and(
            eq(apiTokens.id, params.id),
            eq(apiTokens.orgId, auth.orgId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .returning();
      if (!row) throw notFound('Token');
      await audit(ctx, auth, 'token.revoke', row.id);
      return tokenRow(row);
    },
  });

  r.add({
    method: 'get',
    path: '/v1/org',
    role: 'viewer',
    tag: 'Admin',
    summary: 'Get org settings',
    response: orgView,
    handler: async ({ auth }) => orgRow(await loadOrg(ctx, auth.orgId)),
  });

  r.add({
    method: 'put',
    path: '/v1/org',
    role: 'owner',
    tag: 'Admin',
    summary: 'Update org settings (time zone, provider pricing policy, loop policy)',
    body: z.object({
      name: z.string().min(1).max(200).optional(),
      timeZone: z.string().refine(validTimeZone, 'Unknown time zone.').optional(),
      providers: z.record(id, providerSettings).optional(),
      /** Where alerts go when no webhook is configured. */
      alertEmail: z.email().nullable().optional(),
      /** Raise links from alerts are refused; caps can only be raised from the dashboard. */
      requireLoginForRaise: z.boolean().optional(),
      loop: z
        .object({
          identical: z.number().int().positive(),
          windowSec: z.number().int().positive(),
          perMinute: z.number().int().positive(),
          cooldownSec: z.number().int().positive(),
        })
        .optional(),
    }),
    response: orgView,
    handler: async ({ auth, body }) => {
      const org = await loadOrg(ctx, auth.orgId);
      const settings = {
        ...(org.settings as Record<string, unknown>),
        ...(body.providers ? { providers: body.providers } : {}),
        ...(body.loop ? { loop: body.loop } : {}),
        ...(body.alertEmail !== undefined ? { alertEmail: body.alertEmail } : {}),
        ...(body.requireLoginForRaise !== undefined
          ? { requireLoginForRaise: body.requireLoginForRaise }
          : {}),
      };
      const timeZone = body.timeZone ?? org.timeZone;
      await syncOrg(ctx, auth.orgId, timeZone, settings);
      const [row] = await ctx.db
        .update(orgs)
        .set({ name: body.name ?? org.name, timeZone, settings })
        .where(eq(orgs.id, auth.orgId))
        .returning();
      await audit(ctx, auth, 'org.update', auth.orgId, { fields: Object.keys(body) });
      return orgRow(row!);
    },
  });
}

/** Mirror an org's settings to the record the proxy reads from Valkey. */
export async function syncOrg(
  ctx: Ctx,
  orgId: string,
  timeZone: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await ctx.registry.putOrg({
    id: orgId,
    timeZone,
    providers: (settings.providers ?? {}) as Record<string, never>,
    loop: (settings.loop as typeof DEFAULT_LOOP_POLICY | undefined) ?? DEFAULT_LOOP_POLICY,
  });
}

export async function loadOrg(ctx: Ctx, orgId: string) {
  const [org] = await ctx.db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) throw notFound('Org');
  return org;
}

function orgRow(o: typeof orgs.$inferSelect) {
  return {
    id: o.id,
    name: o.name,
    timeZone: o.timeZone,
    settings: o.settings as Record<string, unknown>,
  };
}

function tokenRow(t: typeof apiTokens.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    role: t.role,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  };
}
