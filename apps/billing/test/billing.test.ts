import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  sql,
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
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { setLicenseOrg } from '../src/entitlements.js';
import { licenseMailer } from '../src/mail.js';
import { PLAN_METADATA, type Plan, lookupKey } from '../src/plans.js';
import { CHECKOUT_WAIVER_MESSAGE, TERMS_VERSION, buildServer } from '../src/server.js';
import { stripeClient } from '../src/stripe.js';
import { type LicenseMail, applyEvent } from '../src/webhooks.js';

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
const portalSessions: Stripe.BillingPortal.SessionCreateParams[] = [];
const products: Record<string, { id: string; metadata: Record<string, string> }> = {
  prod_business: { id: 'prod_business', metadata: { [PLAN_METADATA]: 'business' } },
  prod_enterprise: {
    id: 'prod_enterprise',
    metadata: { [PLAN_METADATA]: 'enterprise', org_units: '40' },
  },
  prod_team: { id: 'prod_team', metadata: { [PLAN_METADATA]: 'team' } },
};
let customerSeq = 0;
/** Set to make Stripe calls fail: the price lookup ('prices') or opening Checkout ('checkout'). */
let stripeDown: 'prices' | 'checkout' | null = null;
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
    // Like Stripe, every customer an event names exists (with no metadata unless set here).
    retrieve: (id: string) =>
      Promise.resolve(customers.get(id) ?? ({ id, metadata: {} } as unknown as Stripe.Customer)),
    update: (id: string, p: Stripe.CustomerUpdateParams) => {
      const c = customers.get(id)!;
      c.metadata = { ...c.metadata, ...(p.metadata as Record<string, string>) };
      return Promise.resolve(c);
    },
  },
  checkout: {
    sessions: {
      create: (p: Stripe.Checkout.SessionCreateParams) => {
        if (stripeDown === 'checkout') return Promise.reject(new Error('Stripe is down'));
        checkouts.push(p);
        return Promise.resolve({
          id: `cs_${checkouts.length}`,
          url: `https://checkout.stripe.test/${checkouts.length}`,
        });
      },
    },
  },
  billingPortal: {
    configurations: {
      list: () =>
        Promise.resolve({
          data: [
            { id: 'bpc_other', metadata: {} },
            { id: 'bpc_seeded', metadata: { spend_brake_portal: '1' } },
          ],
        }),
    },
    sessions: {
      create: (p: { customer: string; return_url: string; configuration?: string }) => {
        portalSessions.push(p);
        return Promise.resolve({ url: `https://billing.stripe.test/${p.customer}` });
      },
    },
  },
  prices: {
    list: (p: { lookup_keys: string[] }) =>
      Promise.resolve({
        data:
          stripeDown === 'prices'
            ? []
            : p.lookup_keys.map((k) => ({ id: `price_${k}`, lookup_key: k })),
      }),
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

/** The org id licenses name in these tests: the buyer's install, not the hosted org. */
const installOf = (orgId: string) => `install_${orgId}`;

function signupRequest(payload: object, remoteAddress?: string) {
  return billing.inject({
    method: 'POST',
    url: '/v1/billing/signup',
    ...(remoteAddress ? { remoteAddress } : {}),
    payload,
  });
}

async function signup(plan: Plan | 'free' = 'free', remoteAddress?: string) {
  const orgId = `org_${++seq}_${randomBytes(2).toString('hex')}`;
  const res = await signupRequest(
    {
      orgId,
      name: orgId,
      email: `${orgId}@example.com`,
      plan,
      ...(plan === 'free' ? {} : { acceptTerms: true }),
      ...(plan === 'business' ? { licenseOrg: installOf(orgId) } : {}),
    },
    remoteAddress,
  );
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
  it('stores the org id of the install for a license, and lets the buyer retry', async () => {
    const payload = {
      name: 'Acme',
      email: 'license@example.com',
      plan: 'business',
      acceptTerms: true,
    };
    // Its own client address: sign-up is rate limited per client.
    const remoteAddress = '203.0.113.77';
    const missing = await signupRequest(payload, remoteAddress);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'license_org_required' });

    // The hosted org gets its own id; any number of buyers can license `acme`, and a buyer who
    // left Checkout signs up again. Install ids as short as `brake init` takes are fine.
    const first = await signupRequest({ ...payload, licenseOrg: 'acme' }, remoteAddress);
    const again = await signupRequest({ ...payload, licenseOrg: 'acme' }, remoteAddress);
    const short = await signupRequest({ ...payload, licenseOrg: 'io' }, remoteAddress);
    for (const r of [first, again, short]) expect(r.statusCode, r.body).toBe(201);
    const { orgId } = first.json<{ orgId: string }>();
    expect(orgId).not.toBe('acme');
    expect(again.json<{ orgId: string }>().orgId).not.toBe(orgId);
    expect(await plan(orgId)).toMatchObject({ plan: 'free', licenseOrg: 'acme' });
    expect(checkouts.at(-2)).toMatchObject({
      subscription_data: { metadata: { orgId: again.json<{ orgId: string }>().orgId } },
    });
    expect(checkouts.at(-1)).toMatchObject({
      subscription_data: { metadata: { license_org: 'io' } },
    });
  });

  it('refuses a taken hosted org id before counting an email to the address', async () => {
    // With email sign-in, where each sign-up counts against the address's emails an hour.
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
        mailer: { send: () => Promise.resolve() },
      },
      now: () => NOW,
    });
    const email = `taken-${randomBytes(3).toString('hex')}@example.com`;
    const attempt = (orgId: string) =>
      hosted.inject({
        method: 'POST',
        url: '/v1/billing/signup',
        remoteAddress: '203.0.113.78',
        payload: { orgId, name: 'x', email },
      });
    const orgId = `org_${++seq}_${randomBytes(2).toString('hex')}`;
    expect((await attempt(orgId)).statusCode).toBe(201);
    // More refusals than the address's emails an hour: none of them counted.
    for (let i = 0; i < 5; i++) {
      const taken = await attempt(orgId);
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toMatchObject({ error: 'conflict', message: 'That org id is taken.' });
    }
    expect((await attempt(`${orgId}_2`)).statusCode).toBe(201);
    await hosted.close();
  });

  it('offers Business under Billing to an org that signed up for it but left Checkout', async () => {
    const { orgId, ownerToken } = await signup('business', '203.0.113.79');
    const view = () => billing.inject({ url: '/v1/billing', headers: bearer(ownerToken) });
    expect((await view()).json<{ plans: { id: string }[] }>().plans.map((p) => p.id)).toContain(
      'business',
    );
    const set = await billing.inject({
      method: 'PUT',
      url: '/v1/billing/license-org',
      headers: bearer(ownerToken),
      payload: { licenseOrg: 'acme-prod' },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await view()).json()).toMatchObject({ licenseOrg: 'acme-prod' });
    const res = await billing.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: bearer(ownerToken),
      payload: { plan: 'business', acceptTerms: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(checkouts.at(-1)).toMatchObject({
      subscription_data: { metadata: { license_org: 'acme-prod' } },
    });
    // The Stripe customer gets a copy of the id.
    const customer = (await plan(orgId)).stripeCustomerId!;
    expect(customers.get(customer)!.metadata).toMatchObject({ license_org: 'acme-prod' });
  });

  it('changes nothing about the install org id when Checkout fails to open', async () => {
    const { orgId, ownerToken } = await signup('free', '203.0.113.82');
    const buy = () =>
      billing.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: bearer(ownerToken),
        payload: { plan: 'business', licenseOrg: 'hq', acceptTerms: true },
      });
    const audited = () =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'billing.license_org_set')));
    try {
      stripeDown = 'prices';
      expect((await buy()).statusCode).toBe(503);
      stripeDown = 'checkout';
      expect((await buy()).statusCode).toBe(500);
    } finally {
      stripeDown = null;
    }
    expect((await plan(orgId)).licenseOrg).toBeNull();
    expect(await audited()).toEqual([]);
    expect((await buy()).statusCode).toBe(200);
    expect((await plan(orgId)).licenseOrg).toBe('hq');
    expect(await audited()).toHaveLength(1);
  });

  it('needs the install org id to buy a license from Billing', async () => {
    const { ownerToken } = await signup('free', '203.0.113.80');
    const buy = (extra: object) =>
      billing.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: bearer(ownerToken),
        payload: { plan: 'business', acceptTerms: true, ...extra },
      });
    expect((await buy({})).json()).toMatchObject({ error: 'license_org_required' });
    expect((await buy({ licenseOrg: 'hq' })).statusCode).toBe(200);
    expect(checkouts.at(-1)).toMatchObject({
      subscription_data: { metadata: { license_org: 'hq' } },
    });
    // Copied to the Stripe customer at checkout too, not only when changed later.
    const customer = checkouts.at(-1)!.customer as string;
    expect(customers.get(customer)!.metadata).toMatchObject({ license_org: 'hq' });
    // Only an owner may change the id licenses name.
    for (const role of ['admin', 'viewer']) {
      const token = (
        await api.inject({
          method: 'POST',
          url: '/v1/tokens',
          headers: bearer(ownerToken),
          payload: { name: role, role },
        })
      ).json<{ token: string }>().token;
      const res = await billing.inject({
        method: 'PUT',
        url: '/v1/billing/license-org',
        headers: bearer(token),
        payload: { licenseOrg: 'other' },
      });
      expect(res.statusCode, role).toBe(403);
    }
  });

  it('audits a change of the install org id and leaves the plan and its limits as they are', async () => {
    const { orgId, ownerToken } = await signup('business', '203.0.113.81');
    await db.update(orgEntitlements).set({ maxKeys: 7 }).where(eq(orgEntitlements.orgId, orgId));
    const put = (licenseOrg: string) =>
      billing.inject({
        method: 'PUT',
        url: '/v1/billing/license-org',
        headers: bearer(ownerToken),
        payload: { licenseOrg },
      });
    expect((await put('acme-prod')).statusCode).toBe(200);
    expect((await put('acme-prod')).statusCode).toBe(200);
    expect(await plan(orgId)).toMatchObject({ licenseOrg: 'acme-prod', maxKeys: 7 });
    const rows = await db
      .select({ actor: auditLog.actor, data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'billing.license_org_set')))
      .orderBy(auditLog.id);
    // Sign-up's, then the change once: saving the same id again changes nothing.
    expect(rows.map((r) => r.data)).toEqual([
      { from: null, to: installOf(orgId) },
      { from: installOf(orgId), to: 'acme-prod' },
    ]);
    expect(rows[1]!.actor).not.toBe('system');
  });

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
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
    });
    // Stripe Tax is off unless asked for (test mode without tax registrations).
    expect(checkouts.at(-1)).not.toHaveProperty('automatic_tax');
    const customer = (await plan(orgId)).stripeCustomerId!;
    expect(customers.get(customer)?.metadata).toEqual({ orgId });

    const paid = await signup('team');
    expect(paid.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  });

  it('adds VAT through Stripe Tax when automatic tax is on', async () => {
    const taxed = await buildServer({
      db,
      valkey,
      stripe: fakeStripe,
      webhookSecret: SECRET,
      dashboardUrl: 'https://app.example.com',
      licenseKey: null,
      sendLicense: () => Promise.resolve(),
      signup: true,
      automaticTax: true,
      now: () => NOW,
    });
    try {
      const orgId = `org_tax_${randomBytes(2).toString('hex')}`;
      const res = await taxed.inject({
        method: 'POST',
        url: '/v1/billing/signup',
        remoteAddress: '10.0.0.78',
        payload: {
          orgId,
          name: orgId,
          email: `${orgId}@example.com`,
          plan: 'agents',
          acceptTerms: true,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(checkouts.at(-1)).toMatchObject({
        client_reference_id: orgId,
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        customer_update: { address: 'auto', name: 'auto' },
      });
    } finally {
      await taxed.close();
    }
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
    // The seeded configuration (plan switches), back to the billing page.
    expect(portalSessions.at(-1)).toEqual({
      customer: 'cus_p',
      return_url: 'https://app.example.com/#/billing',
      configuration: 'bpc_seeded',
    });
  });
});

describe('agent sessions', () => {
  it('count toward the plan, except $0 probes (brake doctor --prove), whose caps are locked', async () => {
    const { ownerToken: t } = await signup('free', '203.0.113.78');
    const cred = (await credential(t, 'mapbox')).json<{ id: string }>().id;
    const parentKeyId = (await newKey(t, cred)).json<{ id: string }>().id;
    const mint = (payload: object) =>
      api.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: bearer(t),
        payload: { parentKeyId, ...payload },
      });
    const probe = { budgetMicros: '0', dayBudgetMicros: '0', ttlSec: 60, probe: true };
    for (let i = 0; i < 19; i++)
      expect((await mint({ budgetMicros: '1000' })).statusCode).toBe(201);
    // A $0 session that does not ask to be a probe is an ordinary session: it counts, and its
    // caps may be raised later.
    const plain = await mint({ budgetMicros: '0', dayBudgetMicros: '0', ttlSec: 60 });
    expect(plain.statusCode).toBe(201);
    const plainKey = plain.json<{ keyId: string }>().keyId;
    expect(
      (
        await api.inject({
          method: 'PUT',
          url: `/v1/caps/key:${plainKey}`,
          headers: bearer(t),
          payload: { month: { hard: 1_000_000 } },
        })
      ).statusCode,
    ).toBe(200);
    expect((await mint({ budgetMicros: '1000' })).json()).toMatchObject({ error: 'plan_limit' });
    // A short $0 session asked for as a probe is one: it can never spend.
    expect((await mint(probe)).statusCode).toBe(201);
    const short = await mint(probe);
    expect(short.statusCode).toBe(201);
    // A probe with a budget or a long life is refused, not taken for a session.
    for (const over of [{ budgetMicros: '1000' }, { ttlSec: 7 * 24 * 3600 }]) {
      const bad = await mint({ ...probe, ...over });
      expect(bad.statusCode, JSON.stringify(over)).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid_request' });
    }

    // Raising (or removing) a probe's caps would let it spend outside the plan: refused.
    const { keyId, sessionId } = short.json<{ keyId: string; sessionId: string }>();
    for (const scope of [`key:${keyId}`, `sess:${sessionId}`]) {
      const raise = await api.inject({
        method: 'PUT',
        url: `/v1/caps/${scope}`,
        headers: bearer(t),
        payload: { month: { hard: 1_000_000 } },
      });
      expect(raise.statusCode, scope).toBe(409);
      expect(raise.json()).toMatchObject({ error: 'probe_session' });
      const drop = await api.inject({
        method: 'DELETE',
        url: `/v1/caps/${scope}`,
        headers: bearer(t),
      });
      expect(drop.json()).toMatchObject({ error: 'probe_session' });
    }
    // So would fail-open or a longer life on the key itself; its name may change.
    for (const payload of [{ failOpenMicros: '50000000' }, { expiresAt: null }]) {
      const patch = await api.inject({
        method: 'PATCH',
        url: `/v1/keys/${keyId}`,
        headers: bearer(t),
        payload,
      });
      expect(patch.json(), JSON.stringify(payload)).toMatchObject({ error: 'probe_session' });
    }
    const renamed = await api.inject({
      method: 'PATCH',
      url: `/v1/keys/${keyId}`,
      headers: bearer(t),
      payload: { name: 'doctor probe' },
    });
    expect(renamed.statusCode).toBe(200);
    // The billing page counts them as the API does.
    const usage = await billing.inject({ url: '/v1/billing', headers: bearer(t) });
    expect(usage.json()).toMatchObject({ usage: { agentSessionsThisMonth: 20 } });
  });

  it('refuses even a $0 probe while a payment has failed', async () => {
    const { orgId, ownerToken: t } = await signup('free', '203.0.113.79');
    const cred = (await credential(t, 'mapbox')).json<{ id: string }>().id;
    const parentKeyId = (await newKey(t, cred)).json<{ id: string }>().id;
    await db
      .update(orgEntitlements)
      .set({ status: 'past_due' })
      .where(eq(orgEntitlements.orgId, orgId));
    const res = await api.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: bearer(t),
      payload: { parentKeyId, budgetMicros: '0', dayBudgetMicros: '0', ttlSec: 60, probe: true },
    });
    expect(res.json()).toMatchObject({ error: 'payment_required' });
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
    // Paying the invoice that failed lifts the hold.
    await post(
      event('invoice.paid', {
        id: 'in_f',
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
      org: installOf(orgId),
      edition: 'business',
      orgUnits: 3,
      expiresAt: first.toISOString(),
    });
    expect(mails.at(-1)).toMatchObject({
      orgId,
      licenseOrg: installOf(orgId),
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
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="${installOf(orgId)}.license"`,
    );
    expect(verify(download.body).expiresAt).toBe(second.toISOString());

    // A typo fixed under Billing: the next renewal names the new id.
    await billing.inject({
      method: 'PUT',
      url: '/v1/billing/license-org',
      headers: bearer(ownerToken),
      payload: { licenseOrg: 'acme-prod' },
    });
    const third = new Date('2027-01-30T12:00:00Z');
    await post(event('invoice.paid', invoice('in_b3', 'cus_b', 'prod_business', third)));
    const [latest] = await db
      .select()
      .from(issuedLicenses)
      .where(and(eq(issuedLicenses.orgId, orgId), eq(issuedLicenses.invoiceId, 'in_b3:il_in_b3')));
    expect(verify(latest!.raw).org).toBe('acme-prod');
    // Hosted plans get no license.
    const hosted = await signup();
    await post(event('invoice.paid', invoice('in_t', 'cus_hosted', 'prod_team', second)));
    expect(
      await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, hosted.orgId)),
    ).toEqual([]);
  });

  it('issues Enterprise licenses from hand-made invoices, with the org units on the product', async () => {
    const { orgId } = await signup();
    customers.set('cus_ent', {
      id: 'cus_ent',
      metadata: { orgId, license_org: 'bigcorp' },
    } as unknown as Stripe.Customer);
    await post(
      event(
        'invoice.paid',
        invoice('in_e1', 'cus_ent', 'prod_enterprise', new Date('2027-10-30T00:00:00Z')),
      ),
    );
    const [row] = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(verify(row!.raw)).toMatchObject({ org: 'bigcorp', edition: 'enterprise', orgUnits: 40 });
    expect(row!.licenseOrg).toBe('bigcorp');
    expect((await plan(orgId)).licenseOrg).toBe('bigcorp');
  });

  it('refuses license_org metadata that is not an org id, so Stripe retries once it is fixed', async () => {
    const { orgId, ownerToken } = await signup('free', '203.0.113.83');
    // A failed payment earlier: paying lifts its hold even while the license waits, and leaves
    // the org's own limits as they are.
    await db
      .update(orgEntitlements)
      .set({ status: 'past_due', maxKeys: 7 })
      .where(eq(orgEntitlements.orgId, orgId));
    customers.set('cus_typo', {
      id: 'cus_typo',
      metadata: { orgId, license_org: 'big corp' },
    } as unknown as Stripe.Customer);
    const warned: string[] = [];
    const before = mails.length;
    const paid = event(
      'invoice.paid',
      invoice('in_typo', 'cus_typo', 'prod_enterprise', new Date('2027-10-30T00:00:00Z')),
    ) as unknown as Stripe.Event;
    const apply = () =>
      applyEvent(
        {
          db,
          stripe: fakeStripe,
          licenseKey: signer.privateKey,
          now: () => NOW,
          sendLicense: (m) => Promise.resolve(void mails.push(m)),
          log: { warn: (_o, msg) => void warned.push(msg) },
        },
        paid,
      );
    // Not recorded: the endpoint answers 500 and Stripe sends the event again.
    await expect(apply()).rejects.toThrow(/not a valid org id/);
    expect(warned).toEqual([
      'license_org metadata is not a valid org id: license not issued, the event will be retried',
    ]);
    expect(await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId))).toEqual(
      [],
    );
    expect(mails).toHaveLength(before);
    expect(await db.select().from(stripeEvents).where(eq(stripeEvents.id, paid.id))).toEqual([]);
    expect(await plan(orgId)).toMatchObject({ status: 'active', maxKeys: 7 });
    // The owner fixes the id under Billing; Stripe's retry issues the license for the paid period.
    await billing.inject({
      method: 'PUT',
      url: '/v1/billing/license-org',
      headers: bearer(ownerToken),
      payload: { licenseOrg: 'bigcorp' },
    });
    expect(await apply()).toBe('applied');
    const [row] = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(verify(row!.raw).org).toBe('bigcorp');
    expect(mails).toHaveLength(before + 1);
  });

  it('sells no license without a signing key, and retries a license invoice paid anyway', async () => {
    const keyless = await buildServer({
      db,
      valkey,
      stripe: fakeStripe,
      webhookSecret: SECRET,
      dashboardUrl: 'https://app.example.com',
      licenseKey: null,
      sendLicense: () => Promise.resolve(),
      signup: true,
      now: () => NOW,
    });
    onTestFinished(() => keyless.close());
    const plans = (await keyless.inject('/v1/billing/plans')).json<{
      plans: { id: string; purchasable: boolean }[];
    }>().plans;
    expect(plans.find((p) => p.id === 'business')).toMatchObject({ purchasable: false });
    expect(plans.find((p) => p.id === 'team')).toMatchObject({ purchasable: true });
    const buy = await keyless.inject({
      method: 'POST',
      url: '/v1/billing/signup',
      remoteAddress: '203.0.113.90',
      payload: {
        name: 'x',
        email: `keyless-${randomBytes(3).toString('hex')}@example.com`,
        plan: 'business',
        licenseOrg: 'acme',
        acceptTerms: true,
      },
    });
    expect(buy.statusCode).toBe(409);
    expect(buy.json()).toMatchObject({ error: 'license_unavailable' });

    // Enterprise invoiced by hand anyway: not recorded, so Stripe retries once a key is set.
    const { orgId } = await signup('free', '203.0.113.91');
    customers.set('cus_keyless', {
      id: 'cus_keyless',
      metadata: { orgId, license_org: 'bigcorp' },
    } as unknown as Stripe.Customer);
    const paid = event(
      'invoice.paid',
      invoice('in_keyless', 'cus_keyless', 'prod_enterprise', new Date('2027-10-30T00:00:00Z')),
    ) as unknown as Stripe.Event;
    const deps = { db, stripe: fakeStripe, now: () => NOW, sendLicense: () => Promise.resolve() };
    await expect(applyEvent({ ...deps, licenseKey: null }, paid)).rejects.toThrow(
      /no license signing key/,
    );
    expect(await db.select().from(stripeEvents).where(eq(stripeEvents.id, paid.id))).toEqual([]);
    expect(await applyEvent({ ...deps, licenseKey: signer.privateKey }, paid)).toBe('applied');
    const [row] = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(verify(row!.raw).org).toBe('bigcorp');
  });

  it('issues no first license without the install id, and renews an old one for the id it named', async () => {
    const deps = {
      db,
      stripe: fakeStripe,
      licenseKey: signer.privateKey,
      now: () => NOW,
      sendLicense: () => Promise.resolve(),
    };
    const paid = (inv: string, customer: string) =>
      event(
        'invoice.paid',
        invoice(inv, customer, 'prod_enterprise', new Date('2027-10-30T00:00:00Z')),
      ) as unknown as Stripe.Event;
    // An Enterprise customer made by hand without license_org: a license for the hosted id would
    // be refused by the buyer's install, so the event waits for the id.
    const { orgId } = await signup('free', '203.0.113.92');
    customers.set('cus_noid', {
      id: 'cus_noid',
      metadata: { orgId },
    } as unknown as Stripe.Customer);
    await expect(applyEvent(deps, paid('in_noid', 'cus_noid'))).rejects.toThrow(/no license_org/);
    expect(await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId))).toEqual(
      [],
    );
    // Set in Stripe by hand, with a stray space: the retry issues it for the trimmed id.
    customers.get('cus_noid')!.metadata.license_org = ' bigcorp ';
    expect(await applyEvent(deps, paid('in_noid', 'cus_noid'))).toBe('applied');
    const [row] = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(verify(row!.raw).org).toBe('bigcorp');

    // An org licensed before license_org existed (its license named the hosted id) renews as is.
    const old = await signup('free', '203.0.113.93');
    await db.insert(issuedLicenses).values({
      id: `lic_old_${randomBytes(3).toString('hex')}`,
      orgId: old.orgId,
      edition: 'enterprise',
      invoiceId: `in_old_${old.orgId}`,
      raw: '{}',
      licenseOrg: old.orgId,
      expiresAt: NOW,
      issuedAt: new Date(NOW.getTime() - 86_400_000),
    });
    customers.set('cus_old', {
      id: 'cus_old',
      metadata: { orgId: old.orgId },
    } as unknown as Stripe.Customer);
    expect(await applyEvent(deps, paid('in_old_renew', 'cus_old'))).toBe('applied');
    const renewed = await db
      .select()
      .from(issuedLicenses)
      .where(eq(issuedLicenses.invoiceId, 'in_old_renew:il_in_old_renew'));
    expect(verify(renewed[0]!.raw).org).toBe(old.orgId);
  });

  it('emails every license even when one email cannot be queued, and logs that one', async () => {
    const { orgId } = await signup('business', '203.0.113.94');
    customers.set('cus_mail', {
      id: 'cus_mail',
      metadata: { orgId },
    } as unknown as Stripe.Customer);
    const two = invoice('in_mail', 'cus_mail', 'prod_business', new Date('2026-11-30T12:00:00Z'));
    two.lines.data.push({ ...two.lines.data[0]!, id: 'il_in_mail_2' });
    const queued: string[] = [];
    const errors: string[] = [];
    let first = true;
    const outcome = await applyEvent(
      {
        db,
        stripe: fakeStripe,
        licenseKey: signer.privateKey,
        now: () => NOW,
        sendLicense: (m) => {
          if (first) {
            first = false;
            return Promise.reject(new Error('valkey down'));
          }
          queued.push(m.licenseId);
          return Promise.resolve();
        },
        log: { warn: () => undefined, error: (_o, msg) => void errors.push(msg) },
      },
      event('invoice.paid', two) as unknown as Stripe.Event,
    );
    expect(outcome).toBe('applied');
    expect(queued).toHaveLength(1);
    expect(errors).toEqual(['license email not queued: send the license to the customer by hand']);
  });

  it('backfills the stored install id from the latest license (migration 0010)', async () => {
    const { orgId } = await signup('free', '203.0.113.95');
    const lic = (id: string, licenseOrg: string, at: number) => ({
      id,
      orgId,
      edition: 'business' as const,
      invoiceId: `${id}:il`,
      raw: '{}',
      licenseOrg,
      expiresAt: NOW,
      issuedAt: new Date(at),
    });
    const tag = randomBytes(3).toString('hex');
    await db
      .insert(issuedLicenses)
      .values([lic(`lic_a_${tag}`, 'old-install', 1_000), lic(`lic_b_${tag}`, 'acme', 2_000)]);
    const backfill = readFileSync(
      new URL('../../../packages/db/drizzle/0010_license_org_backfill.sql', import.meta.url),
      'utf8',
    );
    await db.execute(sql.raw(backfill));
    expect((await plan(orgId)).licenseOrg).toBe('acme');
    // An id already stored is kept.
    await setLicenseOrg(db, orgId, 'kept', 'system', NOW);
    await db.execute(sql.raw(backfill));
    expect((await plan(orgId)).licenseOrg).toBe('kept');
  });

  it('lifts a hold only when the invoice whose failure set it is paid', async () => {
    const { orgId } = await signup('free', '203.0.113.96');
    customers.set('cus_hold', {
      id: 'cus_hold',
      metadata: { orgId },
    } as unknown as Stripe.Customer);
    const deps = {
      db,
      stripe: fakeStripe,
      licenseKey: signer.privateKey,
      now: () => NOW,
      sendLicense: () => Promise.resolve(),
    };
    const apply = (type: string, invoiceId: string) =>
      applyEvent(
        deps,
        event(type, {
          id: invoiceId,
          object: 'invoice',
          customer: 'cus_hold',
          lines: { data: [] },
        }) as unknown as Stripe.Event,
      );
    // Invoice A fails, then B: the hold is B's.
    await apply('invoice.payment_failed', 'in_a');
    await apply('invoice.payment_failed', 'in_b');
    expect(await plan(orgId)).toMatchObject({ status: 'past_due', holdInvoice: 'in_b' });
    // Paying A (or a retry of an old paid A) leaves B's hold in place.
    await apply('invoice.paid', 'in_a');
    expect((await plan(orgId)).status).toBe('past_due');
    // Paying B lifts it, with the org's own limits kept.
    await db.update(orgEntitlements).set({ maxKeys: 9 }).where(eq(orgEntitlements.orgId, orgId));
    await apply('invoice.paid', 'in_b');
    expect(await plan(orgId)).toMatchObject({ status: 'active', holdInvoice: null, maxKeys: 9 });
  });

  it('ignores a paid invoice for a customer that is no org, without reading its products', async () => {
    const reads = vi.spyOn(fakeStripe.products, 'retrieve');
    onTestFinished(() => reads.mockRestore());
    const outcome = await applyEvent(
      {
        db,
        stripe: fakeStripe,
        licenseKey: signer.privateKey,
        now: () => NOW,
        sendLicense: () => Promise.resolve(),
      },
      event(
        'invoice.paid',
        invoice('in_stranger', 'cus_stranger', 'prod_business', new Date('2026-11-30T12:00:00Z')),
      ) as unknown as Stripe.Event,
    );
    expect(outcome).toBe('ignored');
    expect(reads).not.toHaveBeenCalled();
  });

  it('takes a valid license_org from the customer over an invalid one on the subscription', async () => {
    const { orgId } = await signup('free', '203.0.113.97');
    customers.set('cus_both', {
      id: 'cus_both',
      metadata: { orgId, license_org: 'acme' },
    } as unknown as Stripe.Customer);
    const inv = {
      ...invoice('in_both', 'cus_both', 'prod_enterprise', new Date('2027-10-30T00:00:00Z')),
      parent: { subscription_details: { metadata: { license_org: 'acme corp' } } },
    };
    expect(
      await applyEvent(
        {
          db,
          stripe: fakeStripe,
          licenseKey: signer.privateKey,
          now: () => NOW,
          sendLicense: () => Promise.resolve(),
        },
        event('invoice.paid', inv) as unknown as Stripe.Event,
      ),
    ).toBe('applied');
    const [row] = await db.select().from(issuedLicenses).where(eq(issuedLicenses.orgId, orgId));
    expect(verify(row!.raw).org).toBe('acme');
  });

  it('emails each license on an invoice with several license lines', async () => {
    const { orgId } = await signup('business', '203.0.113.84');
    await post(
      event('customer.subscription.created', subscription(orgId, 'cus_two', 'business', 'active')),
    );
    const two = invoice('in_two', 'cus_two', 'prod_business', new Date('2026-11-30T12:00:00Z'));
    two.lines.data.push({ ...two.lines.data[0]!, id: 'il_in_two_2' });
    await post(event('invoice.paid', two));
    const sent = mails.filter((m) => m.invoiceId === 'in_two');
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((m) => m.licenseId)).size).toBe(2);

    // The notifier's queue keeps one job per license, and still drops a repeat of one.
    const connection = connectValkey(`redis://${vk.getHost()}:${vk.getMappedPort(6379)}`, {
      maxRetriesPerRequest: null,
    });
    const mailer = licenseMailer(connection);
    try {
      for (const m of [...sent, sent[0]!]) await mailer.send(m);
      const jobs = await mailer.queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((j) => j.id?.startsWith('license|in_two|'))).toHaveLength(2);
    } finally {
      await mailer.queue.close();
      await connection.quit();
    }
  });
});

describe('setup', () => {
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
