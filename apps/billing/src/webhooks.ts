import { randomUUID } from 'node:crypto';
import { type Db, eq, issuedLicenses, orgEntitlements, orgs, stripeEvents } from '@spend-brake/db';
import { LICENSE_FEATURES, type LicensePayload, signLicense } from '@spend-brake/shared';
import type Stripe from 'stripe';
import { planOf, setPlan } from './entitlements.js';
import type { LICENSE_PLANS } from './plans.js';
import { DEFAULT_ORG_UNITS, PLAN_METADATA, type Plan, isPlan } from './plans.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type LicensePlan = (typeof LICENSE_PLANS)[number];

export interface LicenseMail {
  orgId: string;
  email: string | null;
  edition: LicensePlan;
  expiresAt: string;
  license: string;
  invoiceId: string;
}

export interface WebhookDeps {
  db: Db;
  /** Product lookups for invoice lines (plan and org units live in product metadata). */
  stripe: Pick<Stripe, 'products' | 'customers'>;
  /** Ed25519 private key (PEM) for license files; without it no license is issued. */
  licenseKey: string | null;
  now: () => Date;
  /** Called after the event's changes are committed, once per new license. */
  sendLicense: (mail: LicenseMail) => Promise<void>;
  log?: { warn(obj: object, msg: string): void };
}

export type Outcome = 'applied' | 'duplicate' | 'ignored';

const id = (v: string | { id: string } | null | undefined) =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : v.id;

/** The org a Stripe customer belongs to: our row, else the customer's metadata. */
async function orgForCustomer(
  tx: Tx,
  deps: WebhookDeps,
  customer: string | null,
  metadata?: Stripe.Metadata | null,
): Promise<string | null> {
  if (metadata?.orgId) return metadata.orgId;
  if (!customer) return null;
  const [row] = await tx
    .select({ orgId: orgEntitlements.orgId })
    .from(orgEntitlements)
    .where(eq(orgEntitlements.stripeCustomerId, customer))
    .limit(1);
  if (row) return row.orgId;
  const c = await deps.stripe.customers.retrieve(customer);
  return 'deleted' in c && c.deleted ? null : ((c as Stripe.Customer).metadata.orgId ?? null);
}

function planOfPrice(price: Stripe.Price): Plan | null {
  const fromMeta = price.metadata?.[PLAN_METADATA];
  if (isPlan(fromMeta)) return fromMeta;
  const m = /^spend_brake_([a-z]+)_monthly$/.exec(price.lookup_key ?? '');
  return m && isPlan(m[1]) ? m[1] : null;
}

/** What a subscription in this state entitles its org to. */
function subscriptionPlan(sub: Stripe.Subscription): { plan: Plan; status: 'active' | 'past_due' } {
  const item = sub.items.data[0];
  const plan = (item && planOfPrice(item.price)) ?? 'free';
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return { plan, status: 'active' };
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return { plan, status: 'past_due' };
    default:
      // canceled, incomplete_expired, paused: Stripe's dunning is over.
      return { plan: 'free', status: 'active' };
  }
}

/**
 * Apply one verified Stripe event. Each event id is applied once (Stripe retries and may send
 * an event twice): the id is recorded in the same transaction as its effects.
 */
export async function applyEvent(deps: WebhookDeps, event: Stripe.Event): Promise<Outcome> {
  const mails: LicenseMail[] = [];
  const outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
    const fresh = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type, processedAt: deps.now() })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (fresh.length === 0) return 'duplicate';
    switch (event.type) {
      case 'checkout.session.completed':
        return checkoutCompleted(tx, deps, event.data.object);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return subscriptionChanged(tx, deps, event.data.object);
      case 'customer.subscription.deleted':
        return subscriptionDeleted(tx, deps, event.data.object);
      case 'invoice.payment_failed':
        return paymentFailed(tx, deps, event.data.object);
      case 'invoice.paid':
        return invoicePaid(tx, deps, event.data.object, mails);
      default:
        return 'ignored';
    }
  });
  for (const m of mails) await deps.sendLicense(m);
  return outcome;
}

async function checkoutCompleted(tx: Tx, deps: WebhookDeps, s: Stripe.Checkout.Session) {
  const orgId = s.client_reference_id ?? s.metadata?.orgId ?? null;
  if (!orgId) return 'ignored';
  const current = await planOf(tx, orgId);
  // The plan itself comes with the subscription events; this links the Stripe ids early.
  await setPlan(
    tx,
    orgId,
    {
      plan: current?.plan ?? 'free',
      stripeCustomerId: id(s.customer),
      ...(s.subscription ? { stripeSubscriptionId: id(s.subscription) } : {}),
      ...(s.customer_details?.email && !current?.billingEmail
        ? { billingEmail: s.customer_details.email }
        : {}),
    },
    deps.now(),
  );
  return 'applied';
}

async function subscriptionChanged(tx: Tx, deps: WebhookDeps, sub: Stripe.Subscription) {
  const orgId = await orgForCustomer(tx, deps, id(sub.customer), sub.metadata);
  if (!orgId) return 'ignored';
  const { plan, status } = subscriptionPlan(sub);
  const end = sub.items.data[0]?.current_period_end;
  const ended = plan === 'free';
  await setPlan(
    tx,
    orgId,
    {
      plan,
      status,
      stripeCustomerId: id(sub.customer),
      stripeSubscriptionId: ended ? null : sub.id,
      currentPeriodEnd: ended || !end ? null : new Date(end * 1000),
    },
    deps.now(),
  );
  return 'applied';
}

async function subscriptionDeleted(tx: Tx, deps: WebhookDeps, sub: Stripe.Subscription) {
  const orgId = await orgForCustomer(tx, deps, id(sub.customer), sub.metadata);
  if (!orgId) return 'ignored';
  const current = await planOf(tx, orgId);
  // An older subscription ending (after a plan switch) does not touch the current one.
  if (current?.stripeSubscriptionId && current.stripeSubscriptionId !== sub.id) return 'ignored';
  await setPlan(
    tx,
    orgId,
    { plan: 'free', status: 'active', stripeSubscriptionId: null, currentPeriodEnd: null },
    deps.now(),
  );
  return 'applied';
}

async function paymentFailed(tx: Tx, deps: WebhookDeps, invoice: Stripe.Invoice) {
  const orgId = await orgForCustomer(tx, deps, id(invoice.customer));
  const current = orgId ? await planOf(tx, orgId) : null;
  if (!orgId || !current) return 'ignored';
  await setPlan(tx, orgId, { plan: current.plan, status: 'past_due' }, deps.now());
  return 'applied';
}

async function invoicePaid(
  tx: Tx,
  deps: WebhookDeps,
  invoice: Stripe.Invoice,
  mails: LicenseMail[],
) {
  const orgId = await orgForCustomer(tx, deps, id(invoice.customer));
  if (!orgId) return 'ignored';
  const [org] = await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) {
    deps.log?.warn({ orgId, invoice: invoice.id }, 'paid invoice for an unknown org');
    return 'ignored';
  }
  const current = await planOf(tx, orgId);
  if (current?.status === 'past_due') {
    await setPlan(tx, orgId, { plan: current.plan, status: 'active' }, deps.now());
  }

  // A license for each Business / Enterprise line, valid to the end of the period paid for.
  for (const line of invoice.lines.data) {
    const productId = line.pricing?.price_details?.product;
    if (!productId) continue;
    const product = await deps.stripe.products.retrieve(productId);
    const plan = product.metadata[PLAN_METADATA];
    if (plan !== 'business' && plan !== 'enterprise') continue;
    if (!deps.licenseKey) {
      deps.log?.warn(
        { orgId, invoice: invoice.id },
        'no BRAKE_LICENSE_SIGNING_KEY: license not issued',
      );
      continue;
    }
    const units = Number(product.metadata.org_units ?? DEFAULT_ORG_UNITS[plan]);
    const expiresAt = new Date(line.period.end * 1000).toISOString();
    const license: LicensePayload = {
      id: `lic_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      org: orgId,
      edition: plan,
      features: [...LICENSE_FEATURES],
      orgUnits: Number.isInteger(units) && units > 0 ? units : DEFAULT_ORG_UNITS[plan],
      issuedAt: deps.now().toISOString(),
      expiresAt,
    };
    const raw = signLicense(license, deps.licenseKey);
    const issued = await tx
      .insert(issuedLicenses)
      .values({
        id: license.id,
        orgId,
        edition: plan,
        invoiceId: `${invoice.id}:${line.id}`,
        raw,
        expiresAt: new Date(expiresAt),
        issuedAt: deps.now(),
      })
      .onConflictDoNothing()
      .returning({ id: issuedLicenses.id });
    if (issued.length) {
      mails.push({
        orgId,
        email: current?.billingEmail ?? invoice.customer_email ?? null,
        edition: plan,
        expiresAt,
        license: raw,
        invoiceId: invoice.id ?? '',
      });
    }
  }
  return 'applied';
}
