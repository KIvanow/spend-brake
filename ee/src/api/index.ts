import type { ApiExtension } from '@spend-brake/api';
import type { ValkeyClient as Redis } from '@spend-brake/budget';
import { eq } from '@spend-brake/db';
import { eeSsoConfigs } from '../schema.js';
import type { Entitlements } from '../entitlements.js';
import { type SsoOptions, ssoRoutes } from '../sso/sso.js';
import { approvalRoutes, holdCapRaise } from './approvals.js';
import { auditRoutes } from './audit.js';
import { licenseRoutes } from './license.js';
import { orgRoutes } from './orgs.js';
import { reconciliationRoutes } from './reconciliation.js';
import { authorizeEeRoles, roleRoutes } from './roles.js';

export interface EeApiOptions {
  entitlements: Entitlements;
  valkey: Redis;
  /** Single sign-on needs the API's public URL and the dashboard's; off without them. */
  sso?: SsoOptions;
}

/** Everything ee/ adds to the admin API. Each feature checks the license on every call. */
export function eeApi(opts: EeApiOptions): ApiExtension {
  const ent = opts.entitlements;
  return ({ app, router, ctx }) => {
    ctx.hooks.authorize = authorizeEeRoles(ctx, ent);
    ctx.hooks.holdCapRaise = holdCapRaise(ctx, ent);
    // With single sign-on configured, the IdP decides who gets in: no email sign-in links.
    ctx.hooks.emailSignInAllowed = async (orgId) =>
      (
        await ctx.db
          .select({ orgId: eeSsoConfigs.orgId })
          .from(eeSsoConfigs)
          .where(eq(eeSsoConfigs.orgId, orgId))
          .limit(1)
      ).length === 0;
    licenseRoutes(router, ctx, ent);
    roleRoutes(router, ctx, ent);
    approvalRoutes(router, ctx, ent);
    orgRoutes(router, ctx, ent);
    auditRoutes(router, ctx, ent);
    reconciliationRoutes(router, ctx, ent);
    if (opts.sso) ssoRoutes(app, router, ctx, ent, opts.valkey, opts.sso);
  };
}
