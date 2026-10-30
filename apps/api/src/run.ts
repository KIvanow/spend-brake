import { type ValkeyClient, connectValkey } from '@spend-brake/budget';
import { type Db, createDb, migrate } from '@spend-brake/db';
import { keyWrapperFromEnv, redactingLoggerOptions } from '@spend-brake/shared';
import { loadEnv } from './config.js';
import { checkGoogleKey } from './google-check.js';
import { resyncValkey } from './resync.js';
import { type ApiExtension, apiContext, buildApi } from './server.js';

export interface RunApiOptions {
  /** Runs after the core migrations, before the server is built (e.g. more migrations). */
  prepare?: (db: Db) => Promise<void>;
  extensions?: (db: Db, valkey: ValkeyClient) => ApiExtension[] | Promise<ApiExtension[]>;
}

/** Start the admin API from the environment (the `main` of the core and extended builds). */
export async function runApi(opts: RunApiOptions = {}): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  await migrate(db);
  await opts.prepare?.(db);
  const valkey = connectValkey(env.VALKEY_URL, { maxRetriesPerRequest: 2 });

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
    ...(env.BRAKE_ACTION_SECRET ? { actionSecret: env.BRAKE_ACTION_SECRET } : {}),
    ...(env.BRAKE_SETUP_TOKEN ? { setupToken: env.BRAKE_SETUP_TOKEN } : {}),
    ...(env.GOOGLE_KEY_CHECK ? { checkGoogleKey: (key: string) => checkGoogleKey(key) } : {}),
    extensions: (await opts.extensions?.(db, valkey)) ?? [],
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
}
