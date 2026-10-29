import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Registry, type KeyRecord } from '@spend-brake/budget';
import { GoogleMapsAdapter } from '@spend-brake/catalog';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { StaticSecretStore } from '../src/secrets.js';
import { type ProxyDeps, buildServer, loggerOptions } from '../src/server.js';

export const REAL_KEY = 'AIzaSyREAL-provider-secret-0123456789';
export const NOW = new Date('2026-10-29T12:00:00Z');

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type Responder = (req: FastifyRequest, reply: FastifyReply) => unknown;

/** Stands in for maps/places/routes.googleapis.com. */
export class MockGoogle {
  readonly app: FastifyInstance = Fastify();
  readonly seen: Seen[] = [];
  respond: Responder = (_req, reply) => reply.send({ ok: true });
  url = '';

  async start(): Promise<this> {
    this.app.removeAllContentTypeParsers();
    this.app.addContentTypeParser('*', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
    this.app.all('/*', (req, reply) => {
      this.seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      });
      return this.respond(req, reply);
    });
    this.url = await this.app.listen({ port: 0, host: '127.0.0.1' });
    return this;
  }

  last(): Seen {
    const s = this.seen.at(-1);
    if (!s) throw new Error('upstream saw no request');
    return s;
  }
}

export async function startValkey(): Promise<{ container: StartedTestContainer; url: string }> {
  const container = await new GenericContainer('valkey/valkey:8')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return { container, url: `redis://${container.getHost()}:${container.getMappedPort(6379)}` };
}

export const newOrg = () => `org_${randomUUID().slice(0, 8)}`;

/** Captures log lines so tests can check that no secret is ever written. */
export class LogSink extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: string, done: () => void) {
    this.lines.push(chunk.toString());
    done();
  }
  text() {
    return this.lines.join('');
  }
}

export interface Harness {
  proxy: FastifyInstance;
  valkey: Redis;
  registry: Registry;
  logs: LogSink;
}

export async function startProxy(
  valkeyUrl: string,
  mock: MockGoogle,
  extra: Partial<ProxyDeps> = {},
): Promise<Harness> {
  const valkey = new Redis(valkeyUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    enableAutoPipelining: true,
  });
  await new Promise<void>((resolve) => valkey.once('ready', () => resolve()));
  const logs = new LogSink();
  const level = loggerOptions('info') as Record<string, unknown>;
  const proxy = buildServer({
    valkey,
    adapters: [new GoogleMapsAdapter()],
    secrets: new StaticSecretStore({ 'cred-google': REAL_KEY }),
    upstreamOverrides: {
      'https://maps.googleapis.com': mock.url,
      'https://places.googleapis.com': mock.url,
      'https://routes.googleapis.com': mock.url,
    },
    upstreamTimeoutMs: 1_000,
    logger: { ...level, stream: logs },
    now: () => NOW,
    ...extra,
  });
  await proxy.ready();
  return { proxy, valkey, registry: new Registry(valkey), logs };
}

export async function newKey(
  h: Harness,
  orgId: string,
  record: Partial<KeyRecord> = {},
): Promise<{ token: string; id: string }> {
  const { token, record: stored } = await h.registry.createKey({
    id: `k_${randomUUID().slice(0, 6)}`,
    orgId,
    credentials: { 'google-maps': 'cred-google' },
    ...record,
  });
  return { token, id: stored.id };
}
