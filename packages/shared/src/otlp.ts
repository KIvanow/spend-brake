// OpenTelemetry export of an org's calls to the org's own collector: one span per call, in
// OTLP/HTTP JSON (no SDK: the spans describe calls that already happened, in another process).
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'undici';
import { type GuardedClient, privateLiteralHost } from './egress.js';
import { redactText } from './redact.js';

/** A call as the ledger records it (the fields a span needs). */
export interface CallRecord {
  orgId: string;
  /** Stream entry id: unique per call, so the span id is stable across retries. */
  streamId: string;
  type: string;
  /** When the call finished. */
  ts: Date;
  reqId: string | null;
  keyId: string | null;
  provider: string | null;
  route: string | null;
  skus: string | null;
  costMicros: bigint | null;
  worstMicros: bigint | null;
  status: number | null;
  latencyMs: number | null;
  session: string | null;
  env: string | null;
  agentId: string | null;
  data: Record<string, unknown>;
}

type Value = { stringValue: string } | { intValue: string } | { doubleValue: number };
interface Attribute {
  key: string;
  value: Value;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number; message?: string };
}

const SPAN_KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

const str = (key: string, v: unknown): Attribute[] =>
  typeof v === 'string' && v !== '' ? [{ key, value: { stringValue: v } }] : [];
const int = (key: string, v: unknown): Attribute[] => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n)
    ? [{ key, value: { intValue: String(n) } }]
    : [];
};
const dbl = (key: string, v: number | null | undefined): Attribute[] =>
  typeof v === 'number' && Number.isFinite(v) ? [{ key, value: { doubleValue: v } }] : [];

const hex = (input: string, bytes: number) =>
  createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, bytes * 2);

const usd = (micros: bigint | null) => (micros === null ? null : Number(micros) / 1_000_000);

/** Why a call ended the way it did: ok, the HTTP error, or what Spend Brake refused. */
export function outcomeOf(c: Pick<CallRecord, 'type' | 'status' | 'data'>): string {
  if (c.type !== 'usage') return typeof c.data.reason === 'string' ? c.data.reason : c.type;
  if (typeof c.data.error === 'string' && c.data.error) {
    return c.status ? `http_${Math.floor(c.status / 100)}xx` : 'upstream_error';
  }
  if (c.status === null || c.status === 0) return 'upstream_error';
  return c.status < 400 ? 'ok' : `http_${Math.floor(c.status / 100)}xx`;
}

/**
 * One span per call. With the caller's `traceparent`, the span joins their trace as a child of
 * their span; otherwise it starts a trace of its own (stable per call).
 */
export function callSpan(c: CallRecord): OtlpSpan {
  const d = c.data;
  const traceId =
    typeof d.traceId === 'string' && /^[0-9a-f]{32}$/.test(d.traceId)
      ? d.traceId
      : hex(`trace:${c.orgId}:${c.streamId}`, 16);
  const parent =
    typeof d.parentSpanId === 'string' && /^[0-9a-f]{16}$/.test(d.parentSpanId)
      ? d.parentSpanId
      : undefined;
  const endNs = BigInt(c.ts.getTime()) * 1_000_000n;
  const durNs = BigInt(Math.max(0, Math.round((c.latencyMs ?? 0) * 1_000_000)));
  const outcome = outcomeOf(c);
  const blocked = c.type !== 'usage';
  const failed = blocked || outcome !== 'ok';
  const sku = c.skus?.split(',')[0] ?? null;
  return {
    traceId,
    spanId: hex(`span:${c.orgId}:${c.streamId}`, 8),
    ...(parent ? { parentSpanId: parent } : {}),
    name: `${c.provider ?? 'call'} ${c.route ?? sku ?? ''}`.trim(),
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: (endNs - durNs).toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: [
      ...int('http.response.status_code', c.status || undefined),
      ...int('http.request.body.size', d.reqBytes),
      ...int('http.response.body.size', d.resBytes),
      ...str('user_agent.original', d.userAgent),
      ...str('spend_brake.request_id', c.reqId),
      ...str('spend_brake.provider', c.provider),
      ...str('spend_brake.route', c.route),
      ...str('spend_brake.sku', sku),
      ...str('spend_brake.skus', c.skus),
      ...str('spend_brake.key_id', c.keyId),
      ...str('spend_brake.session', c.session),
      ...str('spend_brake.agent_id', c.agentId),
      ...str('spend_brake.env', c.env),
      ...str('spend_brake.outcome', outcome),
      ...str('spend_brake.blocked_scope', d.scope),
      ...dbl('spend_brake.cost_usd', usd(c.costMicros)),
      ...dbl('spend_brake.reserved_usd', usd(c.worstMicros)),
      ...dbl(
        'spend_brake.upstream_duration_ms',
        typeof d.upstreamMs === 'string' ? Number(d.upstreamMs) : null,
      ),
    ],
    status: failed ? { code: STATUS_ERROR, message: outcome } : { code: STATUS_OK },
  };
}

/** A span that says the export works (the dashboard's "Send test span"). */
export function testSpan(orgId: string, now: Date): OtlpSpan {
  const id = randomBytes(8).toString('hex');
  return callSpan({
    orgId,
    streamId: `test-${id}`,
    type: 'usage',
    ts: now,
    reqId: `test-${id}`,
    keyId: null,
    provider: 'spend-brake',
    route: 'test',
    skus: null,
    costMicros: 0n,
    worstMicros: 0n,
    status: 200,
    latencyMs: 1,
    session: null,
    env: null,
    agentId: null,
    data: {},
  });
}

export function otlpPayload(orgId: string, spans: OtlpSpan[]): object {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'spend-brake' } },
            { key: 'spend_brake.org_id', value: { stringValue: orgId } },
          ],
        },
        scopeSpans: [{ scope: { name: 'spend-brake', version: '1' }, spans }],
      },
    ],
  };
}

/** Where traces go: the endpoint as given if it names /v1/traces, else <endpoint>/v1/traces. */
export function tracesUrl(endpoint: string): string {
  const u = new URL(endpoint);
  if (!u.pathname.endsWith('/v1/traces')) u.pathname = `${u.pathname.replace(/\/$/, '')}/v1/traces`;
  return u.href;
}

export interface ExportResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** POST spans to an org's collector, refusing private addresses. Never follows redirects. */
export async function postSpans(
  endpoint: string,
  headers: Record<string, string>,
  orgId: string,
  spans: OtlpSpan[],
  opts: { dispatcher: GuardedClient; timeoutMs?: number },
): Promise<ExportResult> {
  const url = tracesUrl(endpoint);
  const literal = privateLiteralHost(url);
  if (literal && !opts.dispatcher.allowPrivate) {
    return { ok: false, status: null, error: `collector host is a private address (${literal})` };
  }
  try {
    const res = await request(url, {
      method: 'POST',
      body: JSON.stringify(otlpPayload(orgId, spans)),
      dispatcher: opts.dispatcher.agent,
      headersTimeout: opts.timeoutMs ?? 10_000,
      bodyTimeout: opts.timeoutMs ?? 10_000,
      headers: {
        ...headers,
        'content-type': 'application/json',
        'user-agent': 'spend-brake-otlp',
      },
    });
    const text = (await res.body.text()).slice(0, 300);
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    return {
      ok,
      status: res.statusCode,
      error: ok
        ? null
        : redactText(`HTTP ${res.statusCode}${text ? `: ${text}` : ''}`, Object.values(headers)),
    };
  } catch (err) {
    // Header values are credentials (API keys): never let one into the stored error.
    return {
      ok: false,
      status: null,
      error: redactText((err as Error).message, Object.values(headers)).slice(0, 300),
    };
  }
}
