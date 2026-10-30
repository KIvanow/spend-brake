import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, usd } from '../api.js';
import { BarChart, Table } from '../ui.js';

type Row = Record<string, string | number | null> & { costMicros: number; requests: number };

const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export function Spend() {
  const [days, setDays] = useState(30);
  const [by, setBy] = useState<'key' | 'sku' | 'provider' | 'session' | 'agent'>('key');
  const daily = useQuery({
    queryKey: ['spend', 'day', days],
    queryFn: () =>
      api<{ items: Row[] }>(`/v1/spend?groupBy=day&from=${encodeURIComponent(since(days))}`),
  });
  const grouped = useQuery({
    queryKey: ['spend', by, days],
    queryFn: () =>
      api<{ items: Row[] }>(`/v1/spend?groupBy=${by}&from=${encodeURIComponent(since(days))}`),
  });
  const total = (daily.data?.items ?? []).reduce((a, r) => a + r.costMicros, 0);
  const rec = useQuery({
    queryKey: ['reconciliation'],
    queryFn: () =>
      api<{ configured: boolean; message: string; lastError: string | null }>('/v1/reconciliation'),
  });
  const drift = useQuery({
    queryKey: ['reconciliation', 'report'],
    queryFn: () =>
      api<{
        items: {
          day: string;
          family: string;
          ledgerMicros: number;
          billedMicros: number;
          driftRatio: number | null;
        }[];
      }>('/v1/reconciliation/report'),
    enabled: rec.data?.configured === true,
  });

  return (
    <section>
      <div className="row">
        <h2>Spend</h2>
        <label>
          Period{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>
      <p className="stat">
        {usd(total)} <span className="muted">in the last {days} days (from the ledger)</span>
      </p>
      {daily.isError ? (
        <p className="error">{daily.error.message}</p>
      ) : (
        <BarChart
          data={(daily.data?.items ?? []).map((r) => ({
            label: String(r.day),
            value: r.costMicros,
          }))}
        />
      )}
      <h3>Compared with Google's bill</h3>
      <p className={rec.data?.lastError ? 'error' : 'muted'}>
        {rec.isError
          ? 'Comparing spend with the bill is part of the Business and Enterprise editions.'
          : rec.data?.lastError
            ? `Last check failed: ${rec.data.lastError}`
            : (rec.data?.message ?? '')}
      </p>
      {rec.data?.configured && (
        <Table
          rows={(drift.data?.items ?? []).filter((r) => r.family === 'total')}
          empty="No billing days compared yet."
          columns={[
            { label: 'Billing day (PT)', render: (r) => r.day },
            { label: 'Proxy ledger', render: (r) => usd(r.ledgerMicros), numeric: true },
            { label: 'Google bill', render: (r) => usd(r.billedMicros), numeric: true },
            {
              label: 'Drift',
              render: (r) =>
                r.driftRatio === null ? (
                  '—'
                ) : (
                  <span className={r.driftRatio > 0.05 ? 'badge danger' : 'badge'}>
                    {(r.driftRatio * 100).toFixed(1)}%
                  </span>
                ),
              numeric: true,
            },
          ]}
        />
      )}
      <div className="row">
        <h3>By {by}</h3>
        <label>
          Group by{' '}
          <select value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
            <option value="key">key</option>
            <option value="sku">SKU</option>
            <option value="provider">provider</option>
            <option value="session">session</option>
            <option value="agent">agent</option>
          </select>
        </label>
      </div>
      <Table
        rows={[...(grouped.data?.items ?? [])].sort((a, b) => b.costMicros - a.costMicros)}
        columns={[
          { label: by, render: (r) => <code>{String(r[by] ?? '—')}</code> },
          { label: 'Requests', render: (r) => r.requests.toLocaleString('en-US'), numeric: true },
          { label: 'Cost', render: (r) => usd(r.costMicros, 4), numeric: true },
        ]}
      />
    </section>
  );
}
