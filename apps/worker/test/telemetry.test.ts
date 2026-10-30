import { randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { BudgetEngine } from '@spend-brake/budget';
import { type Db, createDb, eq, migrate, orgs, telemetryExports } from '@spend-brake/db';
import {
  LocalKeyWrapper,
  encryptSecret,
  orgMetricsKey,
  otlpHeadersContext,
  otlpQueueKey,
  renderOrgMetrics,
} from '@spend-brake/shared';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEDGER_GROUP } from '../src/ledger.js';
import { Worker } from '../src/worker.js';

let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: Redis;
let queueConn: Redis;
let engine: BudgetEngine;
let worker: Worker;
let collector: Server;
let collectorUrl: string;
let received: { headers: Record<string, unknown>; body: { resourceSpans: unknown[] } }[] = [];
let collectorDown = false;
const wrapper = new LocalKeyWrapper(randomBytes(32).toString('base64'));
const NOW = new Date('2026-10-30T12:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, vk] = await Promise.all([
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
  ({ db, pool } = createDb(`postgres://brake:p@${pg.getHost()}:${pg.getMappedPort(5432)}/brake`));
  await migrate(db);
  const url = `redis://${vk.getHost()}:${vk.getMappedPort(6379)}`;
  valkey = new Redis(url);
  queueConn = new Redis(url, { maxRetriesPerRequest: null });
  engine = new BudgetEngine(valkey);
  collector = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (collectorDown) {
        res.writeHead(503).end('down');
        return;
      }
      received.push({
        headers: req.headers,
        body: JSON.parse(body) as { resourceSpans: unknown[] },
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  collectorUrl = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  worker = new Worker({
    db,
    valkey,
    queueConnection: queueConn,
    workerId: 'w-telemetry',
    log: quiet,
    wrapper,
    // The test collector listens on 127.0.0.1.
    allowPrivateCollectors: true,
    fetchPage: () => Promise.resolve('<table><tr><td>$1.00</td></tr></table>'),
    now: () => NOW,
  });
  await worker.partitionsOnce();
});

afterAll(async () => {
  await worker.stop();
  await worker.alerts.queue.close();
  collector.close();
  await valkey.quit();
  await queueConn.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

let n = 0;
async function newOrg(): Promise<string> {
  const id = `t${++n}`;
  await db.insert(orgs).values({ id, name: id });
  await worker.refreshOrgs();
  return id;
}

const call = (org: string, fields: Record<string, string>) =>
  engine.emit(org, {
    type: 'usage',
    provider: 'google-maps',
    route: 'geocode',
    skus: 'gmp.geocoding',
    keyId: 'key_1',
    costMicros: '5000',
    worstMicros: '5000',
    status: '200',
    latencyMs: '120.0',
    upstreamMs: '100.0',
    ...fields,
  });

async function exportTo(org: string, headers: Record<string, string>) {
  await db.insert(telemetryExports).values({
    orgId: org,
    endpoint: collectorUrl,
    headersEnvelope: await encryptSecret(wrapper, JSON.stringify(headers), otlpHeadersContext(org)),
    headerNames: Object.keys(headers),
  });
  worker.otlp.reload();
}

describe('org metrics', () => {
  it('counts each call once, even when a batch is replayed', async () => {
    const org = await newOrg();
    await call(org, { reqId: 'r1' });
    await call(org, { reqId: 'r2', status: '500', costMicros: '0' });
    await engine.emit(org, {
      type: 'blocked',
      reason: 'killed',
      provider: 'google-maps',
      keyId: 'key_1',
    });
    await worker.ledgerOnce();

    // A crash after the insert but before the ack: the same entries come again.
    const stream = `bk:{o:${org}}:events`;
    await valkey.xgroup('SETID', stream, LEDGER_GROUP, '0');
    await worker.ledgerOnce();

    const text = renderOrgMetrics(await valkey.hgetall(orgMetricsKey(org)), []);
    expect(text).toMatch(/spend_brake_requests_total\{[^}]*outcome="ok"[^}]*\} 1\n/);
    expect(text).toMatch(/spend_brake_requests_total\{[^}]*outcome="http_5xx"[^}]*\} 1\n/);
    expect(text).toMatch(/spend_brake_requests_total\{[^}]*outcome="killed"[^}]*\} 1\n/);
    expect(text).toMatch(/spend_brake_cost_usd_total\{[^}]*\} 0\.005\n/);
    expect(text).toContain('spend_brake_request_duration_seconds_count{provider="google-maps"} 2');
  });
});

describe('OpenTelemetry export', () => {
  it("sends each call as a span to the org's collector, with its headers, inside the caller's trace", async () => {
    received = [];
    const org = await newOrg();
    await exportTo(org, { 'x-api-key': 'collector-secret' });
    await call(org, {
      reqId: 'r1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      userAgent: 'my-app/1.0',
    });
    await call(org, { reqId: 'r2' });
    await worker.ledgerOnce();
    expect(await valkey.llen(otlpQueueKey(org))).toBe(2);
    expect(await worker.otlp.runOnce()).toBe(2);
    expect(await valkey.llen(otlpQueueKey(org))).toBe(0);

    expect(received).toHaveLength(1);
    expect(received[0]!.headers['x-api-key']).toBe('collector-secret');
    const rs = received[0]!.body.resourceSpans[0] as {
      resource: { attributes: { key: string; value: { stringValue: string } }[] };
      scopeSpans: { spans: { traceId: string; parentSpanId?: string; name: string }[] }[];
    };
    expect(rs.resource.attributes).toContainEqual({
      key: 'spend_brake.org_id',
      value: { stringValue: org },
    });
    const spans = rs.scopeSpans[0]!.spans;
    // Oldest first.
    expect(spans.map((s) => s.parentSpanId ?? null)).toEqual(['00f067aa0ba902b7', null]);
    expect(spans[0]).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      name: 'google-maps geocode',
    });

    const [row] = await db.select().from(telemetryExports).where(eq(telemetryExports.orgId, org));
    expect(row!.lastSuccessAt).not.toBeNull();
  });

  it('keeps spans while the collector is down and sends them once it is back', async () => {
    received = [];
    const org = await newOrg();
    await exportTo(org, {});
    await call(org, { reqId: 'r1' });
    await worker.ledgerOnce();
    collectorDown = true;
    expect(await worker.otlp.runOnce()).toBe(0);
    expect(await valkey.llen(otlpQueueKey(org))).toBe(1);
    const [row] = await db.select().from(telemetryExports).where(eq(telemetryExports.orgId, org));
    expect(row!.lastError).toContain('HTTP 503');
    // Backing off: nothing is tried right away.
    collectorDown = false;
    expect(await worker.otlp.runOnce()).toBe(0);
    // A new worker (or the backoff running out) sends it.
    const fresh = new Worker({
      db,
      valkey,
      queueConnection: queueConn,
      workerId: 'w-2',
      log: quiet,
      wrapper,
      allowPrivateCollectors: true,
      now: () => NOW,
    });
    expect(await fresh.otlp.runOnce()).toBe(1);
    expect(received).toHaveLength(1);
    await fresh.alerts.queue.close();
  });

  it('queues nothing for orgs that do not export', async () => {
    const org = await newOrg();
    await call(org, { reqId: 'r1' });
    await worker.ledgerOnce();
    expect(await valkey.llen(otlpQueueKey(org))).toBe(0);
  });

  it('refuses private collectors unless told otherwise', async () => {
    const org = await newOrg();
    await exportTo(org, {});
    const strict = new Worker({
      db,
      valkey,
      queueConnection: queueConn,
      workerId: 'w-3',
      log: quiet,
      wrapper,
      now: () => NOW,
    });
    await call(org, { reqId: 'r1' });
    await strict.refreshOrgs();
    await strict.ledgerOnce();
    expect(await strict.otlp.runOnce()).toBe(0);
    const [row] = await db.select().from(telemetryExports).where(eq(telemetryExports.orgId, org));
    expect(row!.lastError).toContain('private address');
    await strict.alerts.queue.close();
  });
});
