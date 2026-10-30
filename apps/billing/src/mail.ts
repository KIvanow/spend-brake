import { ALERT_QUEUE, QUEUE_PREFIX } from '@spend-brake/shared';
import type { ValkeyClient } from '@spend-brake/budget';
import { Queue } from 'bullmq';
import type { LicenseMail } from './webhooks.js';

/** License emails go through the notifier's queue (it holds the SMTP settings). */
export function licenseMailer(connection: ValkeyClient) {
  const queue = new Queue(ALERT_QUEUE, { connection, prefix: QUEUE_PREFIX });
  return {
    queue,
    send: async (m: LicenseMail) => {
      await queue.add(
        'license_issued',
        {
          type: 'license_issued',
          orgId: m.orgId,
          email: m.email,
          edition: m.edition,
          expiresAt: m.expiresAt,
          license: m.license,
        },
        {
          jobId: `license|${m.invoiceId}|${m.orgId}`,
          attempts: 50,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 2 * 24 * 3600 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      );
    },
  };
}
