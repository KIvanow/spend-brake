import { ApiError, type Router, audit } from '@spend-brake/api';
import type { Ctx } from '@spend-brake/api';
import { z } from 'zod';
import type { Entitlements } from '../entitlements.js';
import { FEATURES, LicenseError, verifyLicense } from '../license/license.js';
import { eeLicenses } from '../schema.js';

const view = z
  .object({
    status: z.enum(['missing', 'active', 'grace', 'expired']),
    readOnlyAt: z.string().nullable(),
    license: z
      .object({
        id: z.string(),
        org: z.string(),
        edition: z.enum(['business', 'enterprise']),
        features: z.array(z.enum(FEATURES)),
        orgUnits: z.number(),
        issuedAt: z.string(),
        expiresAt: z.string(),
      })
      .nullable(),
  })
  .openapi('License');

export function licenseRoutes(r: Router, ctx: Ctx, ent: Entitlements): void {
  r.add({
    method: 'get',
    path: '/v1/license',
    role: 'viewer',
    tag: 'License',
    summary: 'License status (verified offline; no license means core features only)',
    response: view,
    handler: async () => ent.state(),
  });

  r.add({
    method: 'post',
    path: '/v1/license',
    role: 'owner',
    tag: 'License',
    summary: "Install a license file (owner of the license's org)",
    status: 201,
    body: z.object({ license: z.string().min(1).max(16_384) }),
    response: view,
    handler: async ({ auth, body }) => {
      let license;
      try {
        license = verifyLicense(body.license, ent.publicKey);
      } catch (err) {
        if (err instanceof LicenseError) {
          throw new ApiError(400, `license_${err.code}`, `License rejected: ${err.message}`);
        }
        throw err;
      }
      if (license.org !== auth.orgId) {
        throw new ApiError(403, 'license_wrong_org', `This license belongs to org ${license.org}.`);
      }
      if (Date.parse(license.expiresAt) <= ctx.now().getTime()) {
        throw new ApiError(400, 'license_expired', 'This license has already expired.');
      }
      const row = {
        id: license.id,
        orgId: license.org,
        raw: body.license,
        expiresAt: new Date(license.expiresAt),
        installedBy: auth.actor,
        installedAt: ctx.now(),
      };
      await ctx.db
        .insert(eeLicenses)
        .values(row)
        .onConflictDoUpdate({ target: eeLicenses.id, set: row });
      ent.forget();
      await audit(ctx, auth, 'license.install', license.id, {
        edition: license.edition,
        features: license.features,
        expiresAt: license.expiresAt,
      });
      return ent.state();
    },
  });
}
