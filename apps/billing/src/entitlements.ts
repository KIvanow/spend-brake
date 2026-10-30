import { type Db, eq, orgEntitlements } from '@spend-brake/db';
import { LIMITS, type Plan } from './plans.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface PlanChange {
  plan: Plan;
  status?: 'active' | 'past_due';
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  billingEmail?: string | null;
}

/** Write an org's plan and the limits that come with it. */
export async function setPlan(db: Db | Tx, orgId: string, change: PlanChange, now: Date) {
  const values = {
    plan: change.plan,
    ...LIMITS[change.plan],
    ...(change.status ? { status: change.status } : {}),
    ...(change.stripeCustomerId !== undefined ? { stripeCustomerId: change.stripeCustomerId } : {}),
    ...(change.stripeSubscriptionId !== undefined
      ? { stripeSubscriptionId: change.stripeSubscriptionId }
      : {}),
    ...(change.currentPeriodEnd !== undefined ? { currentPeriodEnd: change.currentPeriodEnd } : {}),
    ...(change.billingEmail !== undefined ? { billingEmail: change.billingEmail } : {}),
    updatedAt: now,
  };
  await db
    .insert(orgEntitlements)
    .values({ orgId, status: 'active', ...values })
    .onConflictDoUpdate({ target: orgEntitlements.orgId, set: values });
}

export async function planOf(db: Db | Tx, orgId: string) {
  const [row] = await db
    .select()
    .from(orgEntitlements)
    .where(eq(orgEntitlements.orgId, orgId))
    .limit(1);
  return row ?? null;
}
