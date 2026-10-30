import { ApiError, type Ctx, type Router, audit, bootstrapOrg } from '@spend-brake/api';
import { count, orgs, sql } from '@spend-brake/db';
import { z } from 'zod';
import type { Entitlements } from '../entitlements.js';

const orgView = z
  .object({ id: z.string(), name: z.string(), timeZone: z.string(), createdAt: z.string() })
  .openapi('Org');

/**
 * More than one org on one install. Only owners of the org the license was issued to manage
 * them, up to the license's `orgUnits` (the licensed org counts as one).
 */
export function orgRoutes(r: Router, ctx: Ctx, ent: Entitlements): void {
  const installOwner = async (orgId: string, mode: 'read' | 'write') => {
    await ent.require('multi_org', mode);
    const { license } = await ent.state();
    if (license?.org !== orgId) {
      throw new ApiError(403, 'forbidden', `Only owners of org ${license?.org} manage orgs.`);
    }
    return license;
  };

  r.add({
    method: 'get',
    path: '/v1/orgs',
    role: 'owner',
    tag: 'Orgs',
    summary: 'Orgs on this install (owners of the licensed org)',
    response: z.object({ items: z.array(orgView), limit: z.number() }),
    handler: async ({ auth }) => {
      const license = await installOwner(auth.orgId, 'read');
      const rows = await ctx.db.select().from(orgs).orderBy(orgs.createdAt);
      return {
        items: rows.map((o) => ({
          id: o.id,
          name: o.name,
          timeZone: o.timeZone,
          createdAt: o.createdAt.toISOString(),
        })),
        limit: license.orgUnits,
      };
    },
  });

  r.add({
    method: 'post',
    path: '/v1/orgs',
    role: 'owner',
    tag: 'Orgs',
    summary: 'Create another org with its own owner token (shown once)',
    status: 201,
    body: z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      name: z.string().min(1).max(200),
      timeZone: z.string().default('UTC'),
    }),
    response: z.object({ orgId: z.string(), ownerToken: z.string() }),
    handler: async ({ auth, body }) => {
      const license = await installOwner(auth.orgId, 'write');
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timeZone });
      } catch {
        throw new ApiError(400, 'invalid_request', 'Unknown time zone.');
      }
      const ownerToken = await ctx.db.transaction(async (tx) => {
        // The same lock as first-run setup: concurrent creates cannot both pass the limit.
        await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
        const [{ total } = { total: 0 }] = await tx.select({ total: count() }).from(orgs);
        if (total >= license.orgUnits) {
          throw new ApiError(
            403,
            'org_limit',
            `The license allows ${license.orgUnits} orgs on this install.`,
          );
        }
        const [taken] = await tx
          .select({ id: orgs.id })
          .from(orgs)
          .where(sql`${orgs.id} = ${body.id}`)
          .limit(1);
        if (taken) throw new ApiError(409, 'conflict', 'An org with this id exists.');
        return bootstrapOrg(
          { db: tx as unknown as typeof ctx.db, registry: ctx.registry },
          { id: body.id, name: body.name, timeZone: body.timeZone },
        );
      });
      await audit(ctx, auth, 'org.create', body.id, { name: body.name });
      return { orgId: body.id, ownerToken };
    },
  });
}
