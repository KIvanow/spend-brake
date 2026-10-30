import { sql } from '@spend-brake/db';
import { bigint, boolean, index, jsonb, pgTable, text, timestamp } from '@spend-brake/db/pg-core';

// Tables for the commercial features. Core tables are referenced by id only: the core schema
// owns them and never knows these exist.

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Installed license files; the newest valid one applies. */
export const eeLicenses = pgTable('ee_licenses', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  raw: text('raw').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  installedBy: text('installed_by').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Roles beyond owner/admin/viewer, attached to an API token whose core role is viewer. */
export const eeTokenRoles = pgTable('ee_token_roles', {
  tokenId: text('token_id').primaryKey(),
  orgId: text('org_id').notNull(),
  role: text('role', { enum: ['operator', 'billing', 'auditor'] }).notNull(),
  createdAt: created(),
});

export const eeOrgPolicies = pgTable('ee_org_policies', {
  orgId: text('org_id').primaryKey(),
  /** Raising or removing a hard cap needs a second person. */
  capApprovals: boolean('cap_approvals').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eeApprovals = pgTable(
  'ee_approvals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    scope: text('scope').notNull(),
    kind: text('kind', { enum: ['d', 'm'] }).notNull(),
    fromHardMicros: bigint('from_hard_micros', { mode: 'bigint' }),
    /** Null with `remove` set: the cap is removed. */
    toHardMicros: bigint('to_hard_micros', { mode: 'bigint' }),
    toSoftMicros: bigint('to_soft_micros', { mode: 'bigint' }),
    remove: boolean('remove').notNull().default(false),
    via: text('via').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reason: text('reason'),
  },
  (t) => [index('ee_approvals_org_status').on(t.orgId, t.status)],
);

export const eeSsoConfigs = pgTable('ee_sso_configs', {
  orgId: text('org_id').primaryKey(),
  protocol: text('protocol', { enum: ['oidc', 'saml'] }).notNull(),
  /** OIDC: issuer, clientId, secret envelope. SAML: entryPoint, idpCert, spEntityId. */
  settings: jsonb('settings').notNull(),
  /** Claim or attribute holding the user's groups. */
  groupsClaim: text('groups_claim').notNull().default('groups'),
  /** Group name -> role. */
  roleMap: jsonb('role_map')
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** Role for users in no mapped group; null refuses them. */
  defaultRole: text('default_role'),
  allowedDomains: jsonb('allowed_domains')
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** How far each audit export sink has got (audit_log ids are increasing). */
export const eeExportCursors = pgTable('ee_export_cursors', {
  sink: text('sink').primaryKey(),
  lastId: bigint('last_id', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The catalog bundle in use. */
export const eeCatalogFeed = pgTable('ee_catalog_feed', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
});
