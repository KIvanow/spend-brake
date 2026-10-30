// An org's own Prometheus metrics: the worker counts each call into a Valkey hash once (as the
// ledger first records it), the admin API renders the hash at GET /v1/metrics. Both sides use
// these functions, so field names and labels cannot drift apart.
import { type CallRecord, outcomeOf } from './otlp.js';

/** Valkey hash holding an org's counters (one hash slot per org, like every org key). */
export const orgMetricsKey = (orgId: string) => `bk:{o:${orgId}}:metrics`;
/** Valkey list of spans waiting for the org's collector (newest first). */
export const otlpQueueKey = (orgId: string) => `bk:{o:${orgId}}:otlp`;
/** At most this many spans wait for a collector that is down; older ones are dropped. */
export const OTLP_QUEUE_MAX = 10_000;

/** Encryption context of an org's OTLP request headers. */
export const otlpHeadersContext = (orgId: string) => ({ purpose: 'otlp-headers', orgId });

export const DURATION_BUCKETS_S = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

const SEP = '\u001f';

function labelString(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map(
      (k) =>
        `${k}="${labels[k]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
}

/**
 * Counter increments for one call: field -> amount. Calls inside an agent session are labelled
 * by agent rather than key (session keys are minted per session: one series each would grow
 * without bound).
 */
export function callIncrements(c: CallRecord): [string, number][] {
  const sku = c.skus?.split(',')[0] ?? '';
  const who = {
    provider: c.provider ?? '',
    sku,
    key: c.session ? '' : (c.keyId ?? ''),
    agent: c.agentId ?? '',
    env: c.env ?? '',
  };
  const out: [string, number][] = [];
  const cost = c.costMicros ?? 0n;
  if (c.type === 'adjustment') {
    // Later settlement (Twilio): counters never go down, so refunds count on their own.
    if (cost > 0n) out.push([`cost${SEP}${labelString(who)}`, Number(cost)]);
    if (cost < 0n) out.push([`refund${SEP}${labelString(who)}`, Number(-cost)]);
    return out;
  }
  if (c.type !== 'usage' && c.type !== 'blocked' && c.type !== 'loop') return out;
  out.push([`req${SEP}${labelString({ ...who, outcome: outcomeOf(c) })}`, 1]);
  if (c.type !== 'usage') return out;
  if (cost > 0n) out.push([`cost${SEP}${labelString(who)}`, Number(cost)]);
  const histogram = (name: string, ms: number | null) => {
    if (ms === null || !Number.isFinite(ms) || ms < 0) return;
    const labels = labelString({ provider: who.provider });
    const s = ms / 1000;
    const i = DURATION_BUCKETS_S.findIndex((b) => s <= b);
    out.push([`${name}${SEP}${labels}${SEP}${i === -1 ? 'inf' : i}`, 1]);
    // Microseconds, so the sum stays an integer (HINCRBY).
    out.push([`${name}_sum${SEP}${labels}`, Math.round(ms * 1000)]);
  };
  histogram('dur', c.latencyMs);
  const upstream = typeof c.data.upstreamMs === 'string' ? Number(c.data.upstreamMs) : null;
  histogram('up', upstream);
  return out;
}

export interface BudgetGauge {
  scope: string;
  window: string;
  spentMicros: number;
  hardMicros: number | null;
  remainingMicros: number | null;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toPrecision(15).replace(/0+$/, ''));
const usd = (micros: number) => fmt(micros / 1_000_000);

/** The org's counters and live budget in the Prometheus text format. */
export function renderOrgMetrics(hash: Record<string, string>, budget: BudgetGauge[]): string {
  const series = new Map<string, [string, number][]>();
  const add = (metric: string, labels: string, value: number) => {
    const list = series.get(metric) ?? [];
    list.push([labels, value]);
    series.set(metric, list);
  };
  const buckets = new Map<string, number[]>(); // name|labels -> per-bucket counts (+Inf last)
  const sums = new Map<string, number>();
  for (const [field, raw] of Object.entries(hash)) {
    const [kind, labels = '', bucket] = field.split(SEP);
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (kind === 'req') add('spend_brake_requests_total', labels, value);
    else if (kind === 'cost') add('spend_brake_cost_usd_total', labels, value / 1_000_000);
    else if (kind === 'refund') add('spend_brake_refunds_usd_total', labels, value / 1_000_000);
    else if ((kind === 'dur' || kind === 'up') && bucket !== undefined) {
      const k = `${kind}${SEP}${labels}`;
      const counts = buckets.get(k) ?? new Array<number>(DURATION_BUCKETS_S.length + 1).fill(0);
      const i = bucket === 'inf' ? DURATION_BUCKETS_S.length : Number(bucket);
      if (i >= 0 && i < counts.length) counts[i]! += value;
      buckets.set(k, counts);
    } else if (kind === 'dur_sum' || kind === 'up_sum') {
      sums.set(`${kind.slice(0, -4)}${SEP}${labels}`, value);
    }
  }

  const lines: string[] = [];
  const counter = (name: string, help: string) => {
    const list = series.get(name);
    if (!list?.length) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const [labels, v] of list.sort()) lines.push(`${name}{${labels}} ${fmt(v)}`);
  };
  counter(
    'spend_brake_requests_total',
    'Calls through Spend Brake by provider, SKU, key, agent, environment and outcome.',
  );
  counter('spend_brake_cost_usd_total', 'What the calls cost, in US dollars.');
  counter(
    'spend_brake_refunds_usd_total',
    'Cost given back when a provider settled below the reserved price, in US dollars.',
  );
  const histogram = (kind: string, name: string, help: string) => {
    const entries = [...buckets].filter(([k]) => k.startsWith(`${kind}${SEP}`)).sort();
    if (!entries.length) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
    for (const [k, counts] of entries) {
      const labels = k.slice(kind.length + 1);
      let total = 0;
      DURATION_BUCKETS_S.forEach((le, i) => {
        total += counts[i]!;
        lines.push(`${name}_bucket{${labels},le="${le}"} ${total}`);
      });
      total += counts[DURATION_BUCKETS_S.length]!;
      lines.push(`${name}_bucket{${labels},le="+Inf"} ${total}`);
      lines.push(`${name}_sum{${labels}} ${fmt((sums.get(k) ?? 0) / 1_000_000)}`);
      lines.push(`${name}_count{${labels}} ${total}`);
    }
  };
  histogram('dur', 'spend_brake_request_duration_seconds', 'Time of the whole call, in seconds.');
  histogram(
    'up',
    'spend_brake_upstream_duration_seconds',
    "Time the provider took to answer, in seconds (the rest is Spend Brake's).",
  );
  const gauge = (name: string, help: string, pick: (b: BudgetGauge) => number | null) => {
    const rows = budget.filter((b) => pick(b) !== null);
    if (!rows.length) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const b of rows) {
      lines.push(`${name}{${labelString({ scope: b.scope, window: b.window })}} ${usd(pick(b)!)}`);
    }
  };
  gauge(
    'spend_brake_spent_usd',
    'Spent in the current day or month window, per scope.',
    (b) => b.spentMicros,
  );
  gauge('spend_brake_cap_usd', 'Hard cap of the window, per scope.', (b) => b.hardMicros);
  gauge(
    'spend_brake_remaining_usd',
    'What can still be spent in the window before calls are refused.',
    (b) => b.remainingMicros,
  );
  return `${lines.join('\n')}\n`;
}
