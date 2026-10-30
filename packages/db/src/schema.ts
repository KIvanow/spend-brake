import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Every row carries org_id; every query from the API filters on it.

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const orgs = pgTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timeZone: text('time_zone').notNull().default('UTC'),
  /** Provider settings and loop policy, mirrored to Valkey as the proxy's org record. */
  settings: jsonb('settings').notNull().default({}),
  createdAt: created(),
});

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    email: text('email').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'viewer'] }).notNull(),
    createdAt: created(),
    /** Removed from the org: cannot sign in; kept so the audit log still names them. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  // Emails are stored lower-case; sign-in looks one up across orgs.
  (t) => [uniqueIndex('users_org_email').on(t.orgId, t.email), index('users_email').on(t.email)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    userId: text('user_id').references(() => users.id),
    name: text('name').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'viewer'] }).notNull(),
    /**
     * How a person's token was issued: 'email' for an email sign-in link; null with a user is
     * single sign-on (the IdP vouches for the person).
     */
    signIn: text('sign_in', { enum: ['email'] }),
    /** SHA-256 of the token; the token itself is shown once. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: created(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_tokens_org').on(t.orgId)],
);

export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    /** Envelope-encrypted secret (see @spend-brake/shared envelope). */
    envelope: jsonb('envelope').notNull(),
    /** Last 4 characters, for display only. */
    hint: text('hint').notNull(),
    createdAt: created(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('provider_credentials_org').on(t.orgId)],
);

export const virtualKeys = pgTable(
  'virtual_keys',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** First characters of the token (`sb_live_ab12`), for display only. */
    prefix: text('prefix').notNull(),
    /** The proxy's key record (credentials, skus, env, caps template, ...). */
    config: jsonb('config').notNull(),
    status: text('status', { enum: ['active', 'revoked'] })
      .notNull()
      .default('active'),
    createdAt: created(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('virtual_keys_org').on(t.orgId)],
);

export const caps = pgTable(
  'caps',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    scope: text('scope').notNull(),
    kind: text('kind', { enum: ['d', 'm'] }).notNull(),
    hardMicros: bigint('hard_micros', { mode: 'bigint' }),
    softMicros: bigint('soft_micros', { mode: 'bigint' }),
    version: bigint('version', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.scope, t.kind] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    /** `token:<id>`, `user:<id>`, `link:<id>` or `system`. */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    reason: text('reason'),
    data: jsonb('data').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_org_at').on(t.orgId, t.at)],
);

/** Last seen hash of each catalog source page, for the nightly drift check. */
export const catalogChecks = pgTable('catalog_checks', {
  url: text('url').primaryKey(),
  hash: text('hash').notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  changedAt: timestamp('changed_at', { withTimezone: true }),
});

/** Outgoing alert webhooks. The URL (Slack/Teams URLs are credentials) and the signing secret are envelope-encrypted. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    preset: text('preset', { enum: ['raw', 'slack', 'discord', 'teams'] }).notNull(),
    urlEnvelope: jsonb('url_envelope').notNull(),
    /** Scheme and host only, for display. */
    urlHint: text('url_hint').notNull(),
    secretEnvelope: jsonb('secret_envelope').notNull(),
    /** Alert types to send; empty means all. */
    events: text('events').array().notNull().default([]),
    createdAt: created(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('webhooks_org').on(t.orgId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    orgId: text('org_id').notNull(),
    webhookId: text('webhook_id').notNull(),
    alertId: text('alert_id').notNull(),
    type: text('type').notNull(),
    attempt: bigint('attempt', { mode: 'number' }).notNull(),
    ok: boolean('ok').notNull(),
    httpStatus: bigint('http_status', { mode: 'number' }),
    error: text('error'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_deliveries_hook_at').on(t.webhookId, t.at)],
);

/** Optional Google Cloud Billing export (BigQuery) per org, for reconciliation. */
export const reconciliationConfigs = pgTable('reconciliation_configs', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id),
  /** `project.dataset.table` of the detailed or standard usage cost export. */
  exportTable: text('export_table').notNull(),
  /** Read-only service account JSON, envelope-encrypted. */
  envelope: jsonb('envelope').notNull(),
  serviceAccount: text('service_account').notNull(),
  /** Google Cloud project ids whose costs count (the projects that own the proxied keys). */
  projectIds: text('project_ids').array().notNull().default([]),
  createdAt: created(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastError: text('last_error'),
});

/** Ledger vs billing export, per SKU family per billing day (Pacific time). */
export const reconciliationResults = pgTable(
  'reconciliation_results',
  {
    orgId: text('org_id').notNull(),
    day: text('day').notNull(),
    /** Catalog SKU family (tier stripped), or `total`. */
    family: text('family').notNull(),
    ledgerMicros: bigint('ledger_micros', { mode: 'bigint' }).notNull(),
    billedMicros: bigint('billed_micros', { mode: 'bigint' }).notNull(),
    /** |ledger - billed| / billed; null when nothing was billed. */
    driftRatio: real('drift_ratio'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day, t.family] })],
);

/**
 * Hosted plans (Stripe). An org with no row has no plan limits: every self-hosted install.
 * Limits are enforced by the admin API only (never the proxy); null means unlimited.
 */
export const orgEntitlements = pgTable(
  'org_entitlements',
  {
    orgId: text('org_id')
      .primaryKey()
      .references(() => orgs.id),
    plan: text('plan', {
      enum: ['free', 'indie', 'team', 'agents', 'business', 'enterprise'],
    }).notNull(),
    /** `past_due`: a payment failed; creating keys, providers and sessions waits for it. */
    status: text('status', { enum: ['active', 'past_due'] })
      .notNull()
      .default('active'),
    maxKeys: bigint('max_keys', { mode: 'number' }),
    maxProviders: bigint('max_providers', { mode: 'number' }),
    agentSessionsPerMonth: bigint('agent_sessions_per_month', { mode: 'number' }),
    requestsPerMonth: bigint('requests_per_month', { mode: 'number' }),
    /** Highest monthly hard cap on the org (the Free plan's protected spend). */
    maxOrgMonthCapMicros: bigint('max_org_month_cap_micros', { mode: 'bigint' }),
    retentionDays: bigint('retention_days', { mode: 'number' }).notNull(),
    sessionAnalytics: boolean('session_analytics').notNull().default(false),
    customLoopRules: boolean('custom_loop_rules').notNull().default(false),
    billingEmail: text('billing_email'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('org_entitlements_customer').on(t.stripeCustomerId)],
);

/** Stripe webhook events already applied (Stripe retries; each is applied once). */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Signed license files issued on paid Business / Enterprise invoices. */
export const issuedLicenses = pgTable(
  'issued_licenses',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    edition: text('edition', { enum: ['business', 'enterprise'] }).notNull(),
    /** The paid invoice this license covers: one license per invoice. */
    invoiceId: text('invoice_id').notNull().unique(),
    raw: text('raw').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('issued_licenses_org').on(t.orgId, t.issuedAt)],
);
