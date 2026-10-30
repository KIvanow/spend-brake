import { loadGoogleMapsCatalog } from '@spend-brake/catalog';
import { reconciliationConfigs } from '@spend-brake/db';
import {
  type Envelope,
  billingExportContext,
  decryptSecret,
  redactText,
} from '@spend-brake/shared';
import type { Alert, WorkerHost } from '@spend-brake/worker';
import {
  type BillingSource,
  bigQuerySource,
  daysToCheck,
  markRun,
  reconcileDay,
} from './google.js';
import { reconcileTwilio } from './twilio.js';

export type BillingSourceFactory = (
  table: string,
  serviceAccountJson: string,
) => Promise<BillingSource>;

/**
 * Compare the ledger with each configured org's Google billing export for the last few billing
 * days (the export lags); upserts results, alerts on drift above 5%.
 */
export async function reconcileGoogle(
  host: WorkerHost,
  billingSource: BillingSourceFactory = bigQuerySource,
): Promise<number> {
  if (!host.wrapper) return 0;
  const catalog = loadGoogleMapsCatalog();
  const configs = await host.db.select().from(reconciliationConfigs);
  let checked = 0;
  for (const cfg of configs) {
    let saJson = '';
    try {
      saJson = await decryptSecret(
        host.wrapper,
        cfg.envelope as Envelope,
        billingExportContext(cfg.orgId),
      );
      const source = await billingSource(cfg.exportTable, saJson);
      const alerts: Alert[] = [];
      let latest: number | null = null;
      for (const day of daysToCheck(host.now(), catalog.billingTimeZone)) {
        const r = await reconcileDay(host.db, source, catalog, cfg, day, host.now());
        latest ??= r.total.driftRatio;
        if (r.alert) alerts.push(r.alert);
        checked++;
      }
      if (latest !== null) host.metrics.reconcileDrift.set({ org: cfg.orgId }, latest);
      await host.alerts.add(alerts);
      await markRun(host.db, cfg.orgId, host.now(), null);
    } catch (err) {
      // Errors are stored and logged: keep the service account's key out of them.
      const secrets = saJson
        ? [saJson, (JSON.parse(saJson) as { private_key?: string }).private_key ?? '']
        : [];
      const message = redactText((err as Error).message, secrets).slice(0, 500);
      host.log.warn({ orgId: cfg.orgId, err: message }, 'reconciliation failed');
      await markRun(host.db, cfg.orgId, host.now(), message);
    }
  }
  host.metrics.lastLoop.set({ loop: 'reconcile' }, Date.now() / 1000);
  return checked;
}

/** Twilio Usage Records vs the ledger for the last three UTC days. */
export async function reconcileTwilioUsage(host: WorkerHost): Promise<number> {
  if (!host.twilio) return 0;
  const alerts = await reconcileTwilio(host.twilio);
  await host.alerts.add(alerts);
  return alerts.length;
}
