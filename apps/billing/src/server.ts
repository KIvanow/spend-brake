import rateLimit from '@fastify/rate-limit';
import {
  ApiError,
  Authenticator,
  type Role,
  apiContext,
  type EmailSignIn,
  allowLinkTo,
  atLeast,
  bootstrapOrg,
  createLoginLink,
  createOrg,
  random62,
  writeCap,
} from '@spend-brake/api';
import type { ValkeyClient } from '@spend-brake/budget';
import {
  type Db,
  and,
  auditLog,
  caps,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  issuedLicenses,
  orgs,
  providerCredentials,
  sql,
  usageEvents,
  virtualKeys,
} from '@spend-brake/db';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { planOf, setPlan } from './entitlements.js';
import {
  CHECKOUT_PLANS,
  type CheckoutPlan,
  LICENSE_PLANS,
  LIMITS,
  MONTHLY_CENTS,
  PLAN_NAMES,
  PLANS,
  lookupKey,
} from './plans.js';
import { type LicenseMail, applyEvent } from './webhooks.js';

export interface BillingDeps {
  db: Db;
  valkey: ValkeyClient;
  stripe: Pick<
    Stripe,
    'customers' | 'checkout' | 'billingPortal' | 'prices' | 'products' | 'webhooks'
  >;
  webhookSecret: string;
  /** Where Checkout and the Customer Portal send people back to. */
  dashboardUrl: string;
  licenseKey: string | null;
  sendLicense: (mail: LicenseMail) => Promise<void>;
  /** Public sign-up (hosted service only). */
  signup?: boolean;
  /**
   * Sign-up emails the owner a sign-in link (the owner is a person). Without it, sign-up answers
   * with an owner API token instead.
   */
  signIn?: EmailSignIn;
  /**
   * Behind the dashboard's nginx (and Caddy with TLS): take the client's address from
   * X-Forwarded-For, trusting only hops on private networks, so rate limits are per client.
   */
  trustProxy?: boolean;
  now?: () => Date;
  logger?: boolean | object;
}

const ORG_ID = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * Hosted billing: sign-up, plan purchase through Stripe Checkout, plan changes and payment
 * details through the Customer Portal, license files for Business / Enterprise, and the Stripe
 * webhook that keeps org_entitlements in step. Mounted under /v1/billing behind the dashboard.
 */
export async function buildServer(deps: BillingDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 512 * 1024,
    // The compose network's hops (Caddy, nginx) are private; the first public address is the
    // client, so one sent in X-Forwarded-For by the client itself is ignored.
    trustProxy: deps.trustProxy ? 'loopback, linklocal, uniquelocal' : false,
  });
  const ctx = apiContext({ db: deps.db, valkey: deps.valkey, wrapper: null, now });
  const authenticator = new Authenticator(deps.db, now);
  const dashboard = deps.dashboardUrl.replace(/\/$/, '');

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    redis: deps.valkey,
    nameSpace: 'bk:rl:billing:',
    keyGenerator: (req) => `ip:${req.ip}`,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: 'invalid_request', message: 'Bad request.' });
    }
    app.log.error({ err: (err as Error).message }, 'billing error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal error.' });
  });

  async function auth(req: FastifyRequest, role: Role) {
    const a = await authenticator.authenticate(req);
    if (!a) throw new ApiError(401, 'unauthorized', 'Missing or invalid API token.');
    if (!atLeast(a.role, role))
      throw new ApiError(403, 'forbidden', `This needs the ${role} role.`);
    return a;
  }

  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new ApiError(400, 'invalid_request', 'Request failed validation.');
    return r.data;
  };

  const priceId = async (plan: CheckoutPlan) => {
    const [price] = (
      await deps.stripe.prices.list({ lookup_keys: [lookupKey(plan)], active: true, limit: 1 })
    ).data;
    if (!price) throw new ApiError(503, 'not_seeded', 'Plans are not set up in Stripe yet (seed).');
    return price.id;
  };

  async function customerFor(orgId: string, email: string | null) {
    const current = await planOf(deps.db, orgId);
    if (current?.stripeCustomerId) return current.stripeCustomerId;
    const customer = await deps.stripe.customers.create({
      ...(email ? { email } : {}),
      metadata: { orgId },
    });
    await setPlan(
      deps.db,
      orgId,
      { plan: current?.plan ?? 'free', stripeCustomerId: customer.id },
      now(),
    );
    return customer.id;
  }

  async function checkout(
    orgId: string,
    plan: CheckoutPlan,
    from: 'billing' | 'signup' = 'billing',
  ) {
    const current = await planOf(deps.db, orgId);
    if (current?.stripeSubscriptionId) {
      throw new ApiError(
        409,
        'has_subscription',
        'This org already has a subscription: change plans in the billing portal.',
      );
    }
    const customer = await customerFor(orgId, current?.billingEmail ?? null);
    const session = await deps.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: orgId,
      line_items: [{ price: await priceId(plan), quantity: 1 }],
      subscription_data: { metadata: { orgId } },
      // From sign-up the buyer is not signed in yet: the welcome page says to check their email.
      success_url:
        from === 'signup' ? `${dashboard}/#/welcome` : `${dashboard}/#/billing?checkout=done`,
      cancel_url:
        from === 'signup' ? `${dashboard}/#/welcome` : `${dashboard}/#/billing?checkout=cancelled`,
    });
    if (!session.url) throw new ApiError(502, 'stripe_error', 'Stripe returned no checkout URL.');
    return session.url;
  }

  app.get('/healthz', { config: { rateLimit: false } }, () => ({ ok: true, service: 'billing' }));

  // The plans and what each includes, for the sign-up page and the website (public).
  app.get('/v1/billing/plans', () => ({
    signup: deps.signup ?? false,
    plans: PLANS.map((id) => {
      const l = LIMITS[id];
      return {
        id,
        name: PLAN_NAMES[id],
        monthlyUsd:
          id === 'free' ? 0 : id in MONTHLY_CENTS ? MONTHLY_CENTS[id as CheckoutPlan] / 100 : null,
        selfHosted: id === 'business' || id === 'enterprise',
        // Sold through Checkout (Enterprise is arranged with us).
        purchasable: id === 'free' || (CHECKOUT_PLANS as readonly string[]).includes(id),
        limits: {
          ...l,
          maxOrgMonthCapMicros:
            l.maxOrgMonthCapMicros === null ? null : Number(l.maxOrgMonthCapMicros),
        },
      };
    }),
  }));

  app.get('/v1/billing', async (req) => {
    const a = await auth(req, 'viewer');
    const plan = (await planOf(deps.db, a.orgId)) ?? null;
    const month = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), 1));
    const count = async (q: Promise<{ n: string }[]>) => Number((await q)[0]?.n ?? 0);
    const usage = {
      keys: await count(
        deps.db
          .select({ n: sql<string>`count(*)::text` })
          .from(virtualKeys)
          .where(
            and(
              eq(virtualKeys.orgId, a.orgId),
              eq(virtualKeys.status, 'active'),
              sql`${virtualKeys.config}->>'sessionId' is null`,
            ),
          ),
      ),
      providers: await count(
        deps.db
          .select({ n: sql<string>`count(distinct ${providerCredentials.provider})::text` })
          .from(providerCredentials)
          .where(
            and(eq(providerCredentials.orgId, a.orgId), isNull(providerCredentials.revokedAt)),
          ),
      ),
      agentSessionsThisMonth: await count(
        deps.db
          .select({ n: sql<string>`count(*)::text` })
          .from(virtualKeys)
          .where(
            and(
              eq(virtualKeys.orgId, a.orgId),
              gte(virtualKeys.createdAt, month),
              sql`${virtualKeys.config}->>'sessionId' is not null`,
            ),
          ),
      ),
      requestsThisMonth: await count(
        deps.db
          .select({ n: sql<string>`count(*)::text` })
          .from(usageEvents)
          .where(
            and(
              eq(usageEvents.orgId, a.orgId),
              eq(usageEvents.type, 'usage'),
              gte(usageEvents.ts, month),
            ),
          ),
      ),
    };
    const licenses = await deps.db
      .select({
        id: issuedLicenses.id,
        edition: issuedLicenses.edition,
        expiresAt: issuedLicenses.expiresAt,
        issuedAt: issuedLicenses.issuedAt,
      })
      .from(issuedLicenses)
      .where(eq(issuedLicenses.orgId, a.orgId))
      .orderBy(desc(issuedLicenses.issuedAt))
      .limit(10);
    const limits = LIMITS[plan?.plan ?? 'free'];
    const [signupMark] = await deps.db
      .select({ id: auditLog.id, at: auditLog.at, data: auditLog.data })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, a.orgId),
          eq(auditLog.actor, 'system'),
          eq(auditLog.action, 'cap.set'),
          eq(auditLog.target, 'org:m'),
          sql`${auditLog.data}->>'source' = 'signup'`,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(1);
    const [orgCap] = await deps.db
      .select()
      .from(caps)
      .where(and(eq(caps.orgId, a.orgId), eq(caps.scope, 'org'), eq(caps.kind, 'm')))
      .limit(1);
    const [changedSince] = signupMark
      ? await deps.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.orgId, a.orgId),
              gt(auditLog.id, signupMark.id),
              sql`${auditLog.action} like 'cap.%'`,
              inArray(auditLog.target, ['org', 'org:m']),
            ),
          )
          .limit(1)
      : [];
    const mark = signupMark?.data as { hard?: number; version?: number } | undefined;
    // The org month cap is still the one sign-up wrote: no cap change audited since, same amount
    // and version, and not written since (a cap removed and set again starts over at version 1).
    const signupCap = Boolean(
      signupMark &&
      !changedSince &&
      orgCap &&
      orgCap.hardMicros !== null &&
      Number(orgCap.hardMicros) === mark?.hard &&
      orgCap.version === mark?.version &&
      orgCap.updatedAt <= signupMark.at,
    );
    // Where sign-up is open (the hosted service), self-hosted licenses are not offered to orgs
    // that use the hosted plans; an org that already has one keeps seeing it.
    const licensed =
      licenses.length > 0 || (LICENSE_PLANS as readonly string[]).includes(plan?.plan ?? '');
    const offered = CHECKOUT_PLANS.filter(
      (p) => !deps.signup || licensed || !(LICENSE_PLANS as readonly string[]).includes(p),
    );
    return {
      plan: plan?.plan ?? null,
      planName: plan ? PLAN_NAMES[plan.plan] : null,
      status: plan?.status ?? null,
      currentPeriodEnd: plan?.currentPeriodEnd?.toISOString() ?? null,
      hasSubscription: Boolean(plan?.stripeSubscriptionId),
      limits: plan
        ? {
            ...limits,
            maxOrgMonthCapMicros:
              limits.maxOrgMonthCapMicros === null ? null : Number(limits.maxOrgMonthCapMicros),
          }
        : null,
      usage,
      signupCap,
      plans: offered.map((p) => ({ id: p, name: PLAN_NAMES[p] })),
      licenses: licenses.map((l) => ({
        ...l,
        expiresAt: l.expiresAt.toISOString(),
        issuedAt: l.issuedAt.toISOString(),
      })),
    };
  });

  app.post('/v1/billing/checkout', async (req) => {
    const a = await auth(req, 'owner');
    const body = parse(z.object({ plan: z.enum(CHECKOUT_PLANS) }), req.body);
    return { url: await checkout(a.orgId, body.plan) };
  });

  app.post('/v1/billing/portal', async (req) => {
    const a = await auth(req, 'owner');
    const current = await planOf(deps.db, a.orgId);
    if (!current?.stripeCustomerId) {
      throw new ApiError(409, 'no_customer', 'Buy a plan first; the portal manages it afterwards.');
    }
    const session = await deps.stripe.billingPortal.sessions.create({
      customer: current.stripeCustomerId,
      return_url: `${dashboard}/#/billing`,
    });
    return { url: session.url };
  });

  app.get('/v1/billing/license', async (req, reply) => {
    const a = await auth(req, 'owner');
    const [latest] = await deps.db
      .select()
      .from(issuedLicenses)
      .where(eq(issuedLicenses.orgId, a.orgId))
      .orderBy(desc(issuedLicenses.issuedAt))
      .limit(1);
    if (!latest) throw new ApiError(404, 'not_found', 'No license has been issued to this org.');
    reply
      .type('application/json')
      .header('content-disposition', `attachment; filename="${a.orgId}.license"`);
    return latest.raw;
  });

  // Hosted sign-up: a Free org now, Checkout for a paid plan. The owner gets a sign-in link by
  // email (or, without email sign-in, an owner token shown once).
  const signupBody = z.object({
    orgId: z.string().regex(ORG_ID).optional(),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().pipe(z.email().max(320)),
    plan: z.enum(['free', ...CHECKOUT_PLANS]).default('free'),
    timeZone: z.string().max(64).optional(),
  });
  const validZone = (tz: string | undefined) => {
    if (!tz) return 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      return 'UTC';
    }
  };
  // "Acme, Inc." -> "acme-inc-x7k2p9": readable, and unlikely to be taken.
  const orgIdFor = (name: string) => {
    const slug = name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `${slug || 'org'}-${random62(6).toLowerCase()}`;
  };
  app.post(
    '/v1/billing/signup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!deps.signup) throw new ApiError(404, 'not_found', 'Sign-up is not open here.');
      const body = parse(signupBody, req.body);
      const email = body.email.trim().toLowerCase();
      // Each sign-up emails the address: keep anyone from flooding someone else's inbox.
      if (deps.signIn && !(await allowLinkTo(deps.valkey, email))) {
        throw new ApiError(429, 'rate_limited', 'Too many emails to that address; try in an hour.');
      }
      const orgId = body.orgId ?? orgIdFor(body.name);
      const org = { id: orgId, name: body.name, timeZone: validZone(body.timeZone) };
      const created = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
        const [taken] = await tx
          .select({ id: orgs.id })
          .from(orgs)
          .where(eq(orgs.id, orgId))
          .limit(1);
        if (taken) throw new ApiError(409, 'conflict', 'That org id is taken.');
        const orgDeps = { db: tx as unknown as Db, registry: ctx.registry };
        const result = deps.signIn
          ? { ownerToken: null, ...(await createOrg(orgDeps, org, { email })) }
          : { ownerToken: await bootstrapOrg(orgDeps, org), ownerId: null };
        // Alerts go to the owner by email until the org sets up a webhook (or another address).
        await tx
          .update(orgs)
          .set({ settings: { alertEmail: email } })
          .where(eq(orgs.id, orgId));
        await setPlan(tx, orgId, { plan: 'free', billingEmail: email }, now());
        return result;
      });
      // The Free plan protects up to its monthly amount from the first request.
      const capHard = LIMITS.free.maxOrgMonthCapMicros;
      const capVersion = await writeCap(ctx, orgId, 'org', 'm', { hard: capHard, soft: null });
      // Marks the cap as sign-up's, so Billing can say so while it stays unchanged.
      await deps.db.insert(auditLog).values({
        orgId,
        actor: 'system',
        action: 'cap.set',
        target: 'org:m',
        data: { hard: Number(capHard), soft: null, version: capVersion, source: 'signup' },
        at: now(),
      });
      if (deps.signIn && created.ownerId) {
        await deps.signIn.mailer.send({
          email,
          purpose: 'welcome',
          links: [
            {
              orgId,
              orgName: body.name,
              url: await createLoginLink(deps.valkey, deps.signIn.dashboardUrl, {
                id: created.ownerId,
                orgId,
              }),
            },
          ],
        });
      }
      reply.code(201);
      return {
        orgId,
        ...(created.ownerToken ? { ownerToken: created.ownerToken } : { emailSent: true }),
        ...(body.plan !== 'free'
          ? { checkoutUrl: await checkout(orgId, body.plan, 'signup') }
          : {}),
      };
    },
  );

  // Stripe needs the exact bytes it signed.
  await app.register((scoped, _opts, done) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_r, body, next) =>
      next(null, body),
    );
    scoped.post('/v1/billing/webhook', { config: { rateLimit: false } }, async (req, reply) => {
      let event: Stripe.Event;
      try {
        event = deps.stripe.webhooks.constructEvent(
          req.body as Buffer,
          String(req.headers['stripe-signature'] ?? ''),
          deps.webhookSecret,
        );
      } catch {
        return reply.code(400).send({ error: 'bad_signature', message: 'Invalid signature.' });
      }
      const outcome = await applyEvent(
        {
          db: deps.db,
          stripe: deps.stripe,
          licenseKey: deps.licenseKey,
          now,
          sendLicense: deps.sendLicense,
          log: app.log,
        },
        event,
      );
      return { received: true, outcome };
    });
    done();
  });

  return app;
}
