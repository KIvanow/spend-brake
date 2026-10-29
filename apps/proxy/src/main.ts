import { GenericAdapter, GoogleMapsAdapter, type ProviderAdapter } from '@spend-brake/catalog';
import { Redis } from 'ioredis';
import { loadEnv } from './config.js';
import { CachingSecretStore, StaticSecretStore } from './secrets.js';
import { buildServer, loggerOptions } from './server.js';

const env = loadEnv();
const valkey = new Redis(env.VALKEY_URL, {
  // Fail fast instead of queueing, so an outage turns into 503 (or fail-open) right away.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  // Batch all commands issued in one tick into a single socket write; under load this removes
  // most of the per-request write syscalls.
  enableAutoPipelining: true,
});
const adapters: ProviderAdapter[] = [
  new GoogleMapsAdapter(),
  ...(env.BRAKE_GENERIC_PROVIDERS ?? []).map(
    (cfg) => new GenericAdapter(cfg as ConstructorParameters<typeof GenericAdapter>[0]),
  ),
];

const app = buildServer({
  valkey,
  adapters,
  secrets: new CachingSecretStore(new StaticSecretStore(env.BRAKE_DEV_SECRETS ?? {})),
  upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
  trustProxy: env.TRUST_PROXY,
  logger: loggerOptions(env.LOG_LEVEL),
  ...(env.BRAKE_UPSTREAM_OVERRIDES ? { upstreamOverrides: env.BRAKE_UPSTREAM_OVERRIDES } : {}),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => valkey.quit())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
