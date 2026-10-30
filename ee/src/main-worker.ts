// The worker with the commercial features. Core-only installs run apps/worker instead.
import { runWorker } from '@spend-brake/worker';
import { auditSinksFrom, loadEeEnv } from './config.js';
import { Entitlements } from './entitlements.js';
import { migrateEe } from './migrate.js';
import { eeJobs } from './worker/index.js';

const env = loadEeEnv();
if (env.BRAKE_CATALOG_FEED_URL && !env.BRAKE_CATALOG_DIR) {
  throw new Error('BRAKE_CATALOG_FEED_URL needs BRAKE_CATALOG_DIR (shared with the proxy)');
}

await runWorker({
  prepare: migrateEe,
  jobs: (db) =>
    eeJobs({
      entitlements: new Entitlements(db),
      auditSinks: auditSinksFrom(env),
      ...(env.BRAKE_CATALOG_FEED_URL && env.BRAKE_CATALOG_DIR
        ? { catalogFeed: { url: env.BRAKE_CATALOG_FEED_URL, dir: env.BRAKE_CATALOG_DIR } }
        : {}),
    }),
});
