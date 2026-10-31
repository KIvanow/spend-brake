import type { KeyRecord } from '@spend-brake/budget';
import { caps, eq, orgs, providerCredentials, virtualKeys } from '@spend-brake/db';
import type { Ctx } from './common.js';
import { toScope } from './common.js';
import { syncOrg } from './routes/admin.js';

export interface ResyncResult {
  orgs: number;
  keys: number;
  caps: number;
  credentials: number;
}

/**
 * Rewrite every record the proxy reads from Valkey using Postgres as the source of truth: org
 * settings, virtual keys (revoked ones as revoked), caps and live credential envelopes. Run at
 * API start, so a lost or partially written Valkey heals; it is idempotent.
 */
export async function resyncValkey(ctx: Ctx, orgId?: string): Promise<ResyncResult> {
  const result: ResyncResult = { orgs: 0, keys: 0, caps: 0, credentials: 0 };
  const orgRows = await ctx.db
    .select()
    .from(orgs)
    .where(orgId ? eq(orgs.id, orgId) : undefined);
  for (const org of orgRows) {
    await syncOrg(ctx, org.id, org.timeZone, org.settings as Record<string, unknown>);
    result.orgs++;

    for (const k of await ctx.db.select().from(virtualKeys).where(eq(virtualKeys.orgId, org.id))) {
      await ctx.registry.putKeyByHash(k.tokenHash, {
        ...(k.config as KeyRecord),
        name: k.name,
        status: k.status,
      });
      result.keys++;
    }

    for (const c of await ctx.db.select().from(caps).where(eq(caps.orgId, org.id))) {
      const current = await ctx.engine.getCap(org.id, toScope(c.scope), c.kind);
      if (current?.hard === c.hardMicros && current?.soft === c.softMicros) continue;
      await ctx.engine.setCap(org.id, toScope(c.scope), c.kind, {
        hard: c.hardMicros,
        soft: c.softMicros,
      });
      result.caps++;
    }

    const creds = await ctx.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.orgId, org.id));
    for (const c of creds) {
      if (c.revokedAt) {
        await ctx.registry.deleteCredential(org.id, c.id);
      } else {
        await ctx.registry.putCredential({
          id: c.id,
          orgId: org.id,
          provider: c.provider,
          envelope: c.envelope,
        });
        result.credentials++;
      }
    }
  }
  return result;
}
