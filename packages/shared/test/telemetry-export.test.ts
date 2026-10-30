import { describe, expect, it } from 'vitest';
import {
  type CallRecord,
  callIncrements,
  callSpan,
  outcomeOf,
  renderOrgMetrics,
  tracesUrl,
} from '../src/index.js';

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  orgId: 'acme',
  streamId: '1793377889284-0',
  type: 'usage',
  ts: new Date('2026-10-30T12:00:00.000Z'),
  reqId: 'req-1',
  keyId: 'key_1',
  provider: 'google-maps',
  route: 'geocode',
  skus: 'gmp.geocoding,gmp.extra',
  costMicros: 5_000n,
  worstMicros: 5_000n,
  status: 200,
  latencyMs: 120,
  session: null,
  env: 'prod',
  agentId: null,
  data: { upstreamMs: '100.0' },
  ...over,
});

const render = (calls: CallRecord[]) => {
  const hash: Record<string, string> = {};
  for (const c of calls) {
    for (const [field, by] of callIncrements(c))
      hash[field] = String(Number(hash[field] ?? 0) + by);
  }
  return renderOrgMetrics(hash, [
    {
      scope: 'org',
      window: 'day',
      spentMicros: 15_000,
      hardMicros: 5_000_000,
      remainingMicros: 4_985_000,
    },
    {
      scope: 'key:key_1',
      window: 'month',
      spentMicros: 15_000,
      hardMicros: null,
      remainingMicros: null,
    },
  ]);
};

describe('org metrics', () => {
  it('counts calls, cost and latency per provider, SKU, key and outcome', () => {
    const text = render([
      call(),
      call({ streamId: '2-0', latencyMs: 600, data: { upstreamMs: '590' } }),
      call({
        streamId: '3-0',
        type: 'blocked',
        costMicros: null,
        status: null,
        data: { reason: 'budget_exceeded' },
      }),
      call({ streamId: '4-0', status: 404, costMicros: 0n }),
    ]);
    const labels = 'agent="",env="prod",key="key_1",provider="google-maps",sku="gmp.geocoding"';
    // Labels are sorted: outcome sits between key and provider.
    const withOutcome = (o: string) =>
      `agent="",env="prod",key="key_1",outcome="${o}",provider="google-maps",sku="gmp.geocoding"`;
    expect(text).toContain(`spend_brake_requests_total{${withOutcome('ok')}} 2`);
    expect(text).toContain(`spend_brake_requests_total{${withOutcome('budget_exceeded')}} 1`);
    expect(text).toContain(`spend_brake_requests_total{${withOutcome('http_4xx')}} 1`);
    expect(text).toContain(`spend_brake_cost_usd_total{${labels}} 0.01`);
    expect(text).toContain('# TYPE spend_brake_request_duration_seconds histogram');
    expect(text).toContain(
      'spend_brake_request_duration_seconds_bucket{provider="google-maps",le="0.25"} 2',
    );
    expect(text).toContain(
      'spend_brake_request_duration_seconds_bucket{provider="google-maps",le="1"} 3',
    );
    expect(text).toContain(
      'spend_brake_request_duration_seconds_bucket{provider="google-maps",le="+Inf"} 3',
    );
    expect(text).toContain('spend_brake_request_duration_seconds_count{provider="google-maps"} 3');
    expect(text).toContain('spend_brake_request_duration_seconds_sum{provider="google-maps"} 0.84');
    expect(text).toContain('spend_brake_upstream_duration_seconds_count{provider="google-maps"} 3');
    expect(text).toContain('spend_brake_remaining_usd{scope="org",window="day"} 4.985');
    expect(text).toContain('spend_brake_cap_usd{scope="org",window="day"} 5');
    expect(text).not.toContain('spend_brake_cap_usd{scope="key:key_1"');
  });

  it('never lowers a counter: settlement refunds count on their own', () => {
    const text = render([
      call({ costMicros: 79_000n }),
      call({ streamId: '2-0', type: 'adjustment', costMicros: -71_100n, status: null }),
    ]);
    expect(text).toContain(
      'spend_brake_cost_usd_total{agent="",env="prod",key="key_1",provider="google-maps",sku="gmp.geocoding"} 0.079',
    );
    expect(text).toContain(
      'spend_brake_refunds_usd_total{agent="",env="prod",key="key_1",provider="google-maps",sku="gmp.geocoding"} 0.0711',
    );
  });

  it('labels agent session calls by agent, not by the per-session key', () => {
    const [[field]] = callIncrements(
      call({ keyId: 'key_sess_9', session: 's-1', agentId: 'researcher' }),
    ) as [[string, number]];
    expect(field).toContain('agent="researcher"');
    expect(field).toContain('key=""');
  });

  it('escapes label values', () => {
    const text = render([call({ env: 'a"b\\c\nd' })]);
    expect(text).toContain('env="a\\"b\\\\c\\nd"');
  });
});

describe('spans', () => {
  it('joins the caller’s trace when the call carried a traceparent', () => {
    const span = callSpan(
      call({
        data: {
          upstreamMs: '100',
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          parentSpanId: '00f067aa0ba902b7',
          userAgent: 'my-app/1.0',
          reqBytes: '0',
          resBytes: '1234',
        },
      }),
    );
    expect(span).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      name: 'google-maps geocode',
      kind: 3,
      status: { code: 1 },
      endTimeUnixNano: '1793361600000000000',
      startTimeUnixNano: '1793361599880000000',
    });
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    const attrs = Object.fromEntries(
      span.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
    );
    expect(attrs).toMatchObject({
      'http.response.status_code': '200',
      'http.response.body.size': '1234',
      'user_agent.original': 'my-app/1.0',
      'spend_brake.cost_usd': 0.005,
      'spend_brake.outcome': 'ok',
      'spend_brake.sku': 'gmp.geocoding',
      'spend_brake.key_id': 'key_1',
    });
  });

  it('starts its own stable trace otherwise, and marks refusals as errors', () => {
    const a = callSpan(call({ type: 'blocked', status: null, data: { reason: 'killed' } }));
    const b = callSpan(call({ type: 'blocked', status: null, data: { reason: 'killed' } }));
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.parentSpanId).toBeUndefined();
    expect(a).toEqual(b);
    expect(a.status).toEqual({ code: 2, message: 'killed' });
  });

  it('names outcomes', () => {
    expect(outcomeOf({ type: 'usage', status: 503, data: {} })).toBe('http_5xx');
    expect(outcomeOf({ type: 'usage', status: 0, data: { error: 'upstream_unreachable' } })).toBe(
      'upstream_error',
    );
    expect(outcomeOf({ type: 'loop', status: null, data: { reason: 'loop_detected' } })).toBe(
      'loop_detected',
    );
  });

  it('finds the traces URL', () => {
    expect(tracesUrl('https://otlp.example.com')).toBe('https://otlp.example.com/v1/traces');
    expect(tracesUrl('https://otlp.example.com/otlp/')).toBe(
      'https://otlp.example.com/otlp/v1/traces',
    );
    expect(tracesUrl('https://x.example.com/v1/traces')).toBe('https://x.example.com/v1/traces');
  });
});
