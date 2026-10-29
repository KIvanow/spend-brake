import {
  GenericAdapter,
  GoogleMapsAdapter,
  HereAdapter,
  MapboxAdapter,
  type ProviderAdapter,
  TwilioAdapter,
} from '@spend-brake/catalog';
import { Registry } from '@spend-brake/budget';
import { keyWrapperFromEnv } from '@spend-brake/shared';
import { Redis } from 'ioredis';
import { loadEnv } from './config.js';
import { ProxyMetrics } from './metrics.js';
import { CachingSecretStore, EnvelopeSecretStore, StaticSecretStore } from './secrets.js';
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
  new TwilioAdapter(),
  new MapboxAdapter(),
  new HereAdapter(),
  ...(env.BRAKE_GENERIC_PROVIDERS ?? []).map(
    (cfg) => new GenericAdapter(cfg as ConstructorParameters<typeof GenericAdapter>[0]),
  ),
];

// Encrypted credentials from the admin API; BRAKE_DEV_SECRETS only when no master key is set.
const wrapper = await keyWrapperFromEnv(process.env);
const secrets = wrapper
  ? new EnvelopeSecretStore(new Registry(valkey), wrapper)
  : new StaticSecretStore(env.BRAKE_DEV_SECRETS ?? {});

const metrics = new ProxyMetrics();
const metricsServer = metrics.serve(env.METRICS_PORT);

const app = buildServer({
  metrics,
  valkey,
  adapters,
  secrets: new CachingSecretStore(secrets),
  upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
  trustProxy: env.TRUST_PROXY,
  logger: loggerOptions(env.LOG_LEVEL),
  ...(env.BRAKE_UPSTREAM_OVERRIDES ? { upstreamOverrides: env.BRAKE_UPSTREAM_OVERRIDES } : {}),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    metricsServer.close();
    void app
      .close()
      .then(() => valkey.quit())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
