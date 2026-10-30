import { BudgetEngine, Registry } from '@spend-brake/budget';
import {
  loadExaCatalog,
  loadGoogleMapsCatalog,
  loadPlacesFields,
  loadTavilyCatalog,
} from '@spend-brake/catalog';
import { type Db, ensureUsagePartitions, orgs } from '@spend-brake/db';
import type { KeyWrapper } from '@spend-brake/shared';
import type { Redis } from 'ioredis';
import { type Alert, AlertQueue } from './alerts.js';
import { checkSources, openDriftIssue } from './drift.js';
import { LedgerConsumer } from './ledger.js';
import { Metrics } from './metrics.js';
import { type SettleResult, type TwilioDeps, settleTwilioPending } from './twilio.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerHost {
  db: Db;
  valkey: Redis;
  engine: BudgetEngine;
  alerts: AlertQueue;
  metrics: Metrics;
  log: Logger;
  wrapper: KeyWrapper | null;
  fetch: typeof fetch;
  now: () => Date;
  /** Orgs as of the last refresh. */
  orgIds: () => string[];
  /** Twilio calls with this worker's credentials; null without a key wrapper. */
  twilio: TwilioDeps | null;
}

/** A loop the worker runs every `everyMs` (errors are logged, never overlap). */
export interface WorkerJob {
  name: string;
  everyMs: number;
  run(host: WorkerHost): Promise<unknown>;
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
    settleMs?: number;
  };
  /** For calls to providers (Twilio settlement and usage); tests inject one. */
  fetch?: typeof fetch;
  fetchPage?: (url: string) => Promise<string>;
  /** Decrypts provider credentials; Twilio settlement is off without it. */
  wrapper?: KeyWrapper | null;
  /** More loops (separately licensed features plug in here). */
  jobs?: WorkerJob[];
  github?: { repo: string; token: string };
  now?: () => Date;
}

// Mapbox, HERE, Brave and SerpApi render their price tables client-side (no <table> in the page
// HTML), so their pages cannot be checked this way; re-verify those catalogs by hand.
export function catalogSourceUrls(): string[] {
  return [
    loadGoogleMapsCatalog().source,
    loadPlacesFields().source,
    loadTavilyCatalog().source,
    loadExaCatalog().source,
  ];
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

  /** What an extra job gets to work with. */
  host(): WorkerHost {
    return {
      db: this.deps.db,
      valkey: this.deps.valkey,
      engine: this.engine,
      alerts: this.alerts,
      metrics: this.metrics,
      log: this.deps.log,
      wrapper: this.deps.wrapper ?? null,
      fetch: this.deps.fetch ?? fetch,
      now: this.now,
      orgIds: () => this.orgIds,
      twilio: this.deps.wrapper ? this.twilioDeps(this.deps.wrapper) : null,
    };
  }

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
    for (const r of results.filter((x) => x.tables === 0)) {
      this.deps.log.warn(
        { url: r.url },
        'catalog source has no price tables; cannot detect changes',
      );
    }
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

  twilioDeps(wrapper: KeyWrapper): TwilioDeps {
    return {
      db: this.deps.db,
      engine: this.engine,
      registry: new Registry(this.deps.valkey),
      wrapper,
      valkey: this.deps.valkey,
      fetch: this.deps.fetch ?? fetch,
      now: this.now,
      log: this.deps.log,
    };
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
    this.every(i.settleMs ?? 60_000, 'twilio-settle', () => this.settleTwilioOnce());
    for (const job of this.deps.jobs ?? []) {
      this.every(job.everyMs, job.name, () => job.run(this.host()));
    }
    this.deps.log.info({ workerId: this.deps.workerId }, 'worker started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled([...this.running]);
    await this.alerts.close();
  }
}
