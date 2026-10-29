import { ALERT_QUEUE, type AlertJob, QUEUE_PREFIX } from '@spend-brake/shared';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  type DeliveryJob,
  type ProcessorDeps,
  processAlert,
  processDelivery,
} from './processors.js';

export const DELIVERY_QUEUE = 'deliveries';

/** Delays between delivery attempts: 10 s doubling to 1 h, then hourly; about 24 h in total. */
export const DELIVERY_ATTEMPTS = 31;
export const deliveryBackoff = (attemptsMade: number, scale = 1) =>
  Math.min(10_000 * 2 ** (attemptsMade - 1), 3_600_000) * scale;

export interface NotifierQueues {
  deliveries: Queue<DeliveryJob>;
  start(deps: Omit<ProcessorDeps, 'deliveries'>): void;
  close(): Promise<void>;
}

/** Wire the alert and delivery queues to their processors. `backoffScale` shortens retries in tests. */
export function notifierQueues(connection: Redis, backoffScale = 1): NotifierQueues {
  const deliveries = new Queue<DeliveryJob>(DELIVERY_QUEUE, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: DELIVERY_ATTEMPTS,
      backoff: { type: 'brake' },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
  const workers: Worker[] = [];
  return {
    deliveries,
    start(base) {
      const deps: ProcessorDeps = { ...base, deliveries };
      workers.push(
        new Worker<AlertJob>(ALERT_QUEUE, (job) => processAlert(deps, job.id!, job.data), {
          connection,
          prefix: QUEUE_PREFIX,
          concurrency: 8,
        }),
        new Worker<DeliveryJob>(
          DELIVERY_QUEUE,
          (job) => processDelivery(deps, job.data, job.attemptsMade + 1),
          {
            connection,
            prefix: QUEUE_PREFIX,
            concurrency: 16,
            settings: {
              backoffStrategy: (attemptsMade) => deliveryBackoff(attemptsMade, backoffScale),
            },
          },
        ),
      );
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await deliveries.close();
    },
  };
}
