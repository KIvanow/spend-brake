import {
  and,
  desc,
  eq,
  gte,
  lt,
  reconciliationConfigs,
  reconciliationResults,
} from '@spend-brake/db';
import { billingExportContext, encryptSecret } from '@spend-brake/shared';
import { z } from 'zod';
import { ApiError, type Ctx, type Router, audit, n } from '@spend-brake/api';
import type { Entitlements } from '../entitlements.js';

const TABLE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

const statusView = z
  .object({
    configured: z.boolean(),
    exportTable: z.string().nullable(),
    serviceAccount: z.string().nullable(),
    projectIds: z.array(z.string()),
    lastRunAt: z.string().nullable(),
    lastError: z.string().nullable(),
    message: z.string(),
  })
  .openapi('Reconciliation');

const NOT_CONFIGURED =
  "Spend is measured by the proxy only. Connect the Google Cloud Billing export to compare it with Google's bill.";

/**
 * Optional reconciliation against the Cloud Billing export in BigQuery. The service account
 * should only be able to read the export (BigQuery Data Viewer on the dataset and Job User).
 */
export function reconciliationRoutes(r: Router, ctx: Ctx, ent: Entitlements): void {
  r.add({
    method: 'get',
    path: '/v1/reconciliation',
    role: 'viewer',
    tag: 'Spend',
    summary: 'Billing-export reconciliation settings and last run',
    response: statusView,
    handler: async ({ auth }) => {
      await ent.require('reconciliation', 'read');
      const [cfg] = await ctx.db
        .select()
        .from(reconciliationConfigs)
        .where(eq(reconciliationConfigs.orgId, auth.orgId))
        .limit(1);
      if (!cfg) {
        return {
          configured: false,
          exportTable: null,
          serviceAccount: null,
          projectIds: [],
          lastRunAt: null,
          lastError: null,
          message: NOT_CONFIGURED,
        };
      }
      return {
        configured: true,
        exportTable: cfg.exportTable,
        serviceAccount: cfg.serviceAccount,
        projectIds: cfg.projectIds,
        lastRunAt: cfg.lastRunAt?.toISOString() ?? null,
        lastError: cfg.lastError,
        message: cfg.lastRunAt
          ? 'Compared daily with the billing export; drift above 5% raises an alert.'
          : 'Configured; the first comparison runs within six hours.',
      };
    },
  });

  r.add({
    method: 'put',
    path: '/v1/reconciliation',
    role: 'admin',
    tag: 'Spend',
    summary: 'Connect the Google Cloud Billing export (BigQuery) with a read-only service account',
    body: z.object({
      exportTable: z.string().regex(TABLE, 'Expected project.dataset.table.'),
      serviceAccountJson: z
        .string()
        .min(2)
        .max(20_000)
        .openapi({ description: 'Never returned or logged' }),
      projectIds: z
        .array(z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/))
        .max(50)
        .default([]),
    }),
    response: statusView,
    handler: async ({ auth, body }) => {
      await ent.require('reconciliation', 'write');
      if (!ctx.wrapper) {
        throw new ApiError(503, 'no_master_key', 'Set BRAKE_MASTER_KEY or BRAKE_KMS_KEY_ID first.');
      }
      let sa: {
        type?: unknown;
        client_email?: unknown;
        private_key?: unknown;
        project_id?: unknown;
      };
      try {
        sa = JSON.parse(body.serviceAccountJson) as typeof sa;
      } catch {
        throw new ApiError(400, 'invalid_request', 'serviceAccountJson is not JSON.');
      }
      if (
        sa.type !== 'service_account' ||
        typeof sa.client_email !== 'string' ||
        typeof sa.private_key !== 'string' ||
        typeof sa.project_id !== 'string'
      ) {
        throw new ApiError(
          400,
          'invalid_request',
          'Expected a service account key file (type service_account).',
        );
      }
      const row = {
        orgId: auth.orgId,
        exportTable: body.exportTable,
        envelope: await encryptSecret(
          ctx.wrapper,
          body.serviceAccountJson,
          billingExportContext(auth.orgId),
        ),
        serviceAccount: sa.client_email,
        projectIds: body.projectIds,
        lastRunAt: null,
        lastError: null,
      };
      await ctx.db
        .insert(reconciliationConfigs)
        .values(row)
        .onConflictDoUpdate({ target: reconciliationConfigs.orgId, set: row });
      await audit(ctx, auth, 'reconciliation.set', body.exportTable, {
        serviceAccount: sa.client_email,
        projectIds: body.projectIds,
      });
      return {
        configured: true,
        exportTable: body.exportTable,
        serviceAccount: sa.client_email,
        projectIds: body.projectIds,
        lastRunAt: null,
        lastError: null,
        message: 'Configured; the first comparison runs within six hours.',
      };
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/reconciliation',
    role: 'admin',
    tag: 'Spend',
    summary: 'Disconnect the billing export (keeps past results)',
    response: z.object({ deleted: z.boolean() }),
    handler: async ({ auth }) => {
      await ent.require('reconciliation', 'write');
      const rows = await ctx.db
        .delete(reconciliationConfigs)
        .where(eq(reconciliationConfigs.orgId, auth.orgId))
        .returning();
      if (rows.length) await audit(ctx, auth, 'reconciliation.delete', null);
      return { deleted: rows.length > 0 };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/reconciliation/report',
    role: 'viewer',
    tag: 'Spend',
    summary: 'Ledger vs billing export per billing day (Pacific time) and SKU family',
    query: z.object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    response: z.object({
      items: z.array(
        z.object({
          day: z.string(),
          family: z.string(),
          ledgerMicros: z.number(),
          billedMicros: z.number(),
          driftRatio: z.number().nullable(),
        }),
      ),
    }),
    handler: async ({ auth, query }) => {
      await ent.require('reconciliation', 'read');
      const where = [eq(reconciliationResults.orgId, auth.orgId)];
      if (query.from) where.push(gte(reconciliationResults.day, query.from));
      if (query.to) where.push(lt(reconciliationResults.day, query.to));
      const rows = await ctx.db
        .select()
        .from(reconciliationResults)
        .where(and(...where))
        .orderBy(desc(reconciliationResults.day), reconciliationResults.family)
        .limit(1000);
      return {
        items: rows.map((x) => ({
          day: x.day,
          family: x.family,
          ledgerMicros: n(x.ledgerMicros)!,
          billedMicros: n(x.billedMicros)!,
          driftRatio: x.driftRatio,
        })),
      };
    },
  });
}
