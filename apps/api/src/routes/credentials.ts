import { providerCredentials } from '@spend-brake/db';
import { credentialContext, encryptSecret, providerName } from '@spend-brake/shared';
import { and, desc, eq, isNull, ne } from '@spend-brake/db';
import { z } from 'zod';
import { type Ctx, audit, id } from '../common.js';
import { newId } from '../ids.js';
import { ApiError, type Router, notFound } from '../route.js';
import { requireCapacity } from '../entitlements.js';
import { keysUsing, rebindKeys } from './keys.js';

const credential = z
  .object({
    id: z.string(),
    provider: z.string(),
    name: z.string(),
    hint: z.string().openapi({ description: 'Last 4 characters of the secret' }),
    createdAt: z.string(),
  })
  .openapi('ProviderCredential');

const keyCheck = z
  .object({
    apiRestricted: z.boolean().nullable(),
    ipRestricted: z.boolean().nullable(),
    valid: z.boolean().nullable(),
    warnings: z.array(z.string()),
  })
  .openapi('KeyCheck');

const view = (r: typeof providerCredentials.$inferSelect) => ({
  id: r.id,
  provider: r.provider,
  name: r.name,
  hint: r.hint,
  createdAt: r.createdAt.toISOString(),
});

export function credentialRoutes(r: Router, ctx: Ctx): void {
  r.add({
    method: 'post',
    path: '/v1/providers/credentials',
    role: 'admin',
    tag: 'Providers',
    summary: 'Add an encrypted provider key',
    status: 201,
    body: z.object({
      provider: id,
      name: z.string().min(1).max(200),
      secret: z.string().min(1).max(4096).openapi({ description: 'Never returned or logged' }),
    }),
    response: credential.extend({
      check: keyCheck.optional(),
      reboundKeys: z.array(z.string()).openapi({
        description:
          'Keys that were bound to a deleted credential of this provider and now use this one',
      }),
    }),
    handler: async ({ auth, body }) => {
      if (!ctx.wrapper) {
        throw new ApiError(503, 'no_master_key', 'Set BRAKE_MASTER_KEY or BRAKE_KMS_KEY_ID first.');
      }
      await requireCapacity(ctx, auth.orgId, { provider: body.provider });
      // Google keys: report whether the key is restricted (APIs and IPs), so the proxy is the
      // only path to spend. Restrictions are advice; a key Google says is invalid is refused.
      const check =
        body.provider === 'google-maps' && ctx.checkGoogleKey
          ? await ctx.checkGoogleKey(body.secret)
          : undefined;
      if (check?.valid === false) {
        throw new ApiError(
          400,
          'invalid_credential',
          'Google says this API key is not valid. Check it and add it again.',
        );
      }
      const credId = newId('cred');
      const envelope = await encryptSecret(
        ctx.wrapper,
        body.secret,
        credentialContext(auth.orgId, credId),
      );
      // Valkey first, like every enforcement record: a credential that lists in the API must
      // also be usable by the proxy.
      await ctx.registry.putCredential({
        id: credId,
        orgId: auth.orgId,
        provider: body.provider,
        envelope,
      });
      const [row] = await ctx.db
        .insert(providerCredentials)
        .values({
          id: credId,
          orgId: auth.orgId,
          provider: body.provider,
          name: body.name,
          envelope,
          hint: body.secret.slice(-4),
          createdAt: ctx.now(),
        })
        .returning();
      // Keys left pointing at a deleted credential of this provider (they get 502s) move to the
      // new one: adding a replacement is how people fix them.
      const live = await ctx.db
        .select({ id: providerCredentials.id })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.orgId, auth.orgId),
            eq(providerCredentials.provider, body.provider),
            isNull(providerCredentials.revokedAt),
          ),
        );
      const liveIds = new Set(live.map((c) => c.id));
      const rebound = await rebindKeys(
        ctx,
        auth.orgId,
        body.provider,
        (c) => !liveIds.has(c),
        credId,
      );
      await audit(ctx, auth, 'credential.create', credId, {
        provider: body.provider,
        name: body.name,
        ...(check ? { check } : {}),
        ...(rebound.length ? { reboundKeys: rebound.map((k) => k.id) } : {}),
      });
      return {
        ...view(row!),
        ...(check ? { check } : {}),
        reboundKeys: rebound.map((k) => k.id),
      };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/providers/credentials',
    role: 'viewer',
    tag: 'Providers',
    summary: 'List provider keys (no secrets)',
    response: z.object({ items: z.array(credential) }),
    handler: async ({ auth }) => {
      const rows = await ctx.db
        .select()
        .from(providerCredentials)
        .where(
          and(eq(providerCredentials.orgId, auth.orgId), isNull(providerCredentials.revokedAt)),
        );
      return { items: rows.map(view) };
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/providers/credentials/{id}',
    role: 'admin',
    tag: 'Providers',
    // Keys that use it move to the newest other key of the same provider; with none to move
    // them to, the delete is refused (409 credential_in_use).
    summary: 'Delete a provider key (keys that use it move to another key of the provider)',
    params: z.object({ id }),
    response: z.object({
      id: z.string(),
      deleted: z.literal(true),
      reboundKeys: z.array(z.string()).openapi({ description: 'Keys moved to another credential' }),
    }),
    handler: async ({ auth, params }) => {
      const owned = and(
        eq(providerCredentials.id, params.id),
        eq(providerCredentials.orgId, auth.orgId),
        isNull(providerCredentials.revokedAt),
      );
      const [existing] = await ctx.db.select().from(providerCredentials).where(owned).limit(1);
      if (!existing) throw notFound('Credential');
      // Keys that use it would get 502s from the proxy: move them first, or refuse.
      const users = await keysUsing(ctx, auth.orgId, existing.provider, existing.id);
      let rebound: { id: string; name: string }[] = [];
      if (users.length) {
        const [replacement] = await ctx.db
          .select({ id: providerCredentials.id })
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.orgId, auth.orgId),
              eq(providerCredentials.provider, existing.provider),
              ne(providerCredentials.id, existing.id),
              isNull(providerCredentials.revokedAt),
            ),
          )
          .orderBy(desc(providerCredentials.createdAt))
          .limit(1);
        if (!replacement) {
          const names = users.map((k) => `"${k.name}"`).join(', ');
          throw new ApiError(
            409,
            'credential_in_use',
            `Spend Brake key${users.length > 1 ? 's' : ''} ${names} use${users.length > 1 ? '' : 's'} this provider key. Add another ${providerName(existing.provider)} key first (the keys move to it), or revoke the keys.`,
          );
        }
        rebound = await rebindKeys(
          ctx,
          auth.orgId,
          existing.provider,
          (c) => c === existing.id,
          replacement.id,
        );
      }
      // Stop the proxy from using it before marking it deleted.
      await ctx.registry.deleteCredential(auth.orgId, existing.id);
      const [row] = await ctx.db
        .update(providerCredentials)
        .set({ revokedAt: ctx.now() })
        .where(
          and(
            eq(providerCredentials.id, params.id),
            eq(providerCredentials.orgId, auth.orgId),
            isNull(providerCredentials.revokedAt),
          ),
        )
        .returning();
      if (!row) throw notFound('Credential');
      await audit(
        ctx,
        auth,
        'credential.delete',
        row.id,
        rebound.length ? { reboundKeys: rebound.map((k) => k.id) } : {},
      );
      return { id: row.id, deleted: true as const, reboundKeys: rebound.map((k) => k.id) };
    },
  });
}
