import { useQuery } from '@tanstack/react-query';
import { api, usd } from '../api.js';
import { Table } from '../ui.js';

interface Estimate {
  googleCostMicros: number;
  requests: number;
  verifiedAt: string;
  alternatives: {
    provider: string;
    name: string;
    source: string;
    plan: string | null;
    monthlyCostMicros: number | null;
    uncoveredGoogleCostMicros: number;
    totalMicros: number | null;
    uncovered: { sku: string }[];
    notes: string[];
  }[];
}

export function Migration() {
  const q = useQuery({
    queryKey: ['estimate'],
    queryFn: () => api<Estimate>('/v1/estimates/migration', { method: 'POST', body: { days: 30 } }),
  });
  if (q.isPending) return <p className="muted">Pricing your last 30 days…</p>;
  if (q.isError) return <p className="error">{q.error.message}</p>;
  const e = q.data;
  return (
    <section>
      <h2>Migration estimate</h2>
      <p className="muted">
        Your last 30 days ({e.requests.toLocaleString('en-US')} billed requests,{' '}
        {usd(e.googleCostMicros)} on Google) priced on OSM-based providers. Work a provider cannot
        do stays on Google. Prices verified {e.verifiedAt}.
      </p>
      <Table
        // Cheapest first; "contact sales" (no price) last.
        rows={[...e.alternatives].sort(
          (a, b) =>
            Number(a.totalMicros === null) - Number(b.totalMicros === null) ||
            (a.totalMicros ?? 0) - (b.totalMicros ?? 0),
        )}
        columns={[
          {
            label: 'Provider',
            render: (a) => (
              <a href={a.source} target="_blank" rel="noreferrer">
                {a.name}
              </a>
            ),
          },
          { label: 'Plan', render: (a) => a.plan ?? 'custom' },
          { label: 'Plan cost', render: (a) => usd(a.monthlyCostMicros), numeric: true },
          {
            label: 'Left on Google',
            render: (a) => usd(a.uncoveredGoogleCostMicros),
            numeric: true,
          },
          {
            label: 'Total / month',
            render: (a) => (a.totalMicros === null ? 'contact sales' : usd(a.totalMicros)),
            numeric: true,
          },
          { label: 'Not covered', render: (a) => a.uncovered.map((u) => u.sku).join(', ') },
        ]}
      />
    </section>
  );
}
