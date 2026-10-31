import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { type LoginMail, buildApi, redeemLoginLink } from '@spend-brake/api';
import { BudgetEngine, connectValkey, type ValkeyClient } from '@spend-brake/budget';
import {
  type Db,
  and,
  auditLog,
  createDb,
  eq,
  issuedLicenses,
  migrate,
  orgEntitlements,
  orgs,
  stripeEvents,
  virtualKeys,
} from '@spend-brake/db';
import {
  LICENSE_FORMAT,
  LocalKeyWrapper,
  licensePayload,
  verifyDocument,
} from '@spend-brake/shared';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_METADATA, type Plan, lookupKey } from '../src/plans.js';
import { CHECKOUT_WAIVER_MESSAGE, TERMS_VERSION, buildServer } from '../src/server.js';
import { seedStripe } from '../src/seed.js';
import { stripeClient } from '../src/stripe.js';
import type { LicenseMail } from '../src/webhooks.js';

const SECRET = 'whsec_test_secret';
const NOW = new Date('2026-10-30T12:00:00Z');
const signer = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const webhooks = new Stripe('sk_test_signing_only').webhooks;

// --- a fake Stripe API (no network) ------------------------------------------------------------
const customers = new Map<string, Stripe.Customer>();
const checkouts: Stripe.Checkout.SessionCreateParams[] = [];
const products: Record<string, { id: string; metadata: Record<string, string> }> = {
  prod_business: { id: 'prod_business', metadata: { [PLAN_METADATA]: 'business' } },
  prod_enterprise: {
    id: 'prod_enterprise',
    metadata: { [PLAN_METADATA]: 'enterprise', org_units: '40' },
  },
  prod_team: { id: 'prod_team', metadata: { [PLAN_METADATA]: 'team' } },
};
let customerSeq = 0;
const fakeStripe = {
  customers: {
    create: (p: Stripe.CustomerCreateParams) => {
      const c = {
        id: `cus_${++customerSeq}`,
        email: p.email,
        metadata: p.metadata,
      } as Stripe.Customer;
      customers.set(c.id, c);
      return Promise.resolve(c);
    },
    retrieve: (id: string) => Promise.resolve(customers.get(id)!),
  },
  checkout: {
    sessions: {
      create: (p: Stripe.Checkout.SessionCreateParams) => {
        checkouts.push(p);
        return Promise.resolve({
          id: `cs_${checkouts.length}`,
          url: `https://checkout.stripe.test/${checkouts.length}`,
        });
      },
    },
  },
  billingPortal: {
    sessions: {
      create: (p: { customer: string; return_url: string }) =>
        Promise.resolve({ url: `https://billing.stripe.test/${p.customer}` }),
    },
  },
  prices: {
    list: (p: { lookup_keys: string[] }) =>
      Promise.resolve({ data: p.lookup_keys.map((k) => ({ id: `price_${k}`, lookup_key: k })) }),
  },
  products: { retrieve: (id: string) => Promise.resolve(products[id]!) },
  webhooks,
} as unknown as Parameters<typeof buildServer>[0]['stripe'];

// --- environment -------------------------------------------------------------------------------
let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: ValkeyClient;
let billing: FastifyInstance;
let api: FastifyInstance;
const mails: LicenseMail[] = [];

beforeAll(async () => {
  [pg, vk] = await Promise.all([
    new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_PASSWORD: 'p', POSTGRES_USER: 'brake', POSTGRES_DB: 'brake' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  ({ db, pool } = createDb(`postgres://brake:p@${pg.getHost()}:${pg.getMappedPort(5432)}/brake`));
  await migrate(db);
  valkey = connectValkey(`redis://${vk.getHost()}:${vk.getMappedPort(6379)}`);
  billing = await buildServer({
    db,
    valkey,
    stripe: fakeStripe,
    webhookSecret: SECRET,
    dashboardUrl: 'https://app.example.com',
    licenseKey: signer.privateKey,
    sendLicense: (m) => {
      mails.push(m);
      return Promise.resolve();
    },
    signup: true,
    now: () => NOW,
  });
  api = await buildApi({
    db,
    valkey,
    wrapper: new LocalKeyWrapper(randomBytes(32).toString('base64')),
    authCacheMs: 0,
    rateLimitPerMinute: 10_000,
    now: () => NOW,
  });
});

afterAll(async () => {
  await billing.close();
  await api.close();
  await valkey.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

// --- helpers -------------------------------------------------------------------------------------
let seq = 0;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function signup(plan: Plan | 'free' = 'free', remoteAddress?: string) {
  const orgId = `org_${++seq}_${randomBytes(2).toString('hex')}`;
  const res = await billing.inject({
    method: 'POST',
    url: '/v1/billing/signup',
    ...(remoteAddress ? { remoteAddress } : {}),
    payload: {
      orgId,
      name: orgId,
      email: `${orgId}@example.com`,
      plan,
      ...(plan === 'free' ? {} : { acceptTerms: true }),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { orgId, ...res.json<{ ownerToken: string; checkoutUrl?: string }>() };
}

function post(event: { id: string; type: string; data: { object: unknown } }, secret = SECRET) {
  const payload = JSON.stringify({ object: 'event', api_version: '2026-07-29.dahlia', ...event });
  return billing.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': webhooks.generateTestHeaderString({ payload, secret }),
    },
    payload,
  });
}

let eventSeq = 0;
const event = (type: string, object: unknown) => ({
  id: `evt_${++eventSeq}`,
  type,
  data: { object },
});

const subscription = (
  orgId: string,
  customer: string,
  plan: Plan,
  status: Stripe.Subscription.Status,
  id = `sub_${orgId}`,
) => ({
  id,
  object: 'subscription',
  customer,
  status,
  metadata: { orgId },
  items: {
    data: [
      {
        price: { id: `price_${plan}`, lookup_key: lookupKey(plan as 'indie'), metadata: {} },
        current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86_400,
      },
    ],
  },
});

const invoice = (id: string, customer: string, product: string, periodEnd: Date) => ({
  id,
  object: 'invoice',
  customer,
  customer_email: 'billing@example.com',
  lines: {
    data: [
      {
        id: `il_${id}`,
        period: {
          start: Math.floor(NOW.getTime() / 1000),
          end: Math.floor(periodEnd.getTime() / 1000),
        },
        pricing: { price_details: { product, price: `price_${product}` } },
      },
    ],
  },
});

const plan = async (orgId: string) =>
  (await db.select().from(orgEntitlements).where(eq(orgEntitlements.orgId, orgId)))[0]!;

async function credential(token: string, provider: string) {
  return api.inject({
    method: 'POST',
    url: '/v1/providers/credentials',
    headers: bearer(token),
    payload: {
      provider,
      name: provider,
      secret: `secret-${provider}-${randomBytes(4).toString('hex')}`,
    },
  });
}

async function newKey(token: string, credId: string, extra: object = {}) {
  return api.inject({
    method: 'POST',
    url: '/v1/keys',
    headers: bearer(token),
    payload: { name: `k${++seq}`, credentials: { mapbox: credId }, ...extra },
  });
}

// --- tests ---------------------------------------------------------------------------------------
describe('Stripe webhooks', () => {
  it('refuse a bad signature and change nothing', async () => {
    const { orgId } = await signup();
    const e = event(
      'customer.subscription.created',
      subscription(orgId, 'cus_x', 'agents', 'active'),
    );
    const res = await post(e, 'whsec_someone_else');
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(stripeEvents).where(eq(stripeEvents.id, e.id))).toEqual([]);
    expect((await plan(orgId)).plan).toBe('free');
  });

  it('apply a replayed event once', async () => {
    const { orgId } = await signup();
    const e = event(
      'customer.subscription.created',
      subscription(orgId, 'cus_r', 'team', 'active'),
    );
    expect((await post(e)).json()).toMatchObject({ outcome: 'applied' });
    expect((await post(e)).json()).toMatchObject({ outcome: 'duplicate' });
    expect((await plan(orgId)).plan).toBe('team');
  });
});

describe('sign-up and checkout', () => {
  it('creates a Free org with its protected spend, and opens Checkout for a paid plan', async () => {
    const { orgId, ownerToken } = await signup();
    expect(await plan(orgId)).toMatchObject({
      plan: 'free',
      maxKeys: 1,
      billingEmail: `${orgId}@example.com`,
    });
    const cap = await new BudgetEngine(valkey).getCap(orgId, { kind: 'org' }, 'm');
    expect(cap?.hard).toBe(50_000_000n);
    // Alerts reach the owner by email before any webhook is set up.
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    expect(org?.settings).toEqual({ alertEmail: `${orgId}@example.com` });
    const above = await api.inject({
      method: 'PUT',
      url: '/v1/caps/org',
      headers: bearer(ownerToken),
      payload: { month: { hard: 100_000_000 } },
    });
    expect(above.json()).toMatchObject({ error: 'plan_limit' });

    const res = await billing.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: bearer(ownerToken),
      payload: { plan: 'indie', acceptTerms: true },
    });
    expect(res.json()).toMatchObject({
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//) as string,
    });
    expect(checkouts.at(-1)).toMatchObject({
      mode: 'subscription',
      client_reference_id: orgId,
      line_items: [{ price: `price_${lookupKey('indie')}`, quantity: 1 }],
      subscription_data: {
        metadata: { orgId, terms_version: TERMS_VERSION, withdrawal_waiver: 'true' },
      },
      custom_text: { submit: { message: CHECKOUT_WAIVER_MESSAGE } },
    });
    const customer = (await plan(orgId)).stripeCustomerId!;
    expect(customers.get(customer)?.metadata).toEqual({ orgId });

    const paid = await signup('team');
    expect(paid.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  });

  it('offers only the hosted plans to a hosted org without a license', async () => {
    // Its own client address: sign-ups are rate limited per client.
    const { orgId, ownerToken } = await signup('free', '10.0.0.77');
    const view = async () =>
      (await billing.inject({ url: '/v1/billing', headers: bearer(ownerToken) }))
        .json<{ plans: { id: string }[] }>()
        .plans.map((p) => p.id);
    expect(await view()).toEqual(['indie', 'team', 'agents']);
    await post(
      event('customer.subscription.created', subscription(orgId, 'cus_lic', 'business', 'active')),
    );
    expect(await view()).toContain('business');
  });

  it("says the org cap is sign-up's only while it is unchanged", async () => {
    const signupCap = async (token: string) =>
      (await billing.inject({ url: '/v1/billing', headers: bearer(token) })).json<{
        signupCap: boolean;
      }>().signupCap;
    const setCap = (token: string, hard: number) =>
      api.inject({
        method: 'PUT',
        url: '/v1/caps/org',
        headers: bearer(token),
        payload: { month: { hard } },
      });

    const changed = await signup('free', '10.0.0.78');
    expect(await signupCap(changed.ownerToken)).toBe(true);
    expect((await setCap(changed.ownerToken, 40_500_000)).statusCode).toBe(200);
    expect(await signupCap(changed.ownerToken)).toBe(false);

    // Removed, then set again at the same amount: a new cap, back at version 1.
    const again = await signup('free', '10.0.0.79');
    await post(
      event(
        'customer.subscription.created',
        subscription(again.orgId, 'cus_cap', 'team', 'active'),
      ),
    );
    const removed = await api.inject({
      method: 'DELETE',
      url: '/v1/caps/org',
      headers: bearer(again.ownerToken),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await signupCap(again.ownerToken)).toBe(false);
    const reset = await setCap(again.ownerToken, 50_000_000);
    expect(reset.json()).toMatchObject({ items: [{ version: 1 }] });
    expect(await signupCap(again.ownerToken)).toBe(false);

    // The cap sign-up set is in the audit log.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, again.orgId), eq(auditLog.actor, 'system')));
    expect(entry).toMatchObject({
      action: 'cap.set',
      target: 'org:m',
      data: { hard: 50_000_000, soft: null, version: 1, source: 'signup' },
    });
  });

  it('refuses a paid checkout without consent to the terms and the withdrawal waiver', async () => {
    const before = checkouts.length;
    const orgId = `org_${++seq}_${randomBytes(2).toString('hex')}`;
    const refused = await billing.inject({
      method: 'POST',
      url: '/v1/billing/signup',
      remoteAddress: '10.0.0.90',
      payload: { orgId, name: orgId, email: `${orgId}@example.com`, plan: 'team' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: 'terms_required',
      message: expect.stringContaining('Terms of Service') as string,
    });
    // Nothing was created.
    expect(await db.select().from(orgs).where(eq(orgs.id, orgId))).toEqual([]);
    const notTrue = await billing.inject({
      method: 'POST',
      url: '/v1/billing/signup',
      remoteAddress: '10.0.0.90',
      payload: {
        orgId,
        name: orgId,
        email: `${orgId}@example.com`,
        plan: 'team',
        acceptTerms: false,
      },
    });
    expect(notTrue.json()).toMatchObject({ error: 'terms_required' });

    const { ownerToken, orgId: freeOrg } = await signup('free', '10.0.0.91');
    for (const payload of [{ plan: 'indie' }, { plan: 'indie', acceptTerms: false }]) {
      const res = await billing.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: bearer(ownerToken),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'terms_required' });
    }
    expect(checkouts.length).toBe(before);
    const terms = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, freeOrg), eq(auditLog.action, 'billing.terms_accepted')));
    expect(terms).toEqual([]);
  });

  it('records the consent given before a paid checkout and passes it to Stripe', async () => {
    const termsEntries = (orgId: string) =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'billing.terms_accepted')));

    // Sign-up with a paid plan.
    const paid = await signup('agents', '10.0.0.92');
    expect(checkouts.at(-1)).toMatchObject({
      client_reference_id: paid.orgId,
      subscription_data: {
        metadata: { orgId: paid.orgId, terms_version: '2026-10-31', withdrawal_waiver: 'true' },
      },
      custom_text: {
        submit: { message: expect.stringContaining('14-day right of withdrawal') as string },
      },
    });
    expect(checkouts.at(-1)).not.toHaveProperty('consent_collection');
    expect(await termsEntries(paid.orgId)).toMatchObject([
      {
        actor: 'system',
        target: 'plan:agents',
        data: {
          plan: 'agents',
          termsVersion: '2026-10-31',
          withdrawalWaiver: true,
          source: 'signup',
        },
      },
    ]);
    // A Free sign-up agrees to no checkout.
    const free = await signup('free', '10.0.0.93');
    expect(await termsEntries(free.orgId)).toEqual([]);

    // Upgrading from Billing: recorded against whoever bought.
    const res = await billing.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: bearer(free.ownerToken),
      payload: { plan: 'team', acceptTerms: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(checkouts.at(-1)).toMatchObject({
      client_reference_id: free.orgId,
      subscription_data: {
        metadata: { orgId: free.orgId, terms_version: '2026-10-31', withdrawal_waiver: 'true' },
      },
    });
    const [entry] = await termsEntries(free.orgId);
    expect(entry).toMatchObject({
      target: 'plan:team',
      data: { plan: 'team', termsVersion: '2026-10-31', withdrawalWaiver: true, source: 'billing' },
    });
    expect(entry!.actor).toMatch(/^(token|user):/);
  });

  it('only lets owners buy, and sends existing subscribers to the portal', async () => {
    const { orgId, ownerToken } = await signup();
    await post(
      event('customer.subscription.created', subscription(orgId, 'cus_p', 'indie', 'active')),
    );
    const again = await billing.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: bearer(ownerToken),
      payload: { plan: 'team', acceptTerms: true },
    });
    expect(again.json()).toMatchObject({ error: 'has_subscription' });
    const portal = await billing.inject({
      method: 'POST',
      url: '/v1/billing/portal',
      headers: bearer(ownerToken),
    });
    expect(portal.json()).toEqual({ url: 'https://billing.stripe.test/cus_p' });
  });
});

describe('plan transitions', () => {
  it('moves through every plan, blocking only new resources on downgrade or failed payment', async () => {
    const { orgId, ownerToken } = await signup();
    const t = ownerToken;
    const cred = (await credential(t, 'mapbox')).json<{ id: string }>().id;
    expect((await newKey(t, cred)).statusCode).toBe(201);
    // Free: one key, one provider.
    expect((await newKey(t, cred)).json()).toMatchObject({
      error: 'plan_limit',
      message: 'The free plan allows 1 key. Upgrade the plan on the Billing page to add more.',
    });
    expect((await credential(t, 'here')).json()).toMatchObject({
      error: 'plan_limit',
      message: 'The free plan allows 1 provider. Upgrade the plan on the Billing page to add more.',
    });

    // Checkout completes, then the subscription arrives: Indie.
    await post(
      event('checkout.session.completed', {
        id: 'cs_t',
        object: 'checkout.session',
        client_reference_id: orgId,
        customer: 'cus_t',
        subscription: `sub_${orgId}`,
        customer_details: { email: 'x@example.com' },
      }),
    );
    await post(
      event('customer.subscription.created', subscription(orgId, 'cus_t', 'indie', 'active')),
    );
    expect(await plan(orgId)).toMatchObject({
      plan: 'indie',
      maxKeys: null,
      maxProviders: 2,
      stripeCustomerId: 'cus_t',
      stripeSubscriptionId: `sub_${orgId}`,
    });
    expect((await newKey(t, cred)).statusCode).toBe(201);
    expect((await credential(t, 'here')).statusCode).toBe(201);
    expect((await credential(t, 'tavily')).json()).toMatchObject({ error: 'plan_limit' });
    const analytics = () => api.inject({ url: '/v1/spend?groupBy=session', headers: bearer(t) });
    expect((await analytics()).json()).toMatchObject({ error: 'plan_feature' });

    // Team: five providers.
    await post(
      event('customer.subscription.updated', subscription(orgId, 'cus_t', 'team', 'active')),
    );
    expect((await plan(orgId)).maxProviders).toBe(5);
    expect((await credential(t, 'tavily')).statusCode).toBe(201);

    // Agents: unlimited, session analytics and custom loop rules.
    await post(
      event('customer.subscription.updated', subscription(orgId, 'cus_t', 'agents', 'active')),
    );
    expect(await plan(orgId)).toMatchObject({
      plan: 'agents',
      maxProviders: null,
      sessionAnalytics: true,
    });
    expect((await analytics()).statusCode).toBe(200);
    const loop = { loop: { identical: 5, windowSec: 60, perMinute: 100, cooldownSec: 60 } };
    expect((await newKey(t, cred, loop)).statusCode).toBe(201);

    // Back down to Indie: nothing is taken away, new extras are refused.
    await post(
      event('customer.subscription.updated', subscription(orgId, 'cus_t', 'indie', 'active')),
    );
    const active = await db.select().from(virtualKeys).where(eq(virtualKeys.orgId, orgId));
    expect(active.filter((k) => k.status === 'active')).toHaveLength(3);
    expect((await newKey(t, cred, loop)).json()).toMatchObject({ error: 'plan_feature' });
    expect((await credential(t, 'exa')).json()).toMatchObject({ error: 'plan_limit' });

    // A failed payment blocks creating anything until it is paid.
    await post(
      event('invoice.payment_failed', {
        id: 'in_f',
        object: 'invoice',
        customer: 'cus_t',
        lines: { data: [] },
      }),
    );
    expect((await plan(orgId)).status).toBe('past_due');
    expect((await newKey(t, cred)).json()).toMatchObject({ error: 'payment_required' });
    await post(
      event('invoice.paid', {
        id: 'in_ok',
        object: 'invoice',
        customer: 'cus_t',
        lines: { data: [] },
      }),
    );
    expect((await plan(orgId)).status).toBe('active');
    expect((await newKey(t, cred)).statusCode).toBe(201);

    // Dunning over: the subscription ends and the org drops to Free limits; its keys stay.
    await post(
      event('customer.subscription.updated', subscription(orgId, 'cus_t', 'indie', 'past_due')),
    );
    expect((await plan(orgId)).status).toBe('past_due');
    await post(
      event('customer.subscription.deleted', subscription(orgId, 'cus_t', 'indie', 'canceled')),
    );
    expect(await plan(orgId)).toMatchObject({
      plan: 'free',
      status: 'active',
      stripeSubscriptionId: null,
    });
    expect((await newKey(t, cred)).json()).toMatchObject({ error: 'plan_limit' });
    const after = await db.select().from(virtualKeys).where(eq(virtualKeys.orgId, orgId));
    expect(after.filter((k) => k.status === 'active')).toHaveLength(4);
  });

  it('leaves a self-hosted org (no plan) unlimited', async () => {
    const { bootstrapOrg } = await import('@spend-brake/api');
    const { Registry } = await import('@spend-brake/budget');
    const orgId = `self_${randomBytes(3).toString('hex')}`;
    const owner = await bootstrapOrg(
      { db, registry: new Registry(valkey) },
      { id: orgId, name: orgId },
    );
    for (const p of ['mapbox', 'here', 'tavily', 'exa', 'brave', 'serpapi']) {
      expect((await credential(owner, p)).statusCode).toBe(201);
    }
  });
});

describe('licenses', () => {
  const verify = (raw: string) =>
    licensePayload.parse(verifyDocument(raw, LICENSE_FORMAT, signer.publicKey));

  it('issues a signed license when a Business invoice is paid, and renews it on the next', async () => {
    const { orgId, ownerToken } = await signup('business');
    const first = new Date('2026-11-30T12:00:00Z');
    await post(
      event('customer.subscription.created', subscription(orgId, 'cus_b', 'business', 'active')),
    );
    const e1 = event('invoice.paid', invoice('in_b1', 'cus_b', 'prod_business', first));
    await post(e1);
    await post(e1); // replayed: still one license
    let rows = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(verify(rows[0]!.raw)).toMatchObject({
      org: orgId,
      edition: 'business',
      orgUnits: 3,
      expiresAt: first.toISOString(),
    });
    expect(mails.at(-1)).toMatchObject({
      orgId,
      edition: 'business',
      email: `${orgId}@example.com`,
    });

    const second = new Date('2026-12-30T12:00:00Z');
    await post(event('invoice.paid', invoice('in_b2', 'cus_b', 'prod_business', second)));
    rows = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(rows).toHaveLength(2);
    const download = await billing.inject({
      url: '/v1/billing/license',
      headers: bearer(ownerToken),
    });
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${orgId}.license"`);
    expect(verify(download.body).expiresAt).toBe(second.toISOString());
    // Hosted plans get no license.
    const hosted = await signup();
    await post(event('invoice.paid', invoice('in_t', 'cus_hosted', 'prod_team', second)));
    expect(
      await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, hosted.orgId)),
    ).toEqual([]);
  });

  it('issues Enterprise licenses from hand-made invoices, with the org units on the product', async () => {
    const { orgId } = await signup();
    customers.set('cus_ent', { id: 'cus_ent', metadata: { orgId } } as unknown as Stripe.Customer);
    await post(
      event(
        'invoice.paid',
        invoice('in_e1', 'cus_ent', 'prod_enterprise', new Date('2027-10-30T00:00:00Z')),
      ),
    );
    const [row] = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(verify(row!.raw)).toMatchObject({ edition: 'enterprise', orgUnits: 40 });
  });
});

describe('setup', () => {
  it('seeds products, prices and the portal once', async () => {
    const store = {
      products: [] as Stripe.Product[],
      prices: [] as Stripe.Price[],
      portals: [] as { id: string; metadata: Record<string, string> }[],
    };
    const fake = {
      products: {
        list: () => ({
          [Symbol.asyncIterator]: () => store.products[Symbol.iterator](),
        }),
        create: (p: Stripe.ProductCreateParams) => {
          const product = { id: `prod_${store.products.length}`, ...p } as Stripe.Product;
          store.products.push(product);
          return Promise.resolve(product);
        },
      },
      prices: {
        list: (p: { lookup_keys: string[] }) =>
          Promise.resolve({
            data: store.prices.filter((x) => p.lookup_keys.includes(x.lookup_key!)),
          }),
        create: (p: Stripe.PriceCreateParams) => {
          const price = { id: `price_${store.prices.length}`, ...p } as unknown as Stripe.Price;
          store.prices.push(price);
          return Promise.resolve(price);
        },
      },
      billingPortal: {
        configurations: {
          list: () => Promise.resolve({ data: store.portals }),
          create: (p: { metadata: Record<string, string> }) => {
            const c = { id: `bpc_${store.portals.length}`, metadata: p.metadata };
            store.portals.push(c);
            return Promise.resolve(c);
          },
        },
      },
    } as unknown as Stripe;
    const first = await seedStripe(fake);
    expect(first.created).toHaveLength(10); // 5 products, 4 prices, the portal
    expect(store.prices.map((p) => [p.lookup_key, p.unit_amount])).toEqual([
      ['spend_brake_indie_monthly', 900],
      ['spend_brake_team_monthly', 4900],
      ['spend_brake_agents_monthly', 14900],
      ['spend_brake_business_monthly', 29900],
    ]);
    const second = await seedStripe(fake);
    expect(second.created).toEqual([]);
    expect(second.prices).toEqual(first.prices);
  });

  it('refuses live Stripe keys', () => {
    expect(() => stripeClient('sk_live_abc')).toThrow(/test-mode/);
    expect(() => stripeClient('sk_test_abc')).not.toThrow();
    // Only the seed script opts in to live mode.
    expect(() => stripeClient('rk_live_abc', { allowLive: true })).not.toThrow();
    expect(() => stripeClient('sk_org_live_abc', { allowLive: true })).toThrow();
  });
});

describe('sign-up with email sign-in', () => {
  it('makes the owner a person and emails them a welcome link instead of a token', async () => {
    const sent: LoginMail[] = [];
    const hosted = await buildServer({
      db,
      valkey,
      stripe: fakeStripe,
      webhookSecret: SECRET,
      dashboardUrl: 'https://app.example.com',
      licenseKey: null,
      sendLicense: () => Promise.resolve(),
      signup: true,
      signIn: {
        dashboardUrl: 'https://app.example.com',
        mailer: { send: (m) => Promise.resolve(void sent.push(m)) },
      },
      now: () => NOW,
    });
    const res = await hosted.inject({
      method: 'POST',
      url: '/v1/billing/signup',
      payload: {
        name: 'Acme, Inc.',
        email: ' Founder@Acme.test ',
        plan: 'team',
        timeZone: 'Europe/Sofia',
        acceptTerms: true,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ orgId: string; emailSent: boolean; checkoutUrl: string }>();
    expect(body.orgId).toMatch(/^acme-inc-[0-9a-z]{6}$/);
    expect(body).not.toHaveProperty('ownerToken');
    expect(body.emailSent).toBe(true);
    // From sign-up the buyer comes back to the welcome page (they are not signed in yet).
    expect(checkouts.at(-1)).toMatchObject({
      client_reference_id: body.orgId,
      success_url: 'https://app.example.com/#/welcome',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      email: 'founder@acme.test',
      purpose: 'welcome',
      paidPlan: { name: 'Team', termsVersion: TERMS_VERSION },
    });
    expect(sent[0]!.links[0]).toMatchObject({ orgId: body.orgId, orgName: 'Acme, Inc.' });
    const code = /#login=(.+)$/.exec(sent[0]!.links[0]!.url)![1]!;
    const signedIn = await redeemLoginLink(
      { db, valkey, now: () => NOW, allowed: () => Promise.resolve(true) },
      code,
    );
    expect(signedIn).toMatchObject({
      orgId: body.orgId,
      role: 'owner',
      email: 'founder@acme.test',
    });
    const org = await api.inject({ url: '/v1/org', headers: bearer(signedIn!.token) });
    expect(org.json()).toMatchObject({ id: body.orgId, timeZone: 'Europe/Sofia' });
    await hosted.close();
  });

  it('rate limits sign-up per client behind the reverse proxy', async () => {
    const behind = await buildServer({
      db,
      valkey,
      stripe: fakeStripe,
      webhookSecret: SECRET,
      dashboardUrl: 'https://app.example.com',
      licenseKey: null,
      sendLicense: () => Promise.resolve(),
      signup: true,
      trustProxy: true,
      now: () => NOW,
    });
    const attempt = (forwardedFor: string, remoteAddress = '172.18.0.5') =>
      behind.inject({
        method: 'POST',
        url: '/v1/billing/signup',
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
        payload: {},
      });
    for (let i = 0; i < 10; i++) expect((await attempt('203.0.113.7')).statusCode).toBe(400);
    expect((await attempt('203.0.113.7')).statusCode).toBe(429);
    // Another client (Caddy -> nginx hops are private) still gets through.
    expect((await attempt('198.51.100.9, 172.18.0.2')).statusCode).toBe(400);
    // A client at the edge can't pick its bucket with its own X-Forwarded-For.
    expect((await attempt('198.51.100.20', '203.0.113.7')).statusCode).toBe(429);
    await behind.close();
  });

  it('lists the plans publicly, with prices and limits', async () => {
    const res = await billing.inject('/v1/billing/plans');
    expect(res.statusCode).toBe(200);
    const { plans } = res.json<{
      plans: { id: string; monthlyUsd: number | null; purchasable: boolean; selfHosted: boolean }[];
    }>();
    expect(plans.map((p) => [p.id, p.monthlyUsd, p.purchasable, p.selfHosted])).toEqual([
      ['free', 0, true, false],
      ['indie', 9, true, false],
      ['team', 49, true, false],
      ['agents', 149, true, false],
      ['business', 299, true, true],
      ['enterprise', null, false, true],
    ]);
  });
});
