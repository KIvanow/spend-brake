import {
  type Auth,
  type Ctx,
  type RouteRef,
  type Router,
  audit,
  newApiToken,
  newId,
  sha256,
} from '@spend-brake/api';
import { apiTokens, eq } from '@spend-brake/db';
import { z } from 'zod';
import type { Entitlements } from '../entitlements.js';
import { eeTokenRoles } from '../schema.js';

export const EE_ROLES = ['operator', 'billing', 'auditor'] as const;
export type EeRole = (typeof EE_ROLES)[number];

/**
 * What each role may do on top of viewer (`METHOD /path` as the routes are declared). Tokens
 * with these roles are stored as viewer tokens, so without a license they are exactly that.
 */
export const ROLE_PERMISSIONS: Record<EeRole, readonly string[]> = {
  // Runs the system day to day: keys and the kill switch, never money or credentials.
  operator: [
    'POST /v1/kill',
    'POST /v1/unkill',
    'POST /v1/keys',
    'PATCH /v1/keys/{id}',
    'DELETE /v1/keys/{id}',
  ],
  // Owns budgets: caps, approvals and the comparison with the bill.
  billing: [
    'PUT /v1/caps/{scope}',
    'DELETE /v1/caps/{scope}',
    'POST /v1/approvals/{id}/approve',
    'POST /v1/approvals/{id}/reject',
    'PUT /v1/reconciliation',
    'DELETE /v1/reconciliation',
  ],
  // Reads everything that happened, including who holds tokens.
  auditor: ['GET /v1/audit/export', 'GET /v1/tokens'],
};

const tokenRoleCache = new Map<string, { until: number; role: EeRole | null }>();

export async function eeRoleOf(ctx: Ctx, tokenId: string): Promise<EeRole | null> {
  const hit = tokenRoleCache.get(tokenId);
  if (hit && hit.until > Date.now()) return hit.role;
  const [row] = await ctx.db
    .select({ role: eeTokenRoles.role })
    .from(eeTokenRoles)
    .where(eq(eeTokenRoles.tokenId, tokenId))
    .limit(1);
  const role = row?.role ?? null;
  tokenRoleCache.set(tokenId, { until: Date.now() + 5_000, role });
  return role;
}

/** The authorize hook: an ee role reaches its routes while the license allows it. */
export function authorizeEeRoles(ctx: Ctx, ent: Entitlements) {
  return async (auth: Auth, route: RouteRef): Promise<boolean> => {
    if (auth.role !== 'viewer') return false;
    const role = await eeRoleOf(ctx, auth.tokenId);
    if (!role) return false;
    if (!ROLE_PERMISSIONS[role].includes(`${route.method.toUpperCase()} ${route.path}`)) {
      return false;
    }
    return ent.can('rbac', route.method === 'get' ? 'read' : 'write');
  };
}

/** Issue a token for an ee role (viewer in the core) for `tokens` and single sign-on. */
export async function createRoleToken(
  ctx: Ctx,
  orgId: string,
  role: EeRole,
  opts: { name: string; userId?: string; expiresAt?: Date | null },
): Promise<{ id: string; token: string }> {
  const token = newApiToken();
  const id = newId('tok');
  await ctx.db.insert(apiTokens).values({
    id,
    orgId,
    name: opts.name,
    role: 'viewer',
    tokenHash: sha256(token),
    createdAt: ctx.now(),
    expiresAt: opts.expiresAt ?? null,
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  await ctx.db.insert(eeTokenRoles).values({ tokenId: id, orgId, role });
  return { id, token };
}

export function roleRoutes(r: Router, ctx: Ctx, ent: Entitlements): void {
  r.add({
    method: 'get',
    path: '/v1/roles',
    role: 'viewer',
    tag: 'Roles',
    summary: 'Roles beyond owner, admin and viewer, and what each may do',
    response: z.object({
      items: z.array(z.object({ role: z.string(), allows: z.array(z.string()) })),
    }),
    handler: async () => {
      await ent.require('rbac', 'read');
      return {
        items: EE_ROLES.map((role) => ({ role, allows: [...ROLE_PERMISSIONS[role]] })),
      };
    },
  });

  r.add({
    method: 'post',
    path: '/v1/roles/tokens',
    role: 'owner',
    tag: 'Roles',
    summary: 'Create an API token with an operator, billing or auditor role (shown once)',
    status: 201,
    body: z.object({
      name: z.string().min(1).max(200),
      role: z.enum(EE_ROLES),
      expiresAt: z.iso.datetime().optional(),
    }),
    response: z.object({ id: z.string(), role: z.enum(EE_ROLES), token: z.string() }),
    handler: async ({ auth, body }) => {
      await ent.require('rbac', 'write');
      const { id, token } = await createRoleToken(ctx, auth.orgId, body.role, {
        name: body.name,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      await audit(ctx, auth, 'token.create', id, { role: body.role, name: body.name });
      return { id, role: body.role, token };
    },
  });
}
