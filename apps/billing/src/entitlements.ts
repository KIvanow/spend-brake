import { type Db, auditLog, eq, orgEntitlements } from '@spend-brake/db';
import { LIMITS, type Plan } from './plans.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface PlanChange {
  plan: Plan;
  status?: 'active' | 'past_due';
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  billingEmail?: string | null;
  licenseOrg?: string | null;
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
    ...(change.licenseOrg !== undefined ? { licenseOrg: change.licenseOrg } : {}),
    updatedAt: now,
  };
  await db
    .insert(orgEntitlements)
    .values({ orgId, status: 'active', ...values })
    .onConflictDoUpdate({ target: orgEntitlements.orgId, set: values });
}

/**
 * Change the install org id that an org's licenses name, and audit it: licenses already issued
 * keep naming the old id until they expire. Only that column changes; the plan and its limits
 * stay as they are.
 */
export async function setLicenseOrg(
  db: Db | Tx,
  orgId: string,
  licenseOrg: string,
  actor: string,
  now: Date,
) {
  const current = await planOf(db, orgId);
  if (current?.licenseOrg === licenseOrg) return;
  if (current) {
    await db
      .update(orgEntitlements)
      .set({ licenseOrg, updatedAt: now })
      .where(eq(orgEntitlements.orgId, orgId));
  } else {
    await setPlan(db, orgId, { plan: 'free', licenseOrg }, now);
  }
  await db.insert(auditLog).values({
    orgId,
    actor,
    action: 'billing.license_org_set',
    target: `license_org:${licenseOrg}`,
    data: { from: current?.licenseOrg ?? null, to: licenseOrg },
    at: now,
  });
}

export async function planOf(db: Db | Tx, orgId: string) {
  const [row] = await db
    .select()
    .from(orgEntitlements)
    .where(eq(orgEntitlements.orgId, orgId))
    .limit(1);
  return row ?? null;
}
