import { ALERT_QUEUE, type AlertType, QUEUE_PREFIX } from '@spend-brake/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Metrics } from './metrics.js';

export type { AlertType };

export interface Alert {
  type: AlertType;
  orgId: string | null;
  /** Same id = same alert; BullMQ drops duplicates while the job is kept. */
  dedupeId: string;
  data: Record<string, unknown>;
}

export { ALERT_QUEUE };
export const ALERT_PREFIX = QUEUE_PREFIX;

/** Queues alert jobs for the notifier (Phase 5). Dedupe keys outlive the longest window (1 h). */
export class AlertQueue {
  readonly queue: Queue;

  constructor(
    connection: Redis,
    private readonly metrics: Metrics,
  ) {
    this.queue = new Queue(ALERT_QUEUE, { connection, prefix: ALERT_PREFIX });
  }

  async add(alerts: Alert[]): Promise<void> {
    if (alerts.length === 0) return;
    await this.queue.addBulk(
      alerts.map((a) => ({
        name: a.type,
        data: { type: a.type, orgId: a.orgId, ...a.data },
        opts: {
          jobId: a.dedupeId.replace(/:/g, '|'),
          attempts: 50,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 2 * 24 * 3600 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      })),
    );
    for (const a of alerts) this.metrics.alertsQueued.inc({ type: a.type });
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

const hour = (ms: number) => Math.floor(ms / 3_600_000);

/** Alerts a ledger event should raise (the design doc's alert table). */
export function alertsFor(orgId: string, streamId: string, e: Record<string, string>): Alert[] {
  const at = Number(streamId.split('-')[0]);
  const out: Alert[] = [];
  if (e.type === 'usage' && e.crossings) {
    for (const c of JSON.parse(e.crossings) as { scope: string; window: string; mark: string }[]) {
      out.push({
        type: 'threshold',
        orgId,
        dedupeId: `threshold:${orgId}:${c.scope}:${c.window}:${c.mark}`,
        data: { ...c, keyId: e.keyId },
      });
    }
  }
  if (e.type === 'blocked' && e.reason === 'budget_exceeded') {
    // First block per scope per hour.
    out.push({
      type: 'blocked',
      orgId,
      dedupeId: `blocked:${orgId}:${e.scope}:${hour(at)}`,
      data: { scope: e.scope, window: e.window, keyId: e.keyId, worstMicros: e.worstMicros },
    });
  }
  if (e.type === 'loop') {
    out.push({
      type: 'loop',
      orgId,
      dedupeId: `loop:${orgId}:${e.keyId}:${streamId}`,
      data: { keyId: e.keyId, session: e.session, hash: e.hash },
    });
  }
  // Settlement adjustments above the worst case mean the same thing (Twilio priced higher).
  if ((e.type === 'usage' || e.type === 'adjustment') && e.underpriced === '1') {
    out.push({
      type: 'catalog_underpriced',
      orgId,
      dedupeId: `underpriced:${orgId}:${streamId}`,
      data: { route: e.route, skus: e.skus, worstMicros: e.worstMicros, costMicros: e.costMicros },
    });
  }
  if (e.type === 'usage' && (e.keyError === '1' || e.status === '401' || e.status === '403')) {
    // The provider rejected our real key: first per provider per hour.
    out.push({
      type: 'upstream_key_error',
      orgId,
      dedupeId: `upstream_key:${orgId}:${e.provider}:${hour(at)}`,
      data: { provider: e.provider, status: e.status, keyId: e.keyId },
    });
  }
  return out;
}
