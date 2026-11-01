// The Stripe setup scripts against an in-memory fake: no network, no real key.
import { readFileSync } from 'node:fs';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, TERMS_URL, seedReport, seedStripe } from '../src/seed.js';
import { stripeFromEnv } from '../src/stripe.js';
import { API_VERSION, setupWebhook, webhookReport, webhookUrl } from '../src/webhook-setup.js';
import { HANDLED_EVENTS } from '../src/webhooks.js';

type Params = Record<string, unknown>;

function fakeStripe() {
  const store = {
    products: [] as Stripe.Product[],
    prices: [] as Stripe.Price[],
    portals: [] as (Params & { id: string })[],
  };
  const stripe = {
    products: {
      list: () => ({ [Symbol.asyncIterator]: () => store.products[Symbol.iterator]() }),
      create: (p: Stripe.ProductCreateParams) => {
        const product = { id: `prod_${store.products.length}`, ...p } as Stripe.Product;
        store.products.push(product);
        return Promise.resolve(product);
      },
    },
    prices: {
      list: (p: { lookup_keys: string[]; active?: boolean }) =>
        Promise.resolve({
          data: store.prices.filter(
            (x) => p.lookup_keys.includes(x.lookup_key!) && (p.active === undefined || x.active),
          ),
        }),
      create: (p: Stripe.PriceCreateParams) => {
        if (p.lookup_key && store.prices.some((x) => x.lookup_key === p.lookup_key)) {
          if (!p.transfer_lookup_key) throw new Error('lookup key in use');
          for (const x of store.prices) if (x.lookup_key === p.lookup_key) x.lookup_key = null;
        }
        const rest: Params = { ...p };
        delete rest.transfer_lookup_key;
        const price = {
          id: `price_${store.prices.length}`,
          active: true,
          tax_behavior: 'unspecified',
          ...rest,
          recurring: { interval_count: 1, ...p.recurring },
        } as unknown as Stripe.Price;
        store.prices.push(price);
        return Promise.resolve(price);
      },
      update: (id: string, p: Stripe.PriceUpdateParams) => {
        const price = store.prices.find((x) => x.id === id)!;
        if (p.tax_behavior) {
          if (price.tax_behavior !== 'unspecified') throw new Error('tax_behavior is set');
          price.tax_behavior = p.tax_behavior;
        }
        if (p.active !== undefined) price.active = p.active;
        return Promise.resolve(price);
      },
    },
    billingPortal: {
      configurations: {
        list: () => Promise.resolve({ data: store.portals }),
        create: (p: Params) => {
          const c = { id: `bpc_${store.portals.length}`, ...p };
          store.portals.push(c);
          return Promise.resolve(c);
        },
        update: (id: string, p: Params) => {
          const c = store.portals.find((x) => x.id === id)!;
          Object.assign(c, p);
          return Promise.resolve(c);
        },
      },
    },
  };
  return { store, stripe: stripe as unknown as Stripe };
}

const opts = { dashboardUrl: 'https://app.spendbrake.dev/' };

describe('seed', () => {
  it('creates products, prices and the portal once', async () => {
    const { store, stripe } = fakeStripe();
    const first = await seedStripe(stripe, opts);
    expect(first.created).toHaveLength(10); // 5 products, 4 prices, the portal
    expect(
      store.prices.map((p) => [p.lookup_key, p.unit_amount, p.currency, p.recurring?.interval]),
    ).toEqual([
      ['spend_brake_indie_monthly', 900, 'usd', 'month'],
      ['spend_brake_team_monthly', 4900, 'usd', 'month'],
      ['spend_brake_agents_monthly', 14900, 'usd', 'month'],
      ['spend_brake_business_monthly', 29900, 'usd', 'month'],
    ]);
    expect(store.portals).toHaveLength(1);
    expect(store.portals[0]).toMatchObject({
      metadata: { spend_brake_portal: '1' },
      business_profile: { privacy_policy_url: PRIVACY_URL, terms_of_service_url: TERMS_URL },
      default_return_url: 'https://app.spendbrake.dev/#/billing',
      features: {
        customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address', 'tax_id'] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price'],
          // Switches between the hosted plans only; the Business license is not one of them.
          products: ['indie', 'team', 'agents'].map((p) => ({
            product: first.products[p],
            prices: [first.prices[p]],
          })),
        },
      },
    });

    const second = await seedStripe(stripe, opts);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([`portal configuration ${first.portalConfiguration}`]);
    expect(second.prices).toEqual(first.prices);
    expect(second.portalConfiguration).toBe(first.portalConfiguration);
    expect(store.portals).toHaveLength(1);
    expect(seedReport(second, true)).toMatch(/LIVE[\s\S]*spend_brake_team_monthly\s+price_1/);
  });

  it('replaces a price that no longer matches the plan, moving its lookup key', async () => {
    const { store, stripe } = fakeStripe();
    const first = await seedStripe(stripe, opts);
    store.prices[1]!.unit_amount = 3900; // Team at an old price
    const again = await seedStripe(stripe, opts);
    expect(again.created).toEqual(['price spend_brake_team_monthly']);
    expect(again.prices.team).not.toBe(first.prices.team);
    expect(store.prices[1]).toMatchObject({ active: false, lookup_key: null });
    expect(store.prices.at(-1)).toMatchObject({
      lookup_key: 'spend_brake_team_monthly',
      unit_amount: 4900,
    });
    // The portal now offers the new price.
    expect(JSON.stringify(store.portals[0])).toContain(again.prices.team);
    expect(JSON.stringify(store.portals[0])).not.toContain(`"${first.prices.team}"`);
  });
});

describe('setup scripts and live keys', () => {
  // Dummy strings only: no real key is ever used here.
  it('take a test key, and a live key only with BRAKE_STRIPE_ALLOW_LIVE', () => {
    expect(stripeFromEnv({ STRIPE_SECRET_KEY: 'sk_test_dummy' }).live).toBe(false);
    expect(() => stripeFromEnv({ STRIPE_SECRET_KEY: 'rk_live_dummy' })).toThrow(
      /BRAKE_STRIPE_ALLOW_LIVE=1/,
    );
    expect(() =>
      stripeFromEnv({ STRIPE_SECRET_KEY: 'rk_live_dummy', BRAKE_STRIPE_ALLOW_LIVE: 'yes' }),
    ).toThrow(/BRAKE_STRIPE_ALLOW_LIVE=1/);
    for (const allow of ['1', 'true']) {
      expect(
        stripeFromEnv({ STRIPE_SECRET_KEY: 'rk_live_dummy', BRAKE_STRIPE_ALLOW_LIVE: allow }).live,
      ).toBe(true);
    }
    expect(() => stripeFromEnv({})).toThrow(/STRIPE_SECRET_KEY/);
    expect(() =>
      stripeFromEnv({ STRIPE_SECRET_KEY: 'pk_live_dummy', BRAKE_STRIPE_ALLOW_LIVE: '1' }),
    ).toThrow();
  });
});

function fakeWebhooks() {
  const endpoints: Stripe.WebhookEndpoint[] = [];
  let seq = 0;
  const stripe = {
    webhookEndpoints: {
      list: () => ({ [Symbol.asyncIterator]: () => endpoints[Symbol.iterator]() }),
      create: (p: Stripe.WebhookEndpointCreateParams) => {
        const e = {
          id: `we_${++seq}`,
          url: p.url,
          enabled_events: p.enabled_events,
          api_version: p.api_version ?? null,
          metadata: p.metadata ?? {},
          status: 'enabled',
        } as Stripe.WebhookEndpoint;
        endpoints.push(e);
        // Stripe returns the secret on creation only.
        return Promise.resolve({ ...e, secret: `whsec_dummy_${seq}` });
      },
      update: (id: string, p: Stripe.WebhookEndpointUpdateParams) => {
        const e = endpoints.find((x) => x.id === id)!;
        Object.assign(e, {
          url: p.url ?? e.url,
          enabled_events: p.enabled_events ?? e.enabled_events,
          metadata: p.metadata ?? e.metadata,
          status: p.disabled === false ? 'enabled' : e.status,
        });
        return Promise.resolve(e);
      },
      del: (id: string) => {
        endpoints.splice(
          endpoints.findIndex((x) => x.id === id),
          1,
        );
        return Promise.resolve({ id, deleted: true });
      },
    },
  };
  return { endpoints, stripe: stripe as unknown as Stripe };
}

describe('webhook setup', () => {
  const url = webhookUrl('https://app.spendbrake.dev/');

  it('subscribes to exactly the events billing handles', async () => {
    expect(url).toBe('https://app.spendbrake.dev/v1/billing/webhook');
    const { endpoints, stripe } = fakeWebhooks();
    const first = await setupWebhook(stripe, { url });
    expect(first).toMatchObject({ action: 'created', secret: 'whsec_dummy_1' });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({
      url,
      api_version: API_VERSION,
      metadata: { spend_brake_webhook: '1' },
    });
    expect([...endpoints[0]!.enabled_events].sort()).toEqual([...HANDLED_EVENTS].sort());
    expect(webhookReport(first, true)).toContain('STRIPE_WEBHOOK_SECRET=whsec_dummy_1');
    // The list is the cases applyEvent handles, no more and no fewer.
    const source = readFileSync(new URL('../src/webhooks.ts', import.meta.url), 'utf8');
    const cases = [...source.matchAll(/case '([a-z_]+\.[a-z_.]+)':/g)].map((m) => m[1]);
    expect(cases.sort()).toEqual([...HANDLED_EVENTS].sort());
  });

  it('is idempotent and never shows the secret again', async () => {
    const { endpoints, stripe } = fakeWebhooks();
    await setupWebhook(stripe, { url });
    const again = await setupWebhook(stripe, { url });
    expect(again).toMatchObject({ action: 'unchanged', secret: null, id: 'we_1' });
    expect(webhookReport(again, false)).toMatch(/Roll secret/);

    // Drifted events are put back; the endpoint is found by its metadata even at another URL.
    endpoints[0]!.enabled_events = ['invoice.paid'];
    endpoints[0]!.url = 'https://old.example.com/hook';
    const fixed = await setupWebhook(stripe, { url });
    expect(fixed.action).toBe('updated');
    expect(endpoints[0]).toMatchObject({ url });
    expect([...endpoints[0]!.enabled_events].sort()).toEqual([...HANDLED_EVENTS].sort());
    expect(endpoints).toHaveLength(1);
  });

  it('finds an endpoint made by hand by its URL, flags an old API version, and recreates', async () => {
    const { endpoints, stripe } = fakeWebhooks();
    endpoints.push({
      id: 'we_hand',
      url,
      enabled_events: [...HANDLED_EVENTS],
      api_version: '2020-08-27',
      metadata: {},
      status: 'enabled',
    } as unknown as Stripe.WebhookEndpoint);
    const found = await setupWebhook(stripe, { url });
    expect(found).toMatchObject({
      id: 'we_hand',
      action: 'updated',
      apiVersionMismatch: '2020-08-27',
    });
    expect(webhookReport(found, true)).toMatch(/--recreate/);
    const re = await setupWebhook(stripe, { url, recreate: true });
    expect(re).toMatchObject({ action: 'recreated', secret: 'whsec_dummy_1' });
    expect(endpoints.map((e) => e.id)).toEqual(['we_1']);
    expect(endpoints[0]?.api_version).toBe(API_VERSION);
  });
});
