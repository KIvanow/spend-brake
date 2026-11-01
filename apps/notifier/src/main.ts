import { connectValkey } from '@spend-brake/budget';
import { createDb } from '@spend-brake/db';
import { keyWrapperFromEnv, onShutdownSignal } from '@spend-brake/shared';
import { createTransport } from 'nodemailer';
import pino from 'pino';
import { loadEnv } from './config.js';
import { guardedAgent } from './deliver.js';
import { notifierQueues } from './notifier.js';
import { buildServer, notifierLoggerOptions } from './server.js';

// Docker stops a container 10 s after SIGTERM; exit on our own before that.
const SHUTDOWN_TIMEOUT_MS = 9_000;

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const wrapper = await keyWrapperFromEnv(process.env);
if (!wrapper)
  throw new Error('Set BRAKE_MASTER_KEY or BRAKE_KMS_KEY_ID (webhook URLs are encrypted).');
const { db, pool } = createDb(env.DATABASE_URL);
const valkey = connectValkey(env.VALKEY_URL);
const queueConnection = connectValkey(env.VALKEY_URL, { maxRetriesPerRequest: null });

const queues = notifierQueues(queueConnection);
queues.start({
  db,
  valkey,
  wrapper,
  dispatcher: guardedAgent(env.ALLOW_PRIVATE_WEBHOOKS),
  links: {
    publicUrl: env.BRAKE_PUBLIC_URL,
    dashboardUrl: env.BRAKE_DASHBOARD_URL,
    actionSecret: env.BRAKE_ACTION_SECRET,
    ttlSec: env.BRAKE_ACTION_TTL_SEC,
    maxCustomMicros: BigInt(Math.round(env.BRAKE_MAX_CUSTOM_RAISE_USD)) * 1_000_000n,
    now: () => new Date(),
  },
  mail: env.SMTP_URL
    ? {
        transport: createTransport(env.SMTP_URL),
        from: env.BRAKE_EMAIL_FROM,
        operator: env.OPERATOR_EMAIL,
      }
    : undefined,
  log,
});

const app = buildServer({
  db,
  apiUrl: env.BRAKE_API_URL,
  actionSecret: env.BRAKE_ACTION_SECRET,
  dashboardUrl: env.BRAKE_DASHBOARD_URL,
  logger: notifierLoggerOptions(env.LOG_LEVEL),
});

onShutdownSignal(
  async () => {
    await app.close();
    await queues.close();
    await Promise.all([valkey.quit(), queueConnection.quit(), pool.end()]);
  },
  {
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    onError: (err, msg) => app.log.error({ err: (err as Error).message }, msg),
  },
);

await app.listen({ port: env.PORT, host: env.HOST });
