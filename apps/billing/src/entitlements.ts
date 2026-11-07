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
  // One transaction (a savepoint inside the caller's), with the row locked: two changes at once
  // are audited in the order they happened, and never without their audit row.
  await db.transaction(async (tx) => {
    // An org without a row gets Free; an existing row (and its plan) is left as it is.
    await tx
      .insert(orgEntitlements)
      .values({ orgId, plan: 'free', status: 'active', ...LIMITS.free, updatedAt: now })
      .onConflictDoNothing({ target: orgEntitlements.orgId });
    const [current] = await tx
      .select({ licenseOrg: orgEntitlements.licenseOrg })
      .from(orgEntitlements)
      .where(eq(orgEntitlements.orgId, orgId))
      .for('update');
    if (current?.licenseOrg === licenseOrg) return;
    await tx
      .update(orgEntitlements)
      .set({ licenseOrg, updatedAt: now })
      .where(eq(orgEntitlements.orgId, orgId));
    await tx.insert(auditLog).values({
      orgId,
      actor,
      action: 'billing.license_org_set',
      target: `license_org:${licenseOrg}`,
      data: { from: current?.licenseOrg ?? null, to: licenseOrg },
      at: now,
    });
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
