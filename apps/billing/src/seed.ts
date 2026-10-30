// Create (once) the products, prices and Customer Portal configuration in Stripe test mode.
// Safe to run again: everything is found by its lookup key or metadata first.
//   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @spend-brake/billing seed
import type Stripe from 'stripe';
import {
  CHECKOUT_PLANS,
  HOSTED_PLANS,
  MONTHLY_CENTS,
  PLAN_METADATA,
  PLAN_NAMES,
  lookupKey,
} from './plans.js';
import { stripeClient } from './stripe.js';

const PORTAL_METADATA = 'spend_brake_portal';

export interface SeedResult {
  products: Record<string, string>;
  prices: Record<string, string>;
  portalConfiguration: string;
  created: string[];
}

async function findProduct(stripe: Stripe, plan: string): Promise<Stripe.Product | null> {
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    if (p.metadata[PLAN_METADATA] === plan) return p;
  }
  return null;
}

export async function seedStripe(stripe: Stripe): Promise<SeedResult> {
  const result: SeedResult = { products: {}, prices: {}, portalConfiguration: '', created: [] };
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
    const key = lookupKey(plan);
    const [existing] = (await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 }))
      .data;
    const price =
      existing ??
      (await stripe.prices.create({
        product: product.id,
        currency: 'usd',
        unit_amount: MONTHLY_CENTS[plan],
        recurring: { interval: 'month' },
        lookup_key: key,
        metadata: { [PLAN_METADATA]: plan },
      }));
    if (!existing) result.created.push(`price ${key}`);
    result.prices[plan] = price.id;
  }

  const configs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  let portal = configs.data.find((c) => c.metadata?.[PORTAL_METADATA] === '1');
  if (!portal) {
    portal = await stripe.billingPortal.configurations.create({
      metadata: { [PORTAL_METADATA]: '1' },
      features: {
        customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
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
    });
    result.created.push('portal configuration');
  }
  result.portalConfiguration = portal.id;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Set STRIPE_SECRET_KEY (test mode).');
  // Live mode only when asked for in so many words: BRAKE_STRIPE_ALLOW_LIVE=true.
  const r = await seedStripe(
    stripeClient(key, { allowLive: process.env.BRAKE_STRIPE_ALLOW_LIVE === 'true' }),
  );
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
}
