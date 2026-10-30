import { Cluster, Redis, type RedisOptions } from 'ioredis';
import type { ValkeyClient } from './scripts.js';

/**
 * Connect to Valkey from a URL. `redis://` / `rediss://` is one server; `redis-cluster://`
 * (or `rediss-cluster://` for TLS) lists seed nodes of a Valkey Cluster, comma-separated:
 * `redis-cluster://:password@valkey-1:6379,valkey-2:6379`. Every key of one org shares the
 * `{o:<org>}` hash tag, so each budget script runs on a single node.
 */
export function connectValkey(url: string, options: RedisOptions = {}): ValkeyClient {
  const cluster = /^(rediss?)-cluster:\/\/(?:([^@/]*)@)?([^/?#]+)/.exec(url);
  if (!cluster) return new Redis(url, options as never);
  const [, scheme, credentials, hosts] = cluster;
  const [username, password] = (credentials ?? '').split(':').map(decodeURIComponent);
  const nodes = hosts!.split(',').map((h) => {
    const [host, port] = h.split(':');
    return { host: host!, port: Number(port ?? 6379) };
  });
  return new Cluster(nodes, {
    // Commands issued while the slot map refreshes wait for it instead of failing.
    enableOfflineQueue: options.enableOfflineQueue ?? true,
    lazyConnect: options.lazyConnect ?? false,
    redisOptions: {
      ...options,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(scheme === 'rediss' ? { tls: {} } : {}),
    } as never,
  });
}
