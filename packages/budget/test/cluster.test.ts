import { Cluster } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetEngine } from '../src/engine.js';
import type { Scope } from '../src/keys.js';
import { VALKEY_IMAGE, newOrg, newReq } from './valkey.js';

// Three primaries in one container. Nodes announce 127.0.0.1 to each other and the client
// maps those addresses to the container's published ports.
const PORTS = [7000, 7001, 7002];
const BOOT = `
for p in ${PORTS.join(' ')}; do
  valkey-server --port $p --cluster-enabled yes --cluster-config-file nodes-$p.conf \
    --cluster-announce-ip 127.0.0.1 --appendonly no --save '' --daemonize yes
done
sleep 1
valkey-cli --cluster create ${PORTS.map((p) => `127.0.0.1:${p}`).join(' ')} \
  --cluster-replicas 0 --cluster-yes
until valkey-cli -p 7000 cluster info | grep -q cluster_state:ok; do sleep 0.2; done
echo CLUSTER READY
tail -f /dev/null
`;

// A fixed clock so the test never straddles midnight in the org's time zone.
const NOW = new Date('2026-10-29T12:00:00Z');

let container: StartedTestContainer;
let cluster: Cluster;

beforeAll(async () => {
  container = await new GenericContainer(VALKEY_IMAGE)
    .withExposedPorts(...PORTS)
    .withCommand(['sh', '-c', BOOT])
    .withWaitStrategy(Wait.forLogMessage('CLUSTER READY'))
    .start();
  const host = container.getHost();
  const natMap = Object.fromEntries(
    PORTS.map((p) => [`127.0.0.1:${p}`, { host, port: container.getMappedPort(p) }]),
  );
  cluster = new Cluster([{ host, port: container.getMappedPort(PORTS[0]!) }], { natMap });
});

afterAll(async () => {
  await cluster.quit();
  await container.stop();
});

describe('budget engine on a 3-node cluster', () => {
  it('runs every operation for orgs spread across all nodes', async () => {
    const engine = new BudgetEngine(cluster);
    const keyScope: Scope = { kind: 'key', id: 'k1' };
    const orgs = Array.from({ length: 30 }, newOrg);

    const slots = await Promise.all(
      orgs.map((o) => cluster.cluster('KEYSLOT', `bk:{o:${o}}:kill`)),
    );
    const nodeOf = (slot: number) => Math.floor(slot / (16384 / 3));
    expect(new Set(slots.map(nodeOf)).size).toBe(3);

    for (const org of orgs) {
      await engine.setCap(org, keyScope, 'd', { hard: 3_000_000n, soft: 1_000_000n });
      const base = {
        orgId: org,
        scopes: [{ kind: 'org' } as Scope, keyScope, { kind: 'env', name: 'ci' } as Scope],
        killTargets: [{ kind: 'org' as const }, { kind: 'key' as const, id: 'k1' }],
        timeZone: 'Europe/Sofia',
      };
      const a = { ...base, reqId: newReq(), amount: 2_000_000n };
      const r = await engine.reserve(a);
      expect(r.outcome === 'ok' && r.crossings.map((c) => c.mark)).toEqual(['50', 'soft']);
      expect((await engine.reserve({ ...base, reqId: newReq(), amount: 2_000_000n })).outcome).toBe(
        'budget_exceeded',
      );
      await engine.commit(org, a.reqId, 1_500_000n);

      const late = {
        ...base,
        reqId: newReq(),
        amount: 1_000_000n,
        now: new Date(NOW.getTime() - 200_000),
      };
      expect((await engine.reserve(late)).outcome).toBe('ok');
      expect(await engine.sweep(org, NOW)).toEqual({ committed: 1, alreadySettled: 0 });

      await engine.kill(org, { kind: 'key', id: 'k1' });
      expect((await engine.reserve({ ...base, reqId: newReq(), amount: 1n })).outcome).toBe(
        'killed',
      );
      await engine.unkill(org, { kind: 'key', id: 'k1' });

      const [day] = await engine.status(org, [keyScope], 'Europe/Sofia', NOW);
      expect(day).toMatchObject({ spent: 2_500_000n, held: 0n, remaining: 500_000n });
    }
  });
});
