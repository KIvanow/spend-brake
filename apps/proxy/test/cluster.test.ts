import { BudgetEngine, Registry, connectValkey } from '@spend-brake/budget';
import { GoogleMapsAdapter } from '@spend-brake/catalog';
import type { FastifyInstance } from 'fastify';
import { Cluster } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticSecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { MockGoogle, NOW, REAL_KEY, newOrg } from './harness.js';

// Three primaries in one container, announced as 127.0.0.1 and mapped to published ports.
const PORTS = [7000, 7001, 7002];
const BOOT = `
for p in ${PORTS.join(' ')}; do
  valkey-server --port $p --cluster-enabled yes --cluster-config-file nodes-$p.conf \\
    --cluster-announce-ip 127.0.0.1 --appendonly no --save '' --daemonize yes
done
sleep 1
valkey-cli --cluster create ${PORTS.map((p) => `127.0.0.1:${p}`).join(' ')} \\
  --cluster-replicas 0 --cluster-yes
until valkey-cli -p 7000 cluster info | grep -q cluster_state:ok; do sleep 0.2; done
echo CLUSTER READY
tail -f /dev/null
`;

let container: StartedTestContainer;
let cluster: Cluster;
let mock: MockGoogle;
let proxy: FastifyInstance;

beforeAll(async () => {
  container = await new GenericContainer('valkey/valkey:8')
    .withExposedPorts(...PORTS)
    .withCommand(['sh', '-c', BOOT])
    .withWaitStrategy(Wait.forLogMessage('CLUSTER READY'))
    .start();
  const host = container.getHost();
  const natMap = Object.fromEntries(
    PORTS.map((p) => [`127.0.0.1:${p}`, { host, port: container.getMappedPort(p) }]),
  );
  cluster = new Cluster([{ host, port: container.getMappedPort(PORTS[0]!) }], {
    natMap,
    enableAutoPipelining: true,
  });
  mock = await new MockGoogle().start();
  mock.respond = (_req, reply) => reply.send({ results: [], status: 'OK' });
  proxy = buildServer({
    valkey: cluster,
    adapters: [new GoogleMapsAdapter()],
    secrets: new StaticSecretStore({ 'cred-google': REAL_KEY }),
    upstreamOverrides: { 'https://maps.googleapis.com': mock.url },
    now: () => NOW,
  });
  await proxy.ready();
});

afterAll(async () => {
  await proxy.close();
  await mock.app.close();
  await cluster.quit();
  await container.stop();
});

describe('proxy on a Valkey Cluster', () => {
  it('authenticates, prices, caps and settles for orgs on every node', async () => {
    const registry = new Registry(cluster);
    const engine = new BudgetEngine(cluster);
    for (let i = 0; i < 12; i++) {
      const org = newOrg();
      await registry.putOrg({ id: org, timeZone: 'UTC', providers: {} });
      const { token, record } = await registry.createKey({
        id: `k_${i}`,
        orgId: org,
        credentials: { 'google-maps': 'cred-google' },
      });
      // One geocode ($0.005) fits; the second does not.
      await engine.setCap(org, { kind: 'key', id: record.id }, 'd', { hard: 6_000n, soft: null });
      const geocode = () =>
        proxy.inject(`/google-maps/maps/api/geocode/json?address=Sofia&key=${token}`);
      const first = await geocode();
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers['x-brake-cost-micros']).toBe('5000');
      await proxy.brakeDrain();
      const second = await geocode();
      expect(second.statusCode).toBe(402);
      expect(second.json()).toMatchObject({ error: 'budget_exceeded', scope: `key:${record.id}` });
    }
  });
});

describe('connectValkey', () => {
  it('reads one server or a cluster from the URL', () => {
    const one = connectValkey('redis://:pw@localhost:6390', { lazyConnect: true });
    expect(one).not.toBeInstanceOf(Cluster);
    one.disconnect();
    const many = connectValkey('redis-cluster://:s%40cret@v1:7000,v2:7001,v3', {
      lazyConnect: true,
    }) as Cluster;
    expect(many).toBeInstanceOf(Cluster);
    expect((many as unknown as { startupNodes: unknown }).startupNodes).toEqual([
      { host: 'v1', port: 7000 },
      { host: 'v2', port: 7001 },
      { host: 'v3', port: 6379 },
    ]);
    expect(many.options.redisOptions).toMatchObject({ password: 's@cret' });
    many.disconnect();
  });
});
