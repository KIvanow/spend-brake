import { SpanKind } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { REDACTED, SECRET_HEADERS, redactText, redactUrl } from './redact.js';

export interface RedactOptions {
  /**
   * Reduce outgoing (client) request URLs to scheme and host. The notifier sets this: its
   * outgoing calls go to webhook URLs whose path is the credential (Slack, Teams).
   */
  clientUrlsToOrigin?: boolean;
}

/**
 * Wraps a span exporter so no span leaves the process with a secret in it: URLs lose secret
 * query parameters (the proxy's call to Google carries the real key in `?key=`), virtual keys and
 * alert action tokens (`/a/<token>`) are removed from every string attribute, and credential
 * header attributes are censored.
 */
export class RedactingExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly opts: RedactOptions = {},
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    for (const span of spans) redactSpan(span, this.opts);
    this.inner.export(spans, done);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

const actionPath = (s: string) => s.replace(/\/a\/[^/?#\s]+/g, '/a/[redacted]');
const clean = (s: string) => actionPath(redactText(redactUrl(s)));

const URL_ATTRS = ['url.full', 'http.url', 'url.path', 'http.target', 'url.query'];

export function redactSpan(span: ReadableSpan, opts: RedactOptions = {}): void {
  const attrs = span.attributes as Record<string, unknown>;
  if (opts.clientUrlsToOrigin && span.kind === SpanKind.CLIENT) {
    for (const name of URL_ATTRS) {
      const v = attrs[name];
      if (typeof v !== 'string') continue;
      try {
        attrs[name] = new URL(v).origin;
      } catch {
        attrs[name] = REDACTED;
      }
    }
  }
  for (const [name, value] of Object.entries(attrs)) {
    const header = /^http\.(request|response)\.header\.(.+)$/.exec(name)?.[2]?.replace(/_/g, '-');
    if (header && SECRET_HEADERS.has(header.toLowerCase())) {
      attrs[name] = REDACTED;
    } else if (typeof value === 'string') {
      attrs[name] = clean(value);
    } else if (Array.isArray(value)) {
      attrs[name] = value.map((v: unknown) => (typeof v === 'string' ? clean(v) : v));
    }
  }
  for (const event of span.events) {
    const ea = (event.attributes ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(ea)) if (typeof v === 'string') ea[k] = clean(v);
  }
}

/**
 * Start tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set (standard OTEL_* variables apply).
 * Database statements are reduced to the command name: Valkey values include credential
 * envelopes and Postgres parameters can include provider metadata. BRAKE_OTEL_CLIENT_URLS=origin
 * reduces outgoing request URLs to scheme and host.
 */
export async function startTelemetry(
  serviceName: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ shutdown(): Promise<void> } | null> {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]);
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME ?? serviceName,
    traceExporter: new RedactingExporter(new OTLPTraceExporter(), {
      clientUrlsToOrigin: env.BRAKE_OTEL_CLIENT_URLS === 'origin',
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-ioredis': {
          dbStatementSerializer: (cmd: string) => cmd,
        },
        '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false },
      }),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
