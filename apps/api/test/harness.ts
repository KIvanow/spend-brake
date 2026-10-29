import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { Registry } from '@spend-brake/budget';
import { type Db, apiTokens, createDb, migrate } from '@spend-brake/db';
import { LocalKeyWrapper, redactingLoggerOptions } from '@spend-brake/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { bootstrapOrg } from '../src/bootstrap.js';
import { newApiToken, newId, sha256 } from '../src/ids.js';
import { buildApi } from '../src/server.js';

export class LogSink extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _e: string, done: () => void) {
    this.lines.push(chunk.toString());
    done();
  }
  text() {
    return this.lines.join('');
  }
}

export interface Env {
  pg: StartedTestContainer;
  vk: StartedTestContainer;
  db: Db;
  pool: { end(): Promise<void> };
  valkey: Redis;
  registry: Registry;
  wrapper: LocalKeyWrapper;
  app: FastifyInstance;
  logs: LogSink;
  stop(): Promise<void>;
}

export async function startEnv(): Promise<Env> {
  const [pg, vk] = await Promise.all([
    new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_PASSWORD: 'p', POSTGRES_USER: 'brake', POSTGRES_DB: 'brake' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  const { db, pool } = createDb(
    `postgres://brake:p@${pg.getHost()}:${pg.getMappedPort(5432)}/brake`,
  );
  await migrate(db);
  const valkey = new Redis(`redis://${vk.getHost()}:${vk.getMappedPort(6379)}`);
  const wrapper = new LocalKeyWrapper(randomBytes(32).toString('base64'));
  const logs = new LogSink();
  const app = await buildApi({
    db,
    valkey,
    wrapper,
    logger: { ...redactingLoggerOptions('info'), stream: logs },
    authCacheMs: 0,
    rateLimitPerMinute: 10_000,
  });
  await app.ready();
  return {
    pg,
    vk,
    db,
    pool,
    valkey,
    registry: new Registry(valkey),
    wrapper,
    app,
    logs,
    async stop() {
      await app.close();
      await valkey.quit();
      await pool.end();
      await Promise.all([pg.stop(), vk.stop()]);
    },
  };
}

export interface Org {
  id: string;
  owner: string;
  admin: string;
  viewer: string;
}

let n = 0;

export async function newOrg(env: Env): Promise<Org> {
  const id = `org${++n}_${randomBytes(3).toString('hex')}`;
  const owner = await bootstrapOrg({ db: env.db, registry: env.registry }, { id, name: id });
  const token = async (role: 'admin' | 'viewer') => {
    const t = newApiToken();
    await env.db.insert(apiTokens).values({
      id: newId('tok'),
      orgId: id,
      name: role,
      role,
      tokenHash: sha256(t),
    });
    return t;
  };
  return { id, owner, admin: await token('admin'), viewer: await token('viewer') };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
