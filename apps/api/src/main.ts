import { createDb, migrate } from '@spend-brake/db';
import { keyWrapperFromEnv, redactingLoggerOptions } from '@spend-brake/shared';
import { Redis } from 'ioredis';
import { loadEnv } from './config.js';
import { resyncValkey } from './resync.js';
import { apiContext, buildApi } from './server.js';

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
await migrate(db);
const valkey = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 2 });

// Postgres is the source of truth: heal Valkey (lost data, half-finished writes) before serving.
const wrapper = await keyWrapperFromEnv(process.env);
const synced = await resyncValkey(apiContext({ db, valkey, wrapper }));

const app = await buildApi({
  db,
  valkey,
  wrapper,
  logger: redactingLoggerOptions(env.LOG_LEVEL),
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  trustProxy: env.TRUST_PROXY,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => Promise.all([valkey.quit(), pool.end()]))
      .then(() => process.exit(0));
  });
}

app.log.info(synced, 'valkey resynced from postgres');
await app.listen({ port: env.PORT, host: env.HOST });
