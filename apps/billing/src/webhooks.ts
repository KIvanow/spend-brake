import { randomUUID } from 'node:crypto';
import {
  type Db,
  and,
  desc,
  eq,
  issuedLicenses,
  lte,
  orgEntitlements,
  orgs,
  stripeEvents,
} from '@spend-brake/db';
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
  log?: { warn(obj: object, msg: string): void; error?(obj: object, msg: string): void };
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
    if (err instanceof LicenseNotIssued && event.type === 'invoice.paid') {
      await liftHold(deps.db, err.orgId, event.data.object, deps.now());
    }
    throw err;
  }
  // Every license is emailed, each on its own: the event is recorded, so a retry would send
  // nothing, and a failed one is logged for support (the dashboard has the latest license).
  const sent = await Promise.allSettled(mails.map((m) => deps.sendLicense(m)));
  sent.forEach((r, i) => {
    if (r.status === 'rejected') {
      deps.log?.error?.(
        { orgId: mails[i]!.orgId, license: mails[i]!.licenseId, err: String(r.reason) },
        'license email not queued: send the license to the customer by hand',
      );
    }
  });
  return outcome;
}

/**
 * Lift a failed payment's hold once an invoice is paid: the status alone, in one statement, so
 * the org's limits are kept. Only a hold set before the payment: a retry of an old paid invoice
 * does not lift a hold a newer failure set since.
 */
async function liftHold(db: Db | Tx, orgId: string, invoice: Stripe.Invoice, now: Date) {
  const paidAt = invoice.status_transitions?.paid_at;
  await db
    .update(orgEntitlements)
    .set({ status: 'active', updatedAt: now })
    .where(
      and(
        eq(orgEntitlements.orgId, orgId),
        eq(orgEntitlements.status, 'past_due'),
        ...(paidAt ? [lte(orgEntitlements.updatedAt, new Date(paidAt * 1000))] : []),
      ),
    );
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
  /** Fetched for invoices with license lines (undefined otherwise); null once deleted. */
  customer: Stripe.Customer | null | undefined;
}

async function invoiceReads(deps: WebhookDeps, invoice: Stripe.Invoice): Promise<InvoiceReads> {
  const lines: InvoiceReads['lines'] = [];
  const products = await Promise.all(
    invoice.lines.data.map((line) => {
      const productId = line.pricing?.price_details?.product;
      return productId ? deps.stripe.products.retrieve(productId) : Promise.resolve(null);
    }),
  );
  invoice.lines.data.forEach((line, i) => {
    const product = products[i];
    const plan = product?.metadata[PLAN_METADATA];
    if (product && plan && isLicensePlan(plan)) lines.push({ line, plan, product });
  });
  // The customer, for an invoice with license lines: its metadata may name the org (no row of
  // ours names the customer) or the install (license_org).
  const customer = id(invoice.customer);
  if (lines.length === 0 || !customer) return { lines, customer: undefined };
  return { lines, customer: await retrieveCustomer(deps, customer) };
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
  if (current?.status === 'past_due') await liftHold(tx, orgId, invoice, deps.now());
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
 * Enterprise invoices) is stored and used; without that, the id the org's last license named
 * (licenses issued before license_org named the hosted org). With none of these, or metadata
 * that is not a valid id, nothing is issued rather than a license the buyer's install refuses:
 * it throws, so the event is not recorded and Stripe retries it, and the retry after the id is
 * set (under Billing, or in the customer's metadata) issues the license for the period paid.
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
  // Typed by hand in the Stripe Dashboard: surrounding spaces are not part of the id.
  const fromStripe = (
    invoice.parent?.subscription_details?.metadata?.license_org ??
    reads.customer?.metadata?.license_org
  )?.trim();
  if (!fromStripe) {
    // Renewals of licenses issued before license_org keep naming the id they named.
    const [last] = await tx
      .select({ licenseOrg: issuedLicenses.licenseOrg })
      .from(issuedLicenses)
      .where(eq(issuedLicenses.orgId, orgId))
      .orderBy(desc(issuedLicenses.issuedAt))
      .limit(1);
    if (last?.licenseOrg) return last.licenseOrg;
    // A first license needs the install it is for: a license for the hosted org's id would be
    // refused by the buyer's install. Not recorded, so Stripe retries once the id is set.
    deps.log?.warn(
      { orgId, invoice: invoice.id },
      'no license_org for a first license: license not issued, the event will be retried',
    );
    throw new LicenseNotIssued(orgId, 'no license_org: set the org id of the install');
  }
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
