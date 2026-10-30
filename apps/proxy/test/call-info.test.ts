import { describe, expect, it } from 'vitest';
import { callInfo } from '../src/server.js';

describe('per-call telemetry details', () => {
  it("keep the caller's W3C trace context", () => {
    expect(
      callInfo(
        {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          'user-agent': 'my-app/1.0',
        },
        Buffer.from('{"q":1}'),
      ),
    ).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      userAgent: 'my-app/1.0',
      reqBytes: '7',
    });
  });

  it('drop invalid or all-zero trace ids', () => {
    for (const tp of [
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01',
      'garbage',
    ]) {
      expect(callInfo({ traceparent: tp }, undefined).traceId, tp).toBeUndefined();
    }
  });

  it('bound the user agent to printable text', () => {
    const ua = callInfo({ 'user-agent': `x\u0000\n${'a'.repeat(500)}` }, undefined).userAgent!;
    expect(ua).toMatch(/^x a*$|^xa*$/);
    expect(ua.length).toBe(200);
    expect(callInfo({}, undefined)).toEqual({
      traceId: undefined,
      parentSpanId: undefined,
      userAgent: undefined,
      reqBytes: undefined,
    });
  });
});
