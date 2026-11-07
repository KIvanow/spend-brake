import { randomUUID } from 'node:crypto';
import { type Db, eq, issuedLicenses, orgEntitlements, orgs, stripeEvents } from '@spend-brake/db';
import {
  LICENSE_FEATURES,
  LICENSE_ORG,
  type LicensePayload,
  signLicense,
} from '@spend-brake/shared';
import type Stripe from 'stripe';
import { planOf, setLicenseOrg, setPlan } from './entitlements.js';
import {
  DEFAULT_ORG_UNITS,
  type LicensePlan,
  PLAN_METADATA,
  type Plan,
  isLicensePlan,
  isPlan,
} from './plans.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface LicenseMail {
  orgId: string;
  licenseId: string;
  /** The install's org id, which the license names. */
  licenseOrg: string;
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

/** The events applyEvent acts on (the webhook endpoint subscribes to exactly these). */
export { HANDLED_EVENTS } from './events.js';

const id = (v: string | { id: string } | null | undefined) =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : v.id;

/** A Stripe customer, or null once deleted. */
async function retrieveCustomer(deps: WebhookDeps, customer: string) {
  const c = await deps.stripe.customers.retrieve(customer);
  return 'deleted' in c && c.deleted ? null : (c as Stripe.Customer);
}

/**
 * The org a Stripe customer belongs to: our row, else the customer's metadata (the customer
 * fetched already, when the caller has it).
 */
async function orgForCustomer(
  tx: Tx,
  deps: WebhookDeps,
  customer: string | null,
  metadata?: Stripe.Metadata | null,
  fetched?: Stripe.Customer | null,
): Promise<string | null> {
  if (metadata?.orgId) return metadata.orgId;
  if (!customer) return null;
  const [row] = await tx
    .select({ orgId: orgEntitlements.orgId })
    .from(orgEntitlements)
    .where(eq(orgEntitlements.stripeCustomerId, customer))
    .limit(1);
  if (row) return row.orgId;
  const c = fetched !== undefined ? fetched : await retrieveCustomer(deps, customer);
  return c?.metadata.orgId ?? null;
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

/** A paid invoice whose license cannot be issued yet: the event is left for Stripe to retry. */
export class LicenseNotIssued extends Error {
  constructor(
    readonly orgId: string,
    reason: string,
  ) {
    super(`license not issued: ${reason}`);
  }
}

/**
 * Apply one verified Stripe event. Each event id is applied once (Stripe retries and may send
 * an event twice): the id is recorded in the same transaction as its effects.
 */
export async function applyEvent(deps: WebhookDeps, event: Stripe.Event): Promise<Outcome> {
  const [seen] = await deps.db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, event.id))
    .limit(1);
  if (seen) return 'duplicate';
  // A paid invoice's Stripe reads happen before the transaction, so it holds no locks while
  // Stripe answers; they only read, so a retry after a failure repeats them harmlessly.
  const reads = event.type === 'invoice.paid' ? await invoiceReads(deps, event.data.object) : null;
  const mails: LicenseMail[] = [];
  let outcome: Outcome;
  try {
    outcome = await applyInTransaction(deps, event, reads, mails);
  } catch (err) {
    // The payment still went through: a failed payment's hold is lifted now, while the license
    // waits for the retry.
    if (err instanceof LicenseNotIssued) await paidUp(deps.db, deps, err.orgId);
    throw err;
  }
  for (const m of mails) await deps.sendLicense(m);
  return outcome;
}

async function paidUp(db: Db, deps: WebhookDeps, orgId: string) {
  await db.transaction(async (tx) => {
    // Locked, so a payment failure committing meanwhile is not overwritten.
    const [current] = await tx
      .select({ plan: orgEntitlements.plan, status: orgEntitlements.status })
      .from(orgEntitlements)
      .where(eq(orgEntitlements.orgId, orgId))
      .for('update');
    if (current?.status === 'past_due') {
      await setPlan(tx, orgId, { plan: current.plan, status: 'active' }, deps.now());
    }
  });
}

function applyInTransaction(
  deps: WebhookDeps,
  event: Stripe.Event,
  reads: InvoiceReads | null,
  mails: LicenseMail[],
): Promise<Outcome> {
  return deps.db.transaction(async (tx): Promise<Outcome> => {
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
        return invoicePaid(tx, deps, event.data.object, reads!, mails);
      default:
        return 'ignored';
    }
  });
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

/** What a paid invoice needs from Stripe: its license lines' plans and products, the customer. */
interface InvoiceReads {
  lines: { line: Stripe.InvoiceLineItem; plan: LicensePlan; product: Stripe.Product }[];
  /** Fetched only when its metadata may be needed (undefined otherwise); null once deleted. */
  customer: Stripe.Customer | null | undefined;
}

async function invoiceReads(deps: WebhookDeps, invoice: Stripe.Invoice): Promise<InvoiceReads> {
  const lines: InvoiceReads['lines'] = [];
  for (const line of invoice.lines.data) {
    const productId = line.pricing?.price_details?.product;
    if (!productId) continue;
    const product = await deps.stripe.products.retrieve(productId);
    const plan = product.metadata[PLAN_METADATA];
    if (plan && isLicensePlan(plan)) lines.push({ line, plan, product });
  }
  // The customer, only when its metadata may be needed: for the org (no row of ours names the
  // customer) or for the install (no license_org stored, none on the subscription). A row read
  // here can only gain a license_org before the transaction, which then needs the customer less.
  const customer = id(invoice.customer);
  if (lines.length === 0 || !customer) return { lines, customer: undefined };
  const [row] = await deps.db
    .select({ licenseOrg: orgEntitlements.licenseOrg })
    .from(orgEntitlements)
    .where(eq(orgEntitlements.stripeCustomerId, customer))
    .limit(1);
  const named = row?.licenseOrg ?? invoice.parent?.subscription_details?.metadata?.license_org;
  return { lines, customer: row && named ? undefined : await retrieveCustomer(deps, customer) };
}

async function invoicePaid(
  tx: Tx,
  deps: WebhookDeps,
  invoice: Stripe.Invoice,
  reads: InvoiceReads,
  mails: LicenseMail[],
) {
  const orgId = await orgForCustomer(tx, deps, id(invoice.customer), null, reads.customer);
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
  if (reads.lines.length === 0) return 'applied';
  if (!deps.licenseKey) {
    // Paid for, so not recorded without its license: Stripe retries until a key is configured.
    deps.log?.warn(
      { orgId, invoice: invoice.id },
      'no BRAKE_LICENSE_SIGNING_KEY: license not issued, the event will be retried',
    );
    throw new LicenseNotIssued(orgId, 'no license signing key');
  }
  const licenseOrg = await licenseOrgFor(
    tx,
    deps,
    orgId,
    current?.licenseOrg ?? null,
    invoice,
    reads,
  );

  // A license for each Business / Enterprise line, valid to the end of the period paid for.
  for (const { line, plan, product } of reads.lines) {
    const units = Number(product.metadata.org_units ?? DEFAULT_ORG_UNITS[plan]);
    const expiresAt = new Date(line.period.end * 1000).toISOString();
    const license: LicensePayload = {
      id: `lic_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      org: licenseOrg,
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
        licenseOrg,
        expiresAt: new Date(expiresAt),
        issuedAt: deps.now(),
      })
      .onConflictDoNothing()
      .returning({ id: issuedLicenses.id });
    if (issued.length) {
      mails.push({
        orgId,
        licenseId: license.id,
        licenseOrg,
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

/**
 * The install a license names. The org's stored license_org wins: the buyer sets it (sign-up,
 * checkout, Billing, which also copies it to the Stripe customer), or this sets it once from
 * Stripe. Without one, the subscription's or customer's `license_org` metadata (hand-made
 * Enterprise invoices) is stored and used; without that, the hosted org's own id, as licenses
 * issued before license_org named. Metadata that is not a valid id issues nothing, rather than
 * a license for an id the buyer did not give: it throws, so the event is not recorded and Stripe
 * retries it, and the retry after the id is fixed (under Billing, or in the customer's metadata)
 * issues the license for the period paid.
 */
async function licenseOrgFor(
  tx: Tx,
  deps: WebhookDeps,
  orgId: string,
  stored: string | null,
  invoice: Stripe.Invoice,
  reads: InvoiceReads,
): Promise<string> {
  if (stored) return stored;
  const fromStripe =
    invoice.parent?.subscription_details?.metadata?.license_org ??
    reads.customer?.metadata?.license_org;
  if (!fromStripe) return orgId;
  if (!LICENSE_ORG.test(fromStripe)) {
    // Not recorded as applied: the period is paid for, so Stripe retries the event, and once the
    // id is fixed (under Billing, or in the customer's metadata) the retry issues the license.
    deps.log?.warn(
      { orgId, invoice: invoice.id, licenseOrg: fromStripe },
      'license_org metadata is not a valid org id: license not issued, the event will be retried',
    );
    throw new LicenseNotIssued(
      orgId,
      `license_org ${JSON.stringify(fromStripe)} is not a valid org id`,
    );
  }
  // Under the row lock: an id the owner saved meanwhile wins over the metadata.
  return setLicenseOrg(tx, orgId, fromStripe, 'system', deps.now(), { onlyIfUnset: true });
}
