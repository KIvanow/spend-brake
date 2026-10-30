import type { WorkerHost, WorkerJob } from '@spend-brake/worker';
import type { Entitlements } from '../entitlements.js';
import { exportAudit } from '../audit/export.js';
import type { AuditSink } from '../audit/sinks.js';
import { type FeedOptions, syncCatalogFeed } from '../feed/feed.js';
import {
  type BillingSourceFactory,
  reconcileGoogle,
  reconcileTwilioUsage,
} from '../reconciliation/jobs.js';

export interface EeWorkerOptions {
  entitlements: Entitlements;
  auditSinks?: AuditSink[];
  catalogFeed?: FeedOptions;
  billingSource?: BillingSourceFactory;
  intervals?: { reconcileMs?: number; auditMs?: number; feedMs?: number };
}

/** The worker loops ee/ adds; each runs only while the license allows its feature. */
export function eeJobs(opts: EeWorkerOptions): WorkerJob[] {
  const ent = opts.entitlements;
  const i = opts.intervals ?? {};
  const jobs: WorkerJob[] = [
    {
      name: 'reconcile',
      everyMs: i.reconcileMs ?? 6 * 3600_000,
      run: async (host: WorkerHost) =>
        (await ent.can('reconciliation', 'write')) ? reconcileGoogle(host, opts.billingSource) : 0,
    },
    {
      name: 'twilio-reconcile',
      everyMs: i.reconcileMs ?? 6 * 3600_000,
      run: async (host: WorkerHost) =>
        (await ent.can('reconciliation', 'write')) ? reconcileTwilioUsage(host) : 0,
    },
  ];
  const sinks = opts.auditSinks ?? [];
  if (sinks.length) {
    jobs.push({
      name: 'audit-export',
      everyMs: i.auditMs ?? 60_000,
      run: async (host: WorkerHost) =>
        (await ent.can('audit_export', 'write'))
          ? exportAudit(host.db, sinks, host.now, host.log)
          : {},
    });
  }
  const feed = opts.catalogFeed;
  if (feed) {
    jobs.push({
      name: 'catalog-feed',
      everyMs: i.feedMs ?? 24 * 3600_000,
      run: async (host: WorkerHost) => {
        if (!(await ent.can('catalog_feed', 'write'))) return null;
        const r = await syncCatalogFeed(host.db, feed, host.now());
        if (r.applied) {
          host.log.info({ version: r.version, changes: r.changes.length }, 'catalog updated');
          if (r.changes.length) {
            await host.alerts.add([
              {
                type: 'catalog_price_change',
                orgId: null,
                dedupeId: `catalog:${r.version}`,
                data: { version: r.version, changes: r.changes },
              },
            ]);
          }
        }
        return r;
      },
    });
  }
  return jobs;
}
