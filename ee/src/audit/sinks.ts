import { createSocket } from 'node:dgram';
import { appendFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { type AuditRecord, jsonl } from './rows.js';

/** Somewhere audit records go. A write either takes the whole batch or throws. */
export interface AuditSink {
  /** Stable id: the export cursor is kept per sink. */
  name: string;
  write(records: AuditRecord[]): Promise<void>;
}

/** JSON Lines appended to a file (rotate it with logrotate's copytruncate). */
export function fileSink(path: string): AuditSink {
  return {
    name: `file:${path}`,
    write: (records) => appendFile(path, jsonl(records), { mode: 0o600 }),
  };
}

export interface S3SinkOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  /** S3-compatible storage (MinIO, R2); path-style addressing. */
  endpoint?: string;
  client?: Pick<S3Client, 'send'>;
}

/** One JSON Lines object per batch: `<prefix>YYYY/MM/DD/<firstId>-<lastId>.jsonl`. */
export function s3Sink(opts: S3SinkOptions): AuditSink {
  const client =
    opts.client ??
    new S3Client({
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
    });
  const prefix = opts.prefix ?? 'spend-brake/audit/';
  return {
    name: `s3:${opts.bucket}/${prefix}`,
    async write(records) {
      const first = records[0]!;
      const day = first.at.slice(0, 10).replaceAll('-', '/');
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: `${prefix}${day}/${first.id}-${records.at(-1)!.id}.jsonl`,
          Body: jsonl(records),
          ContentType: 'application/x-ndjson',
        }),
      );
    },
  };
}

// RFC 5424, facility 13 (log audit), severity 6 (informational).
const PRI = 13 * 8 + 6;

// Below the UDP datagram limit with room for the header.
const MAX_LINE_BYTES = 60_000;

/** One RFC 5424 line; a record too large for a datagram keeps everything but its `data`. */
export function syslogLine(r: AuditRecord, host = hostname()): string {
  const line = `<${PRI}>1 ${r.at} ${host} spend-brake - audit - ${JSON.stringify(r)}`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const slim = { ...r, data: { truncated: true }, reason: r.reason?.slice(0, 1000) ?? null };
  return `<${PRI}>1 ${r.at} ${host} spend-brake - audit - ${JSON.stringify(slim)}`;
}

/** Syslog to a SIEM: `udp://host:514` (one datagram per record) or `tcp://host:514`. */
export function syslogSink(url: string): AuditSink {
  const u = new URL(url);
  const port = Number(u.port || 514);
  const host = u.hostname;
  if (u.protocol === 'udp:') {
    return {
      name: `syslog:${url}`,
      async write(records) {
        const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4');
        try {
          for (const r of records) {
            await new Promise<void>((resolve, reject) =>
              socket.send(syslogLine(r), port, host, (err) => (err ? reject(err) : resolve())),
            );
          }
        } finally {
          socket.close();
        }
      },
    };
  }
  if (u.protocol !== 'tcp:') throw new Error(`syslog URL must be udp:// or tcp://, not ${url}`);
  return {
    name: `syslog:${url}`,
    write: (records) =>
      new Promise<void>((resolve, reject) => {
        // Octet-counting framing (RFC 6587): records may hold newlines in their data.
        const frames = records.map((r) => {
          const line = syslogLine(r);
          return `${Buffer.byteLength(line)} ${line}`;
        });
        // Done once the bytes are handed to the network stack: syslog has no acknowledgement.
        const socket = connect({ host, port }, () => socket.end(frames.join(''), () => resolve()));
        socket.setTimeout(10_000, () => socket.destroy(new Error('syslog timed out')));
        socket.on('error', reject);
      }),
  };
}
