import type { WorkerHost } from '@spend-brake/worker';
import { describe, expect, it } from 'vitest';
import type { Entitlements } from '../src/entitlements.js';
import { eeJobs } from '../src/worker/index.js';

describe('ee worker jobs', () => {
  it('do nothing unless the license allows their feature', async () => {
    const asked: string[] = [];
    const ent = {
      can: (feature: string, mode: string) => {
        asked.push(`${feature}:${mode}`);
        return Promise.resolve(false);
      },
    } as unknown as Entitlements;
    let wrote = false;
    const jobs = eeJobs({
      entitlements: ent,
      auditSinks: [{ name: 'x', write: () => Promise.resolve(void (wrote = true)) }],
      catalogFeed: { url: 'https://feed.example/x', dir: '/nonexistent' },
    });
    expect(jobs.map((j) => j.name)).toEqual([
      'reconcile',
      'twilio-reconcile',
      'audit-export',
      'catalog-feed',
    ]);
    // A host that throws on use: none of it may be touched.
    const host = new Proxy(
      {},
      {
        get: () => {
          throw new Error('touched');
        },
      },
    ) as WorkerHost;
    for (const job of jobs) await job.run(host);
    expect(wrote).toBe(false);
    expect(asked).toEqual([
      'reconciliation:write',
      'reconciliation:write',
      'audit_export:read',
      'catalog_feed:write',
    ]);
  });
});
