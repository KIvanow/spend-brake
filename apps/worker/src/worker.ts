import { BudgetEngine } from '@spend-brake/budget';
import { loadGoogleMapsCatalog, loadPlacesFields } from '@spend-brake/catalog';
import { type Db, ensureUsagePartitions, orgs } from '@spend-brake/db';
import type { Redis } from 'ioredis';
import { type Alert, AlertQueue } from './alerts.js';
import { checkSources, openDriftIssue } from './drift.js';
import { LedgerConsumer } from './ledger.js';
import { Metrics } from './metrics.js';

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
  intervals?: { ledgerMs?: number; sweepMs?: number; driftMs?: number; orgsMs?: number };
  fetchPage?: (url: string) => Promise<string>;
  github?: { repo: string; token: string };
  now?: () => Date;
}

export function catalogSourceUrls(): string[] {
  return [loadGoogleMapsCatalog().source, loadPlacesFields().source];
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
    this.deps.log.info({ workerId: this.deps.workerId }, 'worker started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled([...this.running]);
    await this.alerts.close();
  }
}
