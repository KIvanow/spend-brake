import {
  GenericAdapter,
  GoogleMapsAdapter,
  HereAdapter,
  MapboxAdapter,
  type ProviderAdapter,
  BraveAdapter,
  ExaAdapter,
  SerpApiAdapter,
  TavilyAdapter,
  TwilioAdapter,
  catalogOverrideDir,
  withCatalogDir,
} from '@spend-brake/catalog';
import { Registry, connectValkey } from '@spend-brake/budget';
import { keyWrapperFromEnv } from '@spend-brake/shared';
import { loadEnv } from './config.js';
import { ProxyMetrics } from './metrics.js';
import { CachingSecretStore, EnvelopeSecretStore, StaticSecretStore } from './secrets.js';
import { buildServer, loggerOptions } from './server.js';

const env = loadEnv();
const valkey = connectValkey(env.VALKEY_URL, {
  // Fail fast instead of queueing, so an outage turns into 503 (or fail-open) right away.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  // Batch all commands issued in one tick into a single socket write; under load this removes
  // most of the per-request write syscalls.
  enableAutoPipelining: true,
});
// Built again when an updated catalog is installed (BRAKE_CATALOG_DIR), each time from one
// catalog directory (`dir`, null for the bundled data).
const makeAdapters = (dir: string | null): ProviderAdapter[] =>
  withCatalogDir(dir, () => buildAdapters());
const buildAdapters = (): ProviderAdapter[] => [
  new GoogleMapsAdapter(),
  new TwilioAdapter(),
  new MapboxAdapter(),
  new HereAdapter(),
  new TavilyAdapter(),
  new ExaAdapter(),
  new BraveAdapter(),
  new SerpApiAdapter({ plan: env.BRAKE_SERPAPI_PLAN, speed: env.BRAKE_SERPAPI_SPEED }),
  ...(env.BRAKE_GENERIC_PROVIDERS ?? []).map(
    (cfg) => new GenericAdapter(cfg as ConstructorParameters<typeof GenericAdapter>[0]),
  ),
];
let catalogVersion = catalogOverrideDir();
let adapters: ProviderAdapter[];
try {
  adapters = makeAdapters(catalogVersion);
} catch (err) {
  // An updated catalog that does not load must not keep the proxy down: serve bundled prices.
  process.stderr.write(
    `${JSON.stringify({ level: 50, err: (err as Error).message, catalog: catalogVersion, msg: 'catalog update does not load; using bundled prices' })}\n`,
  );
  adapters = makeAdapters(null);
}

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

// An installed catalog update switches `current` to a new directory: rebuild the adapters from
// it. A catalog that fails to load keeps the previous adapters serving.
const catalogTimer = setInterval(() => {
  let next: string | null;
  try {
    next = catalogOverrideDir();
    if (next === catalogVersion) return;
    app.brakeSetAdapters(makeAdapters(next));
  } catch (err) {
    app.log.error({ err: (err as Error).message }, 'catalog reload failed; keeping current prices');
    // Remember it, so a broken version is reported once rather than every 30 s.
    catalogVersion = catalogOverrideDir();
    return;
  }
  catalogVersion = next;
  app.log.info({ catalog: next ?? 'bundled' }, 'catalog reloaded');
}, 30_000);
catalogTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(catalogTimer);
    metricsServer.close();
    void app
      .close()
      .then(() => valkey.quit())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
