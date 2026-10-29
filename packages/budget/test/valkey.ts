import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const VALKEY_IMAGE = 'valkey/valkey:8';

export interface TestValkey {
  client: Redis;
  /** Extra connections for tests that need real client-side concurrency. */
  connect(): Redis;
  stop(): Promise<void>;
}

export async function startValkey(): Promise<TestValkey> {
  const container: StartedTestContainer = await new GenericContainer(VALKEY_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  const opts = { host: container.getHost(), port: container.getMappedPort(6379) };
  const clients: Redis[] = [];
  const connect = () => {
    const c = new Redis(opts);
    clients.push(c);
    return c;
  };
  const client = connect();
  return {
    client,
    connect,
    async stop() {
      await Promise.all(clients.map((c) => c.quit()));
      await container.stop();
    },
  };
}

/** A fresh org per test keeps tests independent without flushing the database. */
export const newOrg = () => `org_${randomUUID().slice(0, 8)}`;
export const newReq = () => randomUUID();
