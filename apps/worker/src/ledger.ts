import { type Db, usageEvents } from '@spend-brake/db';
import type { ValkeyClient as Redis } from '@spend-brake/budget';
import { type Alert, alertsFor } from './alerts.js';

export const LEDGER_GROUP = 'ledger';

// Fields with their own columns; everything else goes into `data`.
const COLUMNS = new Set([
  'type',
  'reqId',
  'keyId',
  'provider',
  'route',
  'skus',
  'worstMicros',
  'costMicros',
  'status',
  'latencyMs',
  'session',
  'env',
  'agentId',
  'underpriced',
  'hash',
]);

// Signed: settlement adjustments carry negative costs.
const big = (v: string | undefined) => (v === undefined || !/^-?\d+$/.test(v) ? null : BigInt(v));
const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));

export function toRow(orgId: string, streamId: string, f: Record<string, string>) {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (COLUMNS.has(k)) continue;
    data[k] = k === 'crossings' ? (JSON.parse(v) as unknown) : v;
  }
  return {
    orgId,
    ts: new Date(Number(streamId.split('-')[0])),
    streamId,
    type: f.type ?? 'unknown',
    reqId: f.reqId ?? null,
    keyId: f.keyId ?? null,
    provider: f.provider ?? null,
    route: f.route ?? null,
    sku: f.skus?.split(',')[0] ?? null,
    skus: f.skus ?? null,
    worstMicros: big(f.worstMicros),
    costMicros: big(f.costMicros),
    status: num(f.status),
    latencyMs: num(f.latencyMs),
    session: f.session ?? null,
    env: f.env ?? null,
    agentId: f.agentId ?? null,
    underpriced: f.underpriced === '1',
    hash: f.hash ?? null,
    data,
  };
}

export type LedgerRow = ReturnType<typeof toRow>;

const fieldsOf = (flat: string[]) => {
  const o: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) o[flat[i]!] = flat[i + 1]!;
  return o;
};

const pairs = (flat: unknown[]): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) o[String(flat[i])] = flat[i + 1];
  return o;
};

type StreamReply = [string, [string, string[]][]][] | null;

/**
 * Moves each org's usage stream into the Postgres ledger through a consumer group: read, insert
 * (idempotent on org/ts/stream id), then ack. A crash between insert and ack replays the batch,
 * which the primary key absorbs. Entries a dead consumer left pending are claimed after a minute.
 */
export class LedgerConsumer {
  private readonly groups = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly valkey: Redis,
    private readonly consumer: string,
    /** `fresh`: the rows this write recorded first (a replayed batch has none). */
    private readonly onRows: (
      rows: LedgerRow[],
      alerts: Alert[],
      fresh: LedgerRow[],
    ) => Promise<void> = async () => {},
    private readonly batch = 500,
  ) {}

  private stream = (orgId: string) => `bk:{o:${orgId}}:events`;

  private async ensureGroup(orgId: string): Promise<void> {
    if (this.groups.has(orgId)) return;
    try {
      // From the start of the stream, so events written before the first worker run are kept.
      await this.valkey.xgroup('CREATE', this.stream(orgId), LEDGER_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
    this.groups.add(orgId);
  }

  /** Process one batch per org; returns how many events were written. */
  async runOnce(orgIds: readonly string[]): Promise<number> {
    let total = 0;
    for (const orgId of orgIds) {
      await this.ensureGroup(orgId);
      const key = this.stream(orgId);
      // Own pending entries first (a previous run that died before acking), then new ones.
      for (const from of ['0', '>']) {
        const reply = (await this.valkey.xreadgroup(
          'GROUP',
          LEDGER_GROUP,
          this.consumer,
          'COUNT',
          this.batch,
          'STREAMS',
          key,
          from,
        )) as StreamReply;
        total += await this.write(orgId, reply?.[0]?.[1] ?? []);
      }
    }
    return total;
  }

  /** Take over entries other consumers left unacked for longer than `idleMs`. */
  async claimStale(orgIds: readonly string[], idleMs = 60_000): Promise<number> {
    let total = 0;
    for (const orgId of orgIds) {
      await this.ensureGroup(orgId);
      const reply = (await this.valkey.xautoclaim(
        this.stream(orgId),
        LEDGER_GROUP,
        this.consumer,
        idleMs,
        '0-0',
        'COUNT',
        this.batch,
      )) as [string, [string, string[]][]];
      total += await this.write(
        orgId,
        reply[1].filter((e) => e[1] !== null),
      );
    }
    return total;
  }

  private async write(orgId: string, entries: [string, string[]][]): Promise<number> {
    if (entries.length === 0) return 0;
    const rows: LedgerRow[] = [];
    const alerts: Alert[] = [];
    for (const [streamId, flat] of entries) {
      const f = fieldsOf(flat);
      rows.push(toRow(orgId, streamId, f));
      alerts.push(...alertsFor(orgId, streamId, f));
    }
    const inserted = await this.db
      .insert(usageEvents)
      .values(rows)
      .onConflictDoNothing()
      .returning({ streamId: usageEvents.streamId });
    const firstTime = new Set(inserted.map((r) => r.streamId));
    await this.onRows(
      rows,
      alerts,
      rows.filter((r) => firstTime.has(r.streamId)),
    );
    await this.valkey.xack(this.stream(orgId), LEDGER_GROUP, ...entries.map((e) => e[0]));
    await this.trim(orgId);
    return rows.length;
  }

  /**
   * Drop stream entries the ledger has consumed: everything before the oldest pending entry, or
   * before the group's last delivered id when nothing is pending. Unconsumed events are never
   * trimmed here (the producer's MAXLEN is only a memory backstop).
   */
  async trim(orgId: string): Promise<void> {
    const key = this.stream(orgId);
    const pending = (await this.valkey.xpending(key, LEDGER_GROUP)) as [number, string | null];
    let minId = pending[0] > 0 ? pending[1] : null;
    if (!minId) {
      const groups = (await this.valkey.xinfo('GROUPS', key)) as unknown[][];
      const g = groups.map(pairs).find((x) => x.name === LEDGER_GROUP);
      minId = (g?.['last-delivered-id'] as string | undefined) ?? null;
    }
    if (minId && minId !== '0-0') await this.valkey.xtrim(key, 'MINID', minId);
  }

  /** Entries not yet delivered to the ledger, summed over orgs (XINFO GROUPS `lag`). */
  async lag(orgIds: readonly string[]): Promise<number> {
    let total = 0;
    for (const orgId of orgIds) {
      try {
        const key = this.stream(orgId);
        const groups = (await this.valkey.xinfo('GROUPS', key)) as unknown[][];
        const g = groups.map(pairs).find((x) => x.name === LEDGER_GROUP);
        // No group yet: nothing has been consumed.
        total += g ? Number(g.lag ?? 0) : await this.valkey.xlen(key);
      } catch {
        // no stream yet
      }
    }
    return total;
  }
}
