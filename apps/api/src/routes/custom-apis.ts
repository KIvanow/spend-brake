import { isIP } from 'node:net';
import { type KeyRecord } from '@spend-brake/budget';
import { customApiSchema, customApiUpdateSchema } from '@spend-brake/catalog';
import {
  and,
  customApis,
  eq,
  isNull,
  providerCredentials,
  sql,
  virtualKeys,
} from '@spend-brake/db';
import { PROVIDER_NAMES, isPrivateAddress, providerName } from '@spend-brake/shared';
import { z } from 'zod';
import { type Ctx, audit, id } from '../common.js';
import { requireCapacity } from '../entitlements.js';
import { ApiError, type Router, notFound } from '../route.js';

// APIs an org prices itself. Postgres holds them; the proxy reads the org's whole set from one
// Valkey record (rewritten on every change), so it serves `/custom/<id>/...` for that org only.

/** Where custom API origins may point, from the API's environment. */
export interface CustomApiPolicy {
  /** Allow private and loopback addresses (self-hosted: an API on the same network). */
  allowPrivate: boolean;
  /** The service's own hostnames (and their subdomains), never a custom API origin. */
  ownHosts: string[];
}

/** spendbrake.dev and its subdomains are refused everywhere, whatever the environment says. */
export const SERVICE_HOSTS = ['spendbrake.dev'];

const pricing = z
  .union([
    z.object({ model: z.literal('perRequest'), usd: z.string() }),
    z.object({
      model: z.literal('reported'),
      header: z.string().optional(),
      jsonPath: z.string().optional(),
      usdPerUnit: z.string(),
      maxPerRequest: z.string(),
    }),
  ])
  .openapi('CustomApiPricing');

const customApi = z
  .object({
    id: z.string(),
    name: z.string(),
    origin: z.string(),
    auth: z.union([
      z.object({ type: z.literal('header'), name: z.string(), valuePrefix: z.string() }),
      z.object({ type: z.literal('query'), name: z.string() }),
    ]),
    routes: z.array(z.object({ method: z.string(), path: z.string(), sku: z.string(), pricing })),
    billed: z.enum(['2xx', 'all']),
    timeoutBilled: z.boolean(),
    proxyPath: z.string().openapi({ description: 'Call it at <proxy URL><proxyPath>/<path>' }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('CustomApi');

type Row = typeof customApis.$inferSelect;
type Definition = z.output<typeof customApiSchema>;

const view = (r: Row) => ({
  id: r.id,
  name: r.name,
  origin: r.origin,
  auth: r.auth as Definition['auth'],
  routes: r.routes as Definition['routes'],
  billed: r.billed,
  timeoutBilled: r.timeoutBilled,
  proxyPath: `/custom/${r.id}`,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** What the proxy reads (see @spend-brake/catalog customApiRecordSchema). */
const record = (r: Row) => ({
  id: r.id,
  name: r.name,
  origin: r.origin,
  auth: r.auth,
  routes: r.routes,
  billed: r.billed,
  timeoutBilled: r.timeoutBilled,
});

/** Write an org's custom APIs through to the proxy's record. */
export async function syncCustomApis(ctx: Ctx, orgId: string, rows?: Row[]): Promise<number> {
  const all = rows ?? (await ctx.db.select().from(customApis).where(eq(customApis.orgId, orgId)));
  await ctx.registry.putCustomApis(orgId, all.map(record));
  return all.length;
}

/** A provider's display name: built-in names, then the org's custom APIs, then the id. */
export async function providerLabel(ctx: Ctx, orgId: string, provider: string): Promise<string> {
  if (PROVIDER_NAMES[provider]) return providerName(provider);
  const [row] = await ctx.db
    .select({ name: customApis.name })
    .from(customApis)
    .where(and(eq(customApis.orgId, orgId), eq(customApis.id, provider)))
    .limit(1);
  return row?.name ?? provider;
}

const hostMatches = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

/** Why an origin may not be used, or null. Hostnames that resolve privately are refused by the proxy. */
export function originProblem(origin: string, policy: CustomApiPolicy): string | null {
  const host = new URL(origin).hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if ([...SERVICE_HOSTS, ...policy.ownHosts].some((d) => hostMatches(host, d))) {
    return 'A custom API cannot point at Spend Brake itself.';
  }
  if (policy.allowPrivate) return null;
  if ((isIP(host) && isPrivateAddress(host)) || hostMatches(host, 'localhost')) {
    return 'A custom API cannot point at a private or loopback address on this server.';
  }
  return null;
}

export function customApiRoutes(r: Router, ctx: Ctx): void {
  const policy = ctx.customApiPolicy ?? { allowPrivate: false, ownHosts: [] };

  async function load(orgId: string, apiId: string): Promise<Row> {
    const [row] = await ctx.db
      .select()
      .from(customApis)
      .where(and(eq(customApis.orgId, orgId), eq(customApis.id, apiId)))
      .limit(1);
    if (!row) throw notFound('Custom API');
    return row;
  }

  function checkOrigin(origin: string): void {
    const problem = originProblem(origin, policy);
    if (problem) {
      throw Object.assign(new ApiError(400, 'invalid_request', 'Request failed validation.'), {
        issues: [{ in: 'body', path: 'origin', message: problem }],
      });
    }
  }

  const rowOf = (orgId: string, apiId: string, d: Omit<Definition, 'id'>, created: Date) => ({
    orgId,
    id: apiId,
    name: d.name,
    origin: d.origin,
    auth: d.auth,
    routes: d.routes,
    billed: d.billed,
    timeoutBilled: d.timeoutBilled,
    createdAt: created,
    updatedAt: ctx.now(),
  });

  r.add({
    method: 'get',
    path: '/v1/custom-apis',
    role: 'viewer',
    tag: 'Custom APIs',
    summary: "List the org's custom APIs",
    response: z.object({ items: z.array(customApi) }),
    handler: async ({ auth }) => {
      const rows = await ctx.db
        .select()
        .from(customApis)
        .where(eq(customApis.orgId, auth.orgId))
        .orderBy(customApis.createdAt);
      return { items: rows.map(view) };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/custom-apis/{id}',
    role: 'viewer',
    tag: 'Custom APIs',
    summary: 'Get a custom API',
    params: z.object({ id }),
    response: customApi,
    handler: async ({ auth, params }) => view(await load(auth.orgId, params.id)),
  });

  r.add({
    method: 'post',
    path: '/v1/custom-apis',
    role: 'admin',
    tag: 'Custom APIs',
    summary: 'Add a custom API (an API you price yourself)',
    status: 201,
    body: customApiSchema,
    response: customApi,
    handler: async ({ auth, body }) => {
      const d = body;
      if (PROVIDER_NAMES[d.id]) {
        throw new ApiError(
          400,
          'invalid_request',
          `"${d.id}" is a built-in provider; pick another id for the custom API.`,
        );
      }
      checkOrigin(d.origin);
      const existing = await ctx.db
        .select()
        .from(customApis)
        .where(eq(customApis.orgId, auth.orgId));
      if (existing.some((e) => e.id === d.id)) {
        throw new ApiError(409, 'conflict', `The org already has a custom API "${d.id}".`);
      }
      await requireCapacity(ctx, auth.orgId, 'customApi');
      const now = ctx.now();
      const row: Row = rowOf(auth.orgId, d.id, d, now);
      // Valkey first, like every enforcement record: one that lists in the API must also be
      // callable through the proxy.
      await syncCustomApis(ctx, auth.orgId, [...existing, row]);
      const [inserted] = await ctx.db.insert(customApis).values(row).returning();
      await audit(ctx, auth, 'custom_api.create', d.id, {
        name: d.name,
        origin: d.origin,
        routes: d.routes.length,
      });
      return view(inserted!);
    },
  });

  r.add({
    method: 'put',
    path: '/v1/custom-apis/{id}',
    role: 'admin',
    tag: 'Custom APIs',
    summary: 'Replace a custom API definition (its id stays)',
    params: z.object({ id }),
    body: customApiUpdateSchema,
    response: customApi,
    handler: async ({ auth, params, body }) => {
      const current = await load(auth.orgId, params.id);
      const d = body;
      checkOrigin(d.origin);
      const row: Row = rowOf(auth.orgId, current.id, d, current.createdAt);
      const others = (
        await ctx.db.select().from(customApis).where(eq(customApis.orgId, auth.orgId))
      ).filter((e) => e.id !== current.id);
      await syncCustomApis(ctx, auth.orgId, [...others, row]);
      const [updated] = await ctx.db
        .update(customApis)
        .set({
          name: row.name,
          origin: row.origin,
          auth: row.auth,
          routes: row.routes,
          billed: row.billed,
          timeoutBilled: row.timeoutBilled,
          updatedAt: row.updatedAt,
        })
        .where(and(eq(customApis.orgId, auth.orgId), eq(customApis.id, current.id)))
        .returning();
      await audit(ctx, auth, 'custom_api.update', current.id, {
        name: d.name,
        origin: d.origin,
        routes: d.routes.length,
        ...(d.origin !== current.origin ? { previousOrigin: current.origin } : {}),
      });
      return view(updated!);
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/custom-apis/{id}',
    role: 'admin',
    tag: 'Custom APIs',
    summary: 'Delete a custom API and its provider keys (refused while Spend Brake keys use it)',
    params: z.object({ id }),
    response: z.object({
      id: z.string(),
      deleted: z.literal(true),
      deletedCredentials: z.array(z.string()).openapi({
        description: 'Provider keys stored for this custom API, deleted with it',
      }),
    }),
    handler: async ({ auth, params }) => {
      const current = await load(auth.orgId, params.id);
      const users = await ctx.db
        .select({ id: virtualKeys.id, name: virtualKeys.name, config: virtualKeys.config })
        .from(virtualKeys)
        .where(
          and(
            eq(virtualKeys.orgId, auth.orgId),
            eq(virtualKeys.status, 'active'),
            sql`jsonb_exists(${virtualKeys.config}->'credentials', ${current.id})`,
          ),
        );
      // Session keys follow the key that minted them: name the keys people manage.
      const named = users.filter((k) => !(k.config as KeyRecord).sessionId);
      if (users.length) {
        const list = (named.length ? named : users).map((k) => `"${k.name}"`);
        throw new ApiError(
          409,
          'custom_api_in_use',
          `Spend Brake key${list.length > 1 ? 's' : ''} ${list.join(', ')} call${list.length > 1 ? '' : 's'} ${current.name}. Remove it from ${list.length > 1 ? 'those keys' : 'that key'} (or revoke ${list.length > 1 ? 'them' : 'it'}) first.`,
        );
      }
      const others = (
        await ctx.db.select().from(customApis).where(eq(customApis.orgId, auth.orgId))
      ).filter((e) => e.id !== current.id);
      // Stop the proxy from serving it first.
      await syncCustomApis(ctx, auth.orgId, others);
      await ctx.db
        .delete(customApis)
        .where(and(eq(customApis.orgId, auth.orgId), eq(customApis.id, current.id)));
      // Its provider keys can call nothing any more (no key uses them): delete them too.
      const creds = await ctx.db
        .select({ id: providerCredentials.id })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.orgId, auth.orgId),
            eq(providerCredentials.provider, current.id),
            isNull(providerCredentials.revokedAt),
          ),
        );
      for (const c of creds) {
        await ctx.registry.deleteCredential(auth.orgId, c.id);
        await ctx.db
          .update(providerCredentials)
          .set({ revokedAt: ctx.now() })
          .where(eq(providerCredentials.id, c.id));
      }
      await audit(ctx, auth, 'custom_api.delete', current.id, {
        name: current.name,
        ...(creds.length ? { deletedCredentials: creds.map((c) => c.id) } : {}),
      });
      return { id: current.id, deleted: true as const, deletedCredentials: creds.map((c) => c.id) };
    },
  });
}
