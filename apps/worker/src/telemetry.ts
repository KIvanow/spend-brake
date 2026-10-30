// Each org's own telemetry: Prometheus counters (rendered by the admin API at /v1/metrics) and
// OpenTelemetry spans sent to the org's collector. Never on the request path: the worker does it
// as calls reach the ledger.
import type { ValkeyClient as Redis } from '@spend-brake/budget';
import { type Db, eq, telemetryExports } from '@spend-brake/db';
import {
  type CallRecord,
  type Envelope,
  type GuardedClient,
  type KeyWrapper,
  OTLP_QUEUE_MAX,
  callIncrements,
  callSpan,
  decryptSecret,
  orgMetricsKey,
  otlpHeadersContext,
  otlpQueueKey,
  postSpans,
} from '@spend-brake/shared';
import type { LedgerRow } from './ledger.js';

const toCall = (r: LedgerRow): CallRecord => r;

/** Count calls into their orgs' metrics (only rows the ledger recorded for the first time). */
export async function countCalls(valkey: Redis, rows: LedgerRow[]): Promise<void> {
  if (rows.length === 0) return;
  const batch = valkey.multi();
  let n = 0;
  for (const row of rows) {
    for (const [field, by] of callIncrements(toCall(row))) {
      batch.hincrby(orgMetricsKey(row.orgId), field, by);
      n++;
    }
  }
  if (n > 0) await batch.exec();
}

const BATCH = 500;
const CONFIG_TTL_MS = 30_000;
/** How often to write the last success to Postgres (it is shown in the dashboard). */
const STATUS_EVERY_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface Exporter {
  endpoint: string;
  headers: Record<string, string> | null;
}

/**
 * Sends each exporting org's calls to its collector as spans. Spans wait in a bounded per-org
 * Valkey list, so a collector that is down delays them (retried with backoff) without holding up
 * the ledger; past OTLP_QUEUE_MAX the oldest are dropped.
 */
export class OtlpExporter {
  private config = new Map<string, Exporter>();
  private loadedAt = 0;
  private failures = new Map<string, { count: number; until: number }>();
  private statusAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      db: Db;
      valkey: Redis;
      wrapper: KeyWrapper | null;
      dispatcher: GuardedClient;
      now: () => Date;
      log: { warn(obj: object, msg: string): void };
      workerId: string;
    },
  ) {}

  private async exporters(): Promise<Map<string, Exporter>> {
    const now = this.deps.now().getTime();
    if (now - this.loadedAt < CONFIG_TTL_MS) return this.config;
    const rows = await this.deps.db
      .select({ orgId: telemetryExports.orgId, endpoint: telemetryExports.endpoint })
      .from(telemetryExports)
      .where(eq(telemetryExports.enabled, true));
    const next = new Map<string, Exporter>();
    for (const r of rows) {
      // Headers are decrypted when sending; an endpoint change resets them.
      const old = this.config.get(r.orgId);
      next.set(r.orgId, {
        endpoint: r.endpoint,
        headers: old?.endpoint === r.endpoint ? old.headers : null,
      });
    }
    this.config = next;
    this.loadedAt = now;
    return next;
  }

  /** Forget cached settings (tests; the API changing them takes effect within 30 s anyway). */
  reload(): void {
    this.loadedAt = 0;
  }

  /** Queue spans for orgs that export (only rows the ledger recorded for the first time). */
  async enqueue(rows: LedgerRow[]): Promise<void> {
    if (rows.length === 0) return;
    const exporting = await this.exporters();
    const byOrg = new Map<string, string[]>();
    for (const row of rows) {
      if (!exporting.has(row.orgId)) continue;
      if (row.type !== 'usage' && row.type !== 'blocked' && row.type !== 'loop') continue;
      const list = byOrg.get(row.orgId) ?? [];
      list.push(JSON.stringify(callSpan(toCall(row))));
      byOrg.set(row.orgId, list);
    }
    for (const [orgId, spans] of byOrg) {
      await this.deps.valkey
        .multi()
        .lpush(otlpQueueKey(orgId), ...spans)
        .ltrim(otlpQueueKey(orgId), 0, OTLP_QUEUE_MAX - 1)
        .exec();
    }
  }

  /** One pass: send up to a batch per org whose collector is not backing off. */
  async runOnce(): Promise<number> {
    const exporting = await this.exporters();
    let sent = 0;
    for (const [orgId, exp] of exporting) {
      const now = this.deps.now().getTime();
      if ((this.failures.get(orgId)?.until ?? 0) > now) continue;
      const queue = otlpQueueKey(orgId);
      // One worker per org at a time (several workers may run).
      const lock = `${queue}:lock`;
      if ((await this.deps.valkey.set(lock, this.deps.workerId, 'PX', 30_000, 'NX')) !== 'OK') {
        continue;
      }
      try {
        // The oldest spans are at the tail.
        const raw = await this.deps.valkey.lrange(queue, -BATCH, -1);
        if (raw.length === 0) continue;
        const headers = exp.headers ?? (await this.headersOf(orgId));
        if (headers === null) continue;
        exp.headers = headers;
        const spans = raw.reverse().map((s) => JSON.parse(s) as ReturnType<typeof callSpan>);
        const result = await postSpans(exp.endpoint, headers, orgId, spans, {
          dispatcher: this.deps.dispatcher,
        });
        if (result.ok) {
          await this.deps.valkey.ltrim(queue, 0, -raw.length - 1);
          this.failures.delete(orgId);
          sent += raw.length;
          await this.status(orgId, null);
        } else {
          const count = (this.failures.get(orgId)?.count ?? 0) + 1;
          this.failures.set(orgId, {
            count,
            until: now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** count),
          });
          await this.status(orgId, result.error ?? 'export failed');
        }
      } finally {
        await this.deps.valkey.del(lock);
      }
    }
    return sent;
  }

  private async headersOf(orgId: string): Promise<Record<string, string> | null> {
    if (!this.deps.wrapper) {
      this.deps.log.warn({ orgId }, 'otlp export needs the master key to decrypt headers');
      return null;
    }
    const [row] = await this.deps.db
      .select({ envelope: telemetryExports.headersEnvelope })
      .from(telemetryExports)
      .where(eq(telemetryExports.orgId, orgId))
      .limit(1);
    if (!row) return null;
    const json = await decryptSecret(
      this.deps.wrapper,
      row.envelope as Envelope,
      otlpHeadersContext(orgId),
    );
    return JSON.parse(json) as Record<string, string>;
  }

  /** Record the outcome for the dashboard: every error, successes at most once a minute. */
  private async status(orgId: string, error: string | null): Promise<void> {
    const now = this.deps.now();
    if (error === null) {
      const last = this.statusAt.get(orgId) ?? 0;
      if (now.getTime() - last < STATUS_EVERY_MS) return;
      this.statusAt.set(orgId, now.getTime());
    }
    await this.deps.db
      .update(telemetryExports)
      .set(
        error === null
          ? { lastSuccessAt: now }
          : { lastError: error.slice(0, 300), lastErrorAt: now },
      )
      .where(eq(telemetryExports.orgId, orgId));
  }
}
