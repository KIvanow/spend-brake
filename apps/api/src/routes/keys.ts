import { type KeyRecord, generateVirtualKey, hashVirtualKey } from '@spend-brake/budget';
import { providerCredentials, sql, virtualKeys } from '@spend-brake/db';
import { and, eq, inArray, isNull } from '@spend-brake/db';
import { z } from 'zod';
import { type Ctx, audit, id, micros } from '../common.js';
import { newId } from '../ids.js';
import { ApiError, type Router, notFound } from '../route.js';
import { requireCapacity, requireFeature } from '../entitlements.js';

const loop = z.object({
  identical: z.number().int().positive(),
  windowSec: z.number().int().positive(),
  perMinute: z.number().int().positive(),
  cooldownSec: z.number().int().positive(),
});

const keyFields = {
  name: z.string().min(1).max(200),
  /** provider -> credential id */
  credentials: z.record(id, id).refine((c) => Object.keys(c).length > 0, 'At least one provider.'),
  skus: z.array(z.string().min(1)).nullable().optional(),
  env: id.nullable().optional(),
  agentId: id.nullable().optional(),
  sessionCapMicros: micros.nullable().optional(),
  loop: loop.nullable().optional(),
  failOpenMicros: micros.nullable().optional(),
  allowedIps: z.array(z.string().min(1)).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  canMintSessions: z.boolean().optional(),
  /** Messaging: destination countries (ISO alpha-2); null = default US and CA only. */
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(250)
    .nullable()
    .optional(),
  /** Messaging pumping limits; null = defaults (5 per number, 50 per prefix, per hour). */
  pumping: z
    .object({
      perNumberPerHour: z.number().int().positive(),
      perPrefixPerHour: z.number().int().positive(),
      cooldownSec: z.number().int().positive(),
    })
    .nullable()
    .optional(),
};

const createBody = z.object(keyFields).openapi('CreateKey');
const patchBody = z.object(keyFields).partial().openapi('UpdateKey');

const keyView = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    status: z.enum(['active', 'revoked']),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
  })
  .openapi('VirtualKey');

type Row = typeof virtualKeys.$inferSelect;

const view = (r: Row) => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
  config: r.config as Record<string, unknown>,
});

type Fields = z.output<typeof patchBody>;

function record(keyId: string, orgId: string, f: Fields, base?: KeyRecord): KeyRecord {
  const pick = <K extends keyof Fields, T>(
    k: K,
    fallback: T,
    map: (v: NonNullable<Fields[K]>) => T,
  ) => (f[k] === undefined ? fallback : f[k] === null ? (null as T) : map(f[k]));
  return {
    id: keyId,
    orgId,
    status: base?.status ?? 'active',
    expiresAt: pick('expiresAt', base?.expiresAt ?? null, (v) => new Date(v).toISOString()),
    credentials: f.credentials ?? base?.credentials ?? {},
    skus: pick('skus', base?.skus ?? null, (v) => v),
    env: pick('env', base?.env ?? null, (v) => v),
    agentId: pick('agentId', base?.agentId ?? null, (v) => v),
    sessionCapMicros: pick('sessionCapMicros', base?.sessionCapMicros ?? null, (v) => v.toString()),
    loop: pick('loop', base?.loop ?? null, (v) => v),
    failOpenMicros: pick('failOpenMicros', base?.failOpenMicros ?? null, (v) => v.toString()),
    allowedIps: pick('allowedIps', base?.allowedIps ?? null, (v) => v),
    canMintSessions: f.canMintSessions ?? base?.canMintSessions ?? false,
    countries: pick('countries', base?.countries ?? null, (v) => v),
    pumping: pick('pumping', base?.pumping ?? null, (v) => v),
    // Session-key fields are set only by POST /v1/sessions.
    sessionId: base?.sessionId ?? null,
    agentDayCapMicros: base?.agentDayCapMicros ?? null,
    parentKeyId: base?.parentKeyId ?? null,
  };
}

export function keyRoutes(r: Router, ctx: Ctx): void {
  async function checkCredentials(orgId: string, creds: Record<string, string>) {
    const ids = Object.values(creds);
    const rows = await ctx.db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.orgId, orgId),
          inArray(providerCredentials.id, ids),
          isNull(providerCredentials.revokedAt),
        ),
      );
    for (const [provider, credId] of Object.entries(creds)) {
      if (!rows.some((c) => c.id === credId && c.provider === provider)) {
        throw new ApiError(400, 'invalid_request', `No ${provider} credential ${credId}.`);
      }
    }
  }

  /**
   * Session keys are copies of their parent: when the parent is revoked they are revoked, and
   * when its bindings change (credentials, SKUs, IPs, environment, loop policy, expiry) they
   * follow, so a session never has more reach than the key that minted it.
   */
  async function syncChildren(parentId: string, parent: KeyRecord): Promise<number> {
    const rows = await ctx.db
      .select()
      .from(virtualKeys)
      .where(
        and(
          eq(virtualKeys.orgId, parent.orgId),
          eq(virtualKeys.status, 'active'),
          sql`${virtualKeys.config}->>'parentKeyId' = ${parentId}`,
        ),
      );
    for (const child of rows) {
      const c = child.config as KeyRecord;
      const expiresAt =
        parent.expiresAt && (!c.expiresAt || Date.parse(parent.expiresAt) < Date.parse(c.expiresAt))
          ? parent.expiresAt
          : c.expiresAt;
      const next: KeyRecord = {
        ...c,
        status: parent.status === 'revoked' ? 'revoked' : c.status,
        credentials: parent.credentials,
        skus: parent.skus,
        allowedIps: parent.allowedIps,
        countries: parent.countries,
        pumping: parent.pumping,
        env: parent.env,
        loop: parent.loop,
        expiresAt,
      };
      await ctx.registry.putKeyByHash(child.tokenHash, next);
      await ctx.db
        .update(virtualKeys)
        .set({
          config: next,
          status: next.status,
          expiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
          ...(next.status === 'revoked' ? { revokedAt: ctx.now() } : {}),
        })
        .where(eq(virtualKeys.id, child.id));
    }
    return rows.length;
  }

  async function load(orgId: string, keyId: string): Promise<Row> {
    const [row] = await ctx.db
      .select()
      .from(virtualKeys)
      .where(and(eq(virtualKeys.id, keyId), eq(virtualKeys.orgId, orgId)))
      .limit(1);
    if (!row) throw notFound('Key');
    return row;
  }

  r.add({
    method: 'post',
    path: '/v1/keys',
    role: 'admin',
    tag: 'Keys',
    summary: 'Create a virtual key (the token is shown once)',
    status: 201,
    body: createBody,
    response: keyView.extend({ token: z.string() }),
    handler: async ({ auth, body }) => {
      await requireCapacity(ctx, auth.orgId, 'key');
      if (body.loop) await requireFeature(ctx, auth.orgId, 'customLoopRules');
      await checkCredentials(auth.orgId, body.credentials);
      const keyId = newId('key');
      const token = generateVirtualKey();
      const hash = hashVirtualKey(token);
      const rec = record(keyId, auth.orgId, body);
      // Valkey first: the proxy can use the key as soon as the API answers.
      await ctx.registry.putKeyByHash(hash, rec);
      const [row] = await ctx.db
        .insert(virtualKeys)
        .values({
          id: keyId,
          orgId: auth.orgId,
          name: body.name,
          tokenHash: hash,
          prefix: token.slice(0, 12),
          config: rec,
          createdAt: ctx.now(),
          expiresAt: rec.expiresAt ? new Date(rec.expiresAt) : null,
        })
        .returning();
      await audit(ctx, auth, 'key.create', keyId, { name: body.name });
      return { ...view(row!), token };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/keys',
    role: 'viewer',
    tag: 'Keys',
    summary: 'List virtual keys',
    response: z.object({ items: z.array(keyView) }),
    handler: async ({ auth }) => {
      const rows = await ctx.db.select().from(virtualKeys).where(eq(virtualKeys.orgId, auth.orgId));
      return { items: rows.map(view) };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/keys/{id}',
    role: 'viewer',
    tag: 'Keys',
    summary: 'Get a virtual key',
    params: z.object({ id }),
    response: keyView,
    handler: async ({ auth, params }) => view(await load(auth.orgId, params.id)),
  });

  r.add({
    method: 'patch',
    path: '/v1/keys/{id}',
    role: 'admin',
    tag: 'Keys',
    summary: 'Update a virtual key',
    params: z.object({ id }),
    body: patchBody,
    response: keyView,
    handler: async ({ auth, params, body }) => {
      const row = await load(auth.orgId, params.id);
      if (row.status !== 'active') throw new ApiError(409, 'conflict', 'Key is revoked.');
      if (body.loop) await requireFeature(ctx, auth.orgId, 'customLoopRules');
      if (body.credentials) await checkCredentials(auth.orgId, body.credentials);
      const rec = record(row.id, auth.orgId, body, row.config as KeyRecord);
      await ctx.registry.putKeyByHash(row.tokenHash, rec);
      const [updated] = await ctx.db
        .update(virtualKeys)
        .set({
          name: body.name ?? row.name,
          config: rec,
          expiresAt: rec.expiresAt ? new Date(rec.expiresAt) : null,
        })
        .where(and(eq(virtualKeys.id, row.id), eq(virtualKeys.orgId, auth.orgId)))
        .returning();
      const children = await syncChildren(row.id, rec);
      await audit(ctx, auth, 'key.update', row.id, { fields: Object.keys(body), children });
      return view(updated!);
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/keys/{id}',
    role: 'admin',
    tag: 'Keys',
    summary: 'Revoke a virtual key',
    params: z.object({ id }),
    response: keyView,
    handler: async ({ auth, params }) => {
      const row = await load(auth.orgId, params.id);
      const rec = { ...(row.config as KeyRecord), status: 'revoked' as const };
      await ctx.registry.putKeyByHash(row.tokenHash, rec);
      const [updated] = await ctx.db
        .update(virtualKeys)
        .set({ status: 'revoked', revokedAt: ctx.now(), config: rec })
        .where(and(eq(virtualKeys.id, row.id), eq(virtualKeys.orgId, auth.orgId)))
        .returning();
      const children = await syncChildren(row.id, rec);
      await audit(ctx, auth, 'key.revoke', row.id, { children });
      return view(updated!);
    },
  });
}
