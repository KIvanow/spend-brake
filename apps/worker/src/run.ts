import { type Db, createDb, migrate } from '@spend-brake/db';
import { keyWrapperFromEnv } from '@spend-brake/shared';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadEnv } from './config.js';
import { Metrics } from './metrics.js';
import { Worker, type WorkerJob } from './worker.js';

export interface RunWorkerOptions {
  /** Runs after the core migrations (e.g. more migrations). */
  prepare?: (db: Db) => Promise<void>;
  jobs?: (db: Db) => WorkerJob[];
}

/** Start the worker from the environment (the `main` of the core and extended builds). */
export async function runWorker(opts: RunWorkerOptions = {}): Promise<void> {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL });
  const { db, pool } = createDb(env.DATABASE_URL);
  await migrate(db);
  await opts.prepare?.(db);
  const valkey = new Redis(env.VALKEY_URL);
  const queueConnection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null });
  const metrics = new Metrics();
  const server = metrics.serve(env.METRICS_PORT);

  const worker = new Worker({
    wrapper: await keyWrapperFromEnv(process.env),
    db,
    valkey,
    queueConnection,
    workerId: env.WORKER_ID,
    log,
    metrics,
    intervals: {
      ledgerMs: env.LEDGER_INTERVAL_MS,
      sweepMs: env.SWEEP_INTERVAL_MS,
      driftMs: env.DRIFT_INTERVAL_MS,
    },
    jobs: opts.jobs?.(db) ?? [],
    ...(env.GITHUB_TOKEN && env.GITHUB_REPO
      ? { github: { repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN } }
      : {}),
  });
  await worker.start();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void worker
        .stop()
        .then(() => Promise.all([valkey.quit(), queueConnection.quit(), pool.end()]))
        .then(() => server.close())
        .then(() => process.exit(0));
    });
  }
}
