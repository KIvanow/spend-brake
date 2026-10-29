import { providerCredentials } from '@spend-brake/db';
import { credentialContext, encryptSecret } from '@spend-brake/shared';
import { and, eq, isNull } from '@spend-brake/db';
import { z } from 'zod';
import { type Ctx, audit, id } from '../common.js';
import { newId } from '../ids.js';
import { ApiError, type Router, notFound } from '../route.js';

const credential = z
  .object({
    id: z.string(),
    provider: z.string(),
    name: z.string(),
    hint: z.string().openapi({ description: 'Last 4 characters of the secret' }),
    createdAt: z.string(),
  })
  .openapi('ProviderCredential');

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
    response: credential,
    handler: async ({ auth, body }) => {
      if (!ctx.wrapper) {
        throw new ApiError(503, 'no_master_key', 'Set BRAKE_MASTER_KEY or BRAKE_KMS_KEY_ID first.');
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
      await audit(ctx, auth, 'credential.create', credId, {
        provider: body.provider,
        name: body.name,
      });
      return view(row!);
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
    summary: 'Delete a provider key',
    params: z.object({ id }),
    response: z.object({ id: z.string(), deleted: z.literal(true) }),
    handler: async ({ auth, params }) => {
      const owned = and(
        eq(providerCredentials.id, params.id),
        eq(providerCredentials.orgId, auth.orgId),
        isNull(providerCredentials.revokedAt),
      );
      const [existing] = await ctx.db.select().from(providerCredentials).where(owned).limit(1);
      if (!existing) throw notFound('Credential');
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
      await audit(ctx, auth, 'credential.delete', row.id);
      return { id: row.id, deleted: true as const };
    },
  });
}
