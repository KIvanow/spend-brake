// Create (once) the products, prices and Customer Portal configuration in Stripe, test or live.
// Safe to run again: everything is found by its lookup key or metadata first, and what has
// drifted from src/plans.ts is brought back in line (see seedStripe).
//   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @spend-brake/billing seed
//   STRIPE_SECRET_KEY=rk_live_... BRAKE_STRIPE_ALLOW_LIVE=1 pnpm --filter @spend-brake/billing seed
import type Stripe from 'stripe';
import {
  CHECKOUT_PLANS,
  HOSTED_PLANS,
  MONTHLY_CENTS,
  PLAN_METADATA,
  PLAN_NAMES,
  PORTAL_METADATA,
  type CheckoutPlan,
  lookupKey,
} from './plans.js';
import { dashboardFromEnv, stripeFromEnv } from './stripe.js';

export const PRIVACY_URL = 'https://spendbrake.dev/privacy';
export const TERMS_URL = 'https://spendbrake.dev/terms';

export interface SeedOptions {
  /** The dashboard: the portal's default return URL is its billing page. */
  dashboardUrl: string;
}

export interface SeedResult {
  products: Record<string, string>;
  prices: Record<string, string>;
  portalConfiguration: string;
  created: string[];
  updated: string[];
}

async function findProduct(stripe: Stripe, plan: string): Promise<Stripe.Product | null> {
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    if (p.metadata[PLAN_METADATA] === plan) return p;
  }
  return null;
}

const idOf = (v: string | { id: string }) => (typeof v === 'string' ? v : v.id);

/**
 * The plan's monthly price. A price's amount, currency and interval never change, so one that
 * differs from src/plans.ts is replaced: a new price takes over the lookup key (which Checkout
 * and the portal use) and the old one is archived. Subscriptions already on the old price keep
 * it until the customer changes plan.
 */
async function ensurePrice(
  stripe: Stripe,
  plan: CheckoutPlan,
  product: string,
  result: SeedResult,
): Promise<string> {
  const key = lookupKey(plan);
  const [existing] = (await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 }))
    .data;
  const same =
    existing &&
    idOf(existing.product) === product &&
    existing.currency === 'usd' &&
    existing.unit_amount === MONTHLY_CENTS[plan] &&
    existing.recurring?.interval === 'month' &&
    (existing.recurring.interval_count ?? 1) === 1;
  if (existing && same) return existing.id;
  const price = await stripe.prices.create({
    product,
    currency: 'usd',
    unit_amount: MONTHLY_CENTS[plan],
    recurring: { interval: 'month' },
    lookup_key: key,
    transfer_lookup_key: Boolean(existing),
    metadata: { [PLAN_METADATA]: plan },
  });
  result.created.push(`price ${key}`);
  if (existing) {
    await stripe.prices.update(existing.id, { active: false });
    result.updated.push(`price ${existing.id}: archived, replaced by ${price.id}`);
  }
  return price.id;
}

/** The Customer Portal: what a paying customer can do on their own. */
function portalParams(
  result: SeedResult,
  opts: SeedOptions,
): Stripe.BillingPortal.ConfigurationCreateParams {
  return {
    metadata: { [PORTAL_METADATA]: '1' },
    business_profile: { privacy_policy_url: PRIVACY_URL, terms_of_service_url: TERMS_URL },
    default_return_url: `${opts.dashboardUrl.replace(/\/$/, '')}/#/billing`,
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: ['email', 'name', 'address', 'tax_id'],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      // Switching between the hosted plans; a license is bought and cancelled on its own.
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: HOSTED_PLANS.map((p) => ({
          product: result.products[p]!,
          prices: [result.prices[p]!],
        })),
      },
    },
  };
}

/**
 * Products for every plan sold (Enterprise has a product but no price), the monthly prices and
 * the portal configuration. Running it again creates nothing; the portal configuration is
 * rewritten each time so it always lists the current prices.
 */
export async function seedStripe(stripe: Stripe, opts: SeedOptions): Promise<SeedResult> {
  const result: SeedResult = {
    products: {},
    prices: {},
    portalConfiguration: '',
    created: [],
    updated: [],
  };
  for (const plan of [...CHECKOUT_PLANS, 'enterprise'] as const) {
    let product = await findProduct(stripe, plan);
    if (!product) {
      product = await stripe.products.create({
        name: `Spend Brake ${PLAN_NAMES[plan]}`,
        metadata: { [PLAN_METADATA]: plan },
      });
      result.created.push(`product ${plan}`);
    }
    result.products[plan] = product.id;
    // Enterprise has no list price: it is invoiced by hand (Stripe Invoicing) on this product.
    if (plan === 'enterprise') continue;
    result.prices[plan] = await ensurePrice(stripe, plan, product.id, result);
  }

  const params = portalParams(result, opts);
  const configs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const portal = configs.data.find((c) => c.metadata?.[PORTAL_METADATA] === '1');
  if (portal) {
    await stripe.billingPortal.configurations.update(portal.id, params);
    result.updated.push(`portal configuration ${portal.id}`);
    result.portalConfiguration = portal.id;
  } else {
    result.portalConfiguration = (await stripe.billingPortal.configurations.create(params)).id;
    result.created.push('portal configuration');
  }
  return result;
}

/** What the operator reads after a run. */
export function seedReport(r: SeedResult, live: boolean): string {
  const lines = [
    `Stripe ${live ? 'LIVE' : 'test'} mode`,
    '',
    'Products:',
    ...Object.entries(r.products).map(([plan, id]) => `  ${plan.padEnd(10)} ${id}`),
    'Prices (monthly, USD):',
    ...Object.entries(r.prices).map(
      ([plan, id]) => `  ${lookupKey(plan as CheckoutPlan).padEnd(30)} ${id}`,
    ),
    `Portal configuration: ${r.portalConfiguration}`,
    '',
    `Created: ${r.created.length ? r.created.join(', ') : 'nothing'}`,
    `Updated: ${r.updated.length ? r.updated.join(', ') : 'nothing'}`,
    '',
    'Nothing to copy into infra/.env from this: billing finds the prices by lookup key and the',
    `portal configuration by its metadata (${PORTAL_METADATA}=1). Next: webhook-setup, for`,
    'STRIPE_WEBHOOK_SECRET.',
  ];
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // A live key only with BRAKE_STRIPE_ALLOW_LIVE=1.
  const { stripe, live } = stripeFromEnv();
  const r = await seedStripe(stripe, { dashboardUrl: dashboardFromEnv() });
  process.stdout.write(seedReport(r, live));
}
