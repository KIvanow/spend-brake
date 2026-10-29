import { BudgetEngine, Registry } from '@spend-brake/budget';
import { loadGoogleMapsCatalog, loadMapboxCatalog, loadPlacesFields } from '@spend-brake/catalog';
import { type Db, ensureUsagePartitions, orgs, reconciliationConfigs } from '@spend-brake/db';
import {
  type Envelope,
  type KeyWrapper,
  billingExportContext,
  decryptSecret,
  redactText,
} from '@spend-brake/shared';
import type { Redis } from 'ioredis';
import { type Alert, AlertQueue } from './alerts.js';
import { checkSources, openDriftIssue } from './drift.js';
import { LedgerConsumer } from './ledger.js';
import { Metrics } from './metrics.js';
import {
  type BillingSource,
  bigQuerySource,
  daysToCheck,
  markRun,
  reconcileDay,
} from './reconcile.js';
import {
  type SettleResult,
  type TwilioDeps,
  reconcileTwilio,
  settleTwilioPending,
} from './twilio.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerDeps {
  db: Db;
  valkey: Redis;
  /** A separate connection for BullMQ (it needs maxRetriesPerRequest: null). */
  queueConnection: Redis;
  workerId: string;
  log: Logger;
  metrics?: Metrics;
  intervals?: {
    ledgerMs?: number;
    sweepMs?: number;
    driftMs?: number;
    orgsMs?: number;
    reconcileMs?: number;
    settleMs?: number;
  };
  /** For calls to providers (Twilio settlement and usage); tests inject one. */
  fetch?: typeof fetch;
  fetchPage?: (url: string) => Promise<string>;
  /** Decrypts billing-export service accounts; reconciliation is off without it. */
  wrapper?: KeyWrapper | null;
  billingSource?: (table: string, serviceAccountJson: string) => Promise<BillingSource>;
  github?: { repo: string; token: string };
  now?: () => Date;
}

// HERE's prices load client-side (no tables in the page), so its page cannot be checked here.
export function catalogSourceUrls(): string[] {
  return [loadGoogleMapsCatalog().source, loadPlacesFields().source, loadMapboxCatalog().source];
}

export class Worker {
  readonly metrics: Metrics;
  readonly alerts: AlertQueue;
  readonly ledger: LedgerConsumer;
  private readonly engine: BudgetEngine;
  private readonly timers: NodeJS.Timeout[] = [];
  private orgIds: string[] = [];
  private stopped = false;
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly deps: WorkerDeps) {
    this.metrics = deps.metrics ?? new Metrics();
    this.alerts = new AlertQueue(deps.queueConnection, this.metrics);
    this.engine = new BudgetEngine(deps.valkey);
    this.ledger = new LedgerConsumer(deps.db, deps.valkey, deps.workerId, async (rows, alerts) => {
      for (const r of rows) {
        this.metrics.ledgerEvents.inc({ type: r.type });
        if (r.costMicros)
          this.metrics.costMicros.inc({ provider: r.provider ?? '' }, Number(r.costMicros));
      }
      await this.alerts.add(alerts);
    });
  }

  private now = () => this.deps.now?.() ?? new Date();

  async refreshOrgs(): Promise<string[]> {
    this.orgIds = (await this.deps.db.select({ id: orgs.id }).from(orgs)).map((o) => o.id);
    return this.orgIds;
  }

  async ledgerOnce(): Promise<number> {
    const n = await this.ledger.runOnce(this.orgIds);
    this.metrics.ledgerLag.set(await this.ledger.lag(this.orgIds));
    this.metrics.lastLoop.set({ loop: 'ledger' }, Date.now() / 1000);
    return n;
  }

  /** Commit reservations the proxy never settled (it crashed or lost Valkey mid-request). */
  async sweepOnce(): Promise<number> {
    let committed = 0;
    const alerts: Alert[] = [];
    for (const orgId of this.orgIds) {
      const r = await this.engine.sweep(orgId, this.now());
      if (r.committed > 0) {
        committed += r.committed;
        alerts.push({
          type: 'reservations_expired',
          orgId,
          dedupeId: `swept:${orgId}:${Math.floor(this.now().getTime() / 3_600_000)}`,
          data: { committed: r.committed },
        });
      }
    }
    this.metrics.reservationsExpired.inc(committed);
    if (committed > 0) {
      this.deps.log.warn({ committed }, 'swept unsettled reservations at worst case');
    }
    await this.alerts.add(alerts);
    this.metrics.lastLoop.set({ loop: 'sweep' }, Date.now() / 1000);
    return committed;
  }

  async partitionsOnce(): Promise<void> {
    await ensureUsagePartitions(this.deps.db, this.now());
  }

  async driftOnce(): Promise<number> {
    const fetchPage =
      this.deps.fetchPage ??
      (async (url: string) => {
        const res = await fetch(url, { headers: { 'user-agent': 'spend-brake-catalog-check' } });
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        return res.text();
      });
    const results = await checkSources(this.deps.db, catalogSourceUrls(), fetchPage, this.now());
    const changed = results.filter((r) => r.changed);
    this.metrics.catalogDrift.inc(changed.length);
    await this.alerts.add(
      changed.map((r) => ({
        type: 'catalog_drift' as const,
        orgId: null,
        dedupeId: `drift:${r.hash}`,
        data: { url: r.url, previous: r.previous, hash: r.hash },
      })),
    );
    for (const r of changed) {
      this.deps.log.warn({ url: r.url }, 'catalog source changed; re-verify prices');
      if (this.deps.github) await openDriftIssue(this.deps.github.repo, this.deps.github.token, r);
    }
    return changed.length;
  }

  /** Settle Twilio sends at Twilio's final price (see twilio.ts). */
  async settleTwilioOnce(): Promise<SettleResult> {
    if (!this.deps.wrapper) return { settled: 0, deferred: 0, expired: 0 };
    return settleTwilioPending(this.twilioDeps(this.deps.wrapper), this.orgIds);
  }

  /** Twilio Usage Records vs the ledger for the last three UTC days. */
  async reconcileTwilioOnce(): Promise<number> {
    if (!this.deps.wrapper) return 0;
    const alerts = await reconcileTwilio(this.twilioDeps(this.deps.wrapper));
    await this.alerts.add(alerts);
    return alerts.length;
  }

  private twilioDeps(wrapper: KeyWrapper): TwilioDeps {
    return {
      db: this.deps.db,
      engine: this.engine,
      registry: new Registry(this.deps.valkey),
      wrapper,
      fetch: this.deps.fetch ?? fetch,
      now: this.now,
    };
  }

  /**
   * Compare the ledger with each configured org's Google billing export for the last few billing
   * days (the export lags); upserts results, alerts on drift above 5%.
   */
  async reconcileOnce(): Promise<number> {
    if (!this.deps.wrapper) return 0;
    const catalog = loadGoogleMapsCatalog();
    const configs = await this.deps.db.select().from(reconciliationConfigs);
    let checked = 0;
    for (const cfg of configs) {
      let saJson = '';
      try {
        saJson = await decryptSecret(
          this.deps.wrapper,
          cfg.envelope as Envelope,
          billingExportContext(cfg.orgId),
        );
        const source = await (this.deps.billingSource ?? bigQuerySource)(cfg.exportTable, saJson);
        const alerts: Alert[] = [];
        let latest: number | null = null;
        for (const day of daysToCheck(this.now(), catalog.billingTimeZone)) {
          const r = await reconcileDay(this.deps.db, source, catalog, cfg, day, this.now());
          latest ??= r.total.driftRatio;
          if (r.alert) alerts.push(r.alert);
          checked++;
        }
        if (latest !== null) this.metrics.reconcileDrift.set({ org: cfg.orgId }, latest);
        await this.alerts.add(alerts);
        await markRun(this.deps.db, cfg.orgId, this.now(), null);
      } catch (err) {
        // Errors are stored and logged: keep the service account's key out of them.
        const secrets = saJson
          ? [saJson, (JSON.parse(saJson) as { private_key?: string }).private_key ?? '']
          : [];
        const message = redactText((err as Error).message, secrets).slice(0, 500);
        this.deps.log.warn({ orgId: cfg.orgId, err: message }, 'reconciliation failed');
        await markRun(this.deps.db, cfg.orgId, this.now(), message);
      }
    }
    this.metrics.lastLoop.set({ loop: 'reconcile' }, Date.now() / 1000);
    return checked;
  }

  private every(ms: number, name: string, fn: () => Promise<unknown>): void {
    let busy = false;
    const tick = () => {
      if (busy || this.stopped) return;
      busy = true;
      const p = fn()
        .catch((err: unknown) =>
          this.deps.log.error({ loop: name, err: String(err) }, 'loop failed'),
        )
        .finally(() => {
          busy = false;
          this.running.delete(p);
        });
      this.running.add(p);
    };
    this.timers.push(setInterval(tick, ms));
    tick();
  }

  async start(): Promise<void> {
    const i = this.deps.intervals ?? {};
    await this.partitionsOnce();
    await this.refreshOrgs();
    this.every(i.orgsMs ?? 30_000, 'orgs', () => this.refreshOrgs());
    this.every(i.ledgerMs ?? 500, 'ledger', () => this.ledgerOnce());
    this.every(60_000, 'ledger-claim', () => this.ledger.claimStale(this.orgIds));
    this.every(i.sweepMs ?? 10_000, 'sweep', () => this.sweepOnce());
    this.every(6 * 3600_000, 'partitions', () => this.partitionsOnce());
    this.every(i.driftMs ?? 24 * 3600_000, 'drift', () => this.driftOnce());
    this.every(i.reconcileMs ?? 6 * 3600_000, 'reconcile', () => this.reconcileOnce());
    this.every(i.settleMs ?? 60_000, 'twilio-settle', () => this.settleTwilioOnce());
    this.every(i.reconcileMs ?? 6 * 3600_000, 'twilio-reconcile', () => this.reconcileTwilioOnce());
    this.deps.log.info({ workerId: this.deps.workerId }, 'worker started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled([...this.running]);
    await this.alerts.close();
  }
}
