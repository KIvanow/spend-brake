import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../src/redact.js';
import { RedactingExporter, redactSpan, startTelemetry } from '../src/telemetry.js';

const span = (attributes: Record<string, unknown>) =>
  ({
    attributes,
    events: [{ name: 'e', attributes: { msg: 'token sb_live_abcDEF' } }],
  }) as unknown as ReadableSpan;

describe('span redaction', () => {
  it('strips provider keys from URLs, virtual keys from text and credential headers', () => {
    const s = span({
      'url.full': 'https://maps.googleapis.com/maps/api/geocode/json?address=Sofia&key=AIzaREAL',
      'http.url': '/google-maps/maps/api/geocode/json?key=sb_live_abc123',
      'http.request.header.x_goog_api_key': ['AIzaREAL'],
      'http.request.header.x-brake-key': 'sb_live_abc',
      'http.request.header.accept': 'application/json',
      'db.statement': 'evalsha',
      'http.status_code': 200,
    });
    redactSpan(s);
    expect(s.attributes).toEqual({
      'url.full': `https://maps.googleapis.com/maps/api/geocode/json?address=Sofia&key=${REDACTED}`,
      'http.url': `/google-maps/maps/api/geocode/json?key=${REDACTED}`,
      'http.request.header.x_goog_api_key': REDACTED,
      'http.request.header.x-brake-key': REDACTED,
      'http.request.header.accept': 'application/json',
      'db.statement': 'evalsha',
      'http.status_code': 200,
    });
    expect(s.events[0]!.attributes).toEqual({ msg: `token ${REDACTED}` });
  });

  it('redacts before handing spans to the real exporter', () => {
    const seen: ReadableSpan[] = [];
    const inner: SpanExporter = {
      export: (spans, done) => {
        seen.push(...spans);
        done({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    };
    new RedactingExporter(inner).export([span({ 'url.full': 'https://x/?key=secret' })], () => {});
    expect(seen[0]!.attributes['url.full']).toBe(`https://x/?key=${REDACTED}`);
  });

  it('stays off without an OTLP endpoint', async () => {
    expect(await startTelemetry('test', {})).toBeNull();
  });
});
