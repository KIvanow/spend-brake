import {
  and,
  eq,
  gte,
  isNull,
  orgEntitlements,
  providerCredentials,
  sql,
  usageEvents,
  virtualKeys,
} from '@spend-brake/db';
import type { Ctx } from './common.js';
import { ApiError } from './route.js';

// Hosted plan limits. They apply only to orgs with an org_entitlements row (written by the
// billing service); a self-hosted install has none and is never limited. Limits only stop new
// keys, providers and sessions: existing keys and caps keep working whatever the plan or
// payment state, and the proxy never reads any of this.

export type Entitlements = typeof orgEntitlements.$inferSelect;

export async function entitlementsOf(ctx: Ctx, orgId: string): Promise<Entitlements | null> {
  const [row] = await ctx.db
    .select()
    .from(orgEntitlements)
    .where(eq(orgEntitlements.orgId, orgId))
    .limit(1);
  return row ?? null;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

function limit(e: Entitlements, what: string, max: number): never {
  throw new ApiError(
    402,
    'plan_limit',
    `The ${e.plan} plan allows ${max.toLocaleString('en-US')} ${what}. Upgrade the plan to add more.`,
  );
}

async function requestsThisMonth(ctx: Ctx, orgId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<string>`count(*)::text` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        eq(usageEvents.type, 'usage'),
        gte(usageEvents.ts, monthStart(ctx.now())),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Before creating something billable: a failed payment, or a plan already used up (resources
 * or this month's proxied requests), refuses it with 402.
 */
export async function requireCapacity(
  ctx: Ctx,
  orgId: string,
  what: 'key' | 'session' | { provider: string },
): Promise<void> {
  const e = await entitlementsOf(ctx, orgId);
  if (!e) return;
  if (e.status === 'past_due') {
    throw new ApiError(
      402,
      'payment_required',
      'A payment failed: new keys, providers and sessions wait until it goes through. Existing keys and caps keep working.',
    );
  }
  if (e.requestsPerMonth !== null && (await requestsThisMonth(ctx, orgId)) >= e.requestsPerMonth) {
    limit(e, 'proxied requests a month', e.requestsPerMonth);
  }
  if (what === 'key' && e.maxKeys !== null) {
    const [row] = await ctx.db
      .select({ n: sql<string>`count(*)::text` })
      .from(virtualKeys)
      .where(
        and(
          eq(virtualKeys.orgId, orgId),
          eq(virtualKeys.status, 'active'),
          sql`${virtualKeys.config}->>'sessionId' is null`,
        ),
      );
    if (Number(row?.n ?? 0) >= e.maxKeys) limit(e, 'keys', e.maxKeys);
  }
  if (what === 'session' && e.agentSessionsPerMonth !== null) {
    const [row] = await ctx.db
      .select({ n: sql<string>`count(*)::text` })
      .from(virtualKeys)
      .where(
        and(
          eq(virtualKeys.orgId, orgId),
          gte(virtualKeys.createdAt, monthStart(ctx.now())),
          sql`${virtualKeys.config}->>'sessionId' is not null`,
        ),
      );
    if (Number(row?.n ?? 0) >= e.agentSessionsPerMonth) {
      limit(e, 'agent sessions a month', e.agentSessionsPerMonth);
    }
  }
  if (typeof what === 'object' && e.maxProviders !== null) {
    const rows = await ctx.db
      .selectDistinct({ provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.orgId, orgId), isNull(providerCredentials.revokedAt)));
    const providers = new Set(rows.map((r) => r.provider));
    if (!providers.has(what.provider) && providers.size >= e.maxProviders) {
      limit(e, 'providers', e.maxProviders);
    }
  }
}

/** Features some plans leave out. */
export async function requireFeature(
  ctx: Ctx,
  orgId: string,
  feature: 'sessionAnalytics' | 'customLoopRules',
): Promise<void> {
  const e = await entitlementsOf(ctx, orgId);
  if (!e || e[feature]) return;
  const name = feature === 'sessionAnalytics' ? 'Session analytics' : 'Custom loop rules';
  throw new ApiError(402, 'plan_feature', `${name} come with the Agents plan.`);
}

/** The Free plan protects a limited monthly spend: the org's monthly hard cap stays below it. */
export async function requireOrgCapWithinPlan(
  ctx: Ctx,
  orgId: string,
  hard: bigint | null,
): Promise<void> {
  const e = await entitlementsOf(ctx, orgId);
  if (!e || e.maxOrgMonthCapMicros === null) return;
  if (hard === null || hard > e.maxOrgMonthCapMicros) {
    const usd = Number(e.maxOrgMonthCapMicros) / 1_000_000;
    throw new ApiError(
      402,
      'plan_limit',
      `The ${e.plan} plan protects up to $${usd} a month: set the org's monthly cap at or below it.`,
    );
  }
}
