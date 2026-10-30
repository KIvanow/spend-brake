import { createSocket } from 'node:dgram';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAudit } from '../src/audit/export.js';
import { type AuditSink, fileSink, s3Sink, syslogLine, syslogSink } from '../src/audit/sinks.js';
import { eeExportCursors } from '../src/schema.js';
import { type Env, bearer, newOrg, startEnv } from './harness.js';

let env: Env;

beforeAll(async () => {
  env = await startEnv();
});

afterAll(async () => {
  await env.stop();
});

const kill = (tok: string, target: string) =>
  env.app.inject({ method: 'POST', url: '/v1/kill', headers: bearer(tok), payload: { target } });

describe('audit export', () => {
  it('sends every new audit record to a file, S3 and syslog, then resumes from its cursor', async () => {
    const org = await newOrg(env);
    await kill(org.admin, 'prov:a');
    await kill(org.admin, 'prov:b');

    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    const file = join(dir, 'audit.jsonl');
    const objects: PutObjectCommand['input'][] = [];
    const s3 = s3Sink({
      bucket: 'b',
      prefix: 'p/',
      client: {
        send: (cmd: PutObjectCommand) => {
          objects.push(cmd.input);
          return Promise.resolve({});
        },
      } as never,
    });
    const udp = createSocket('udp4');
    const datagrams: string[] = [];
    udp.on('message', (m) => datagrams.push(m.toString()));
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
    const syslog = syslogSink(`udp://127.0.0.1:${udp.address().port}`);

    const sinks = [fileSink(file), s3, syslog];
    const first = await exportAudit(env.db, sinks, () => env.clock.now);
    const total = first[`file:${file}`]!;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(first).toEqual({ [`file:${file}`]: total, [s3.name]: total, [syslog.name]: total });

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    const mine = lines.map(
      (l) => JSON.parse(l) as { orgId: string; action: string; target: string },
    );
    expect(mine.filter((r) => r.orgId === org.id).map((r) => r.target)).toEqual([
      'prov:a',
      'prov:b',
    ]);
    expect(objects[0]!.Key).toMatch(/^p\/2026\/10\/30\/\d+-\d+\.jsonl$/);
    await new Promise((r) => setTimeout(r, 50));
    expect(datagrams.length).toBe(total);
    expect(datagrams[0]).toMatch(/^<110>1 \S+Z \S+ spend-brake - audit - \{"id":/);

    // Nothing new: nothing sent. One more record: only it is sent.
    expect(await exportAudit(env.db, sinks, () => env.clock.now)).toEqual({
      [`file:${file}`]: 0,
      [s3.name]: 0,
      [syslog.name]: 0,
    });
    await kill(org.admin, 'prov:c');
    expect((await exportAudit(env.db, [fileSink(file)], () => env.clock.now))[`file:${file}`]).toBe(
      1,
    );
    udp.close();
  });

  it('keeps a failing sink at its cursor without holding up the others', async () => {
    const org = await newOrg(env);
    await kill(org.admin, 'prov:z');
    let fail = true;
    const flaky: AuditSink = {
      name: 'flaky',
      write: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve()),
    };
    const seen: number[] = [];
    const ok: AuditSink = {
      name: 'ok',
      write: (r) => {
        seen.push(r.length);
        return Promise.resolve();
      },
    };
    const warnings: string[] = [];
    const log = { warn: (_o: object, m: string) => void warnings.push(m) };
    const r = await exportAudit(env.db, [flaky, ok], () => env.clock.now, log);
    expect(r.flaky).toBe(0);
    expect(r.ok).toBeGreaterThan(0);
    expect(warnings).toEqual(['audit export failed']);
    const cursors = await env.db.select().from(eeExportCursors);
    expect(cursors.find((c) => c.sink === 'flaky')).toBeUndefined();
    fail = false;
    expect((await exportAudit(env.db, [flaky], () => env.clock.now)).flaky).toBe(r.ok);
  });

  it('never skips a record committed after a higher id was exported', async () => {
    const org = await newOrg(env);
    await exportAudit(
      env.db,
      [fileSink(join(tmpdir(), `drain-${Date.now()}`))],
      () => env.clock.now,
    );
    const seen: string[] = [];
    const sink: AuditSink = {
      name: 'order',
      write: (r) => {
        seen.push(...r.map((x) => x.target ?? ''));
        return Promise.resolve();
      },
    };
    await exportAudit(env.db, [sink], () => env.clock.now);
    seen.length = 0;
    // A slow transaction takes an id, then a later one commits first.
    const slow = await env.db.$client.connect();
    await slow.query('begin');
    await slow.query(
      `insert into audit_log (org_id, actor, action, target, data, at) values ($1, 'test', 'slow', 'first', '{}', now())`,
      [org.id],
    );
    await kill(org.admin, 'prov:second');
    await exportAudit(env.db, [sink], () => env.clock.now);
    expect(seen).toEqual([]);
    await slow.query('commit');
    slow.release();
    await exportAudit(env.db, [sink], () => env.clock.now);
    expect(seen).toEqual(['first', 'prov:second']);
  });

  it('keeps an oversized record within a datagram and bounds the API cursor', async () => {
    const record = {
      id: '9',
      orgId: 'o',
      at: '2026-10-30T12:00:00.000Z',
      actor: 'a',
      action: 'x',
      target: null,
      reason: null,
      data: { blob: 'y'.repeat(100_000) },
    };
    const line = syslogLine(record, 'h');
    expect(Buffer.byteLength(line)).toBeLessThan(60_000);
    expect(line).toContain('"truncated":true');
    const org = await newOrg(env);
    const res = await env.app.inject({
      url: '/v1/audit/export?cursor=9999999999999999999',
      headers: bearer(org.admin),
    });
    expect(res.statusCode).toBe(400);
  });

  it('frames records over TCP syslog with octet counting', async () => {
    const received: Buffer[] = [];
    const server = createServer((s) => s.on('data', (d: Buffer) => received.push(d)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const record = {
      id: '1',
      orgId: 'o',
      at: '2026-10-30T12:00:00.000Z',
      actor: 'token:t',
      action: 'kill',
      target: 'org',
      reason: 'line one\nline two',
      data: {},
    };
    await syslogSink(`tcp://127.0.0.1:${port}`).write([record, { ...record, id: '2' }]);
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    const text = Buffer.concat(received).toString();
    const first = /^(\d+) /.exec(text)!;
    const len = Number(first[1]);
    expect(
      Buffer.from(text)
        .subarray(first[0].length, first[0].length + len)
        .toString(),
    ).toContain('"id":"1"');
    expect(text.match(/"action":"kill"/g)).toHaveLength(2);
  });
});
