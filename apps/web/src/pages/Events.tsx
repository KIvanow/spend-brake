import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download, usd } from '../api.js';
import { TIME_LABEL, Table, Time } from '../ui.js';
import { useKeys } from './Keys.js';

interface Page {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

export function Events() {
  const [source, setSource] = useState<'usage' | 'audit'>('usage');
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ error?: string; truncated?: boolean } | null>(null);
  // The current view: the tab shown. The API caps one file at its newest 100,000 rows.
  const exportCsv = async () => {
    setExporting(true);
    setExported(null);
    try {
      const headers = await download(
        `/v1/events.csv?source=${source}`,
        `spend-brake-${source === 'usage' ? 'requests' : 'audit'}.csv`,
      );
      setExported({ truncated: headers.get('x-brake-truncated') === 'true' });
    } catch (err) {
      setExported({ error: (err as Error).message });
    } finally {
      setExporting(false);
    }
  };
  const q = useInfiniteQuery({
    queryKey: ['events', source],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<Page>(
        `/v1/events?source=${source}&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const keys = useKeys();
  const keyName = new Map((keys.data?.items ?? []).map((k) => [k.id, k.name]));
  const s = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
    return JSON.stringify(v);
  };

  return (
    <section>
      <div className="row">
        <h2>Events</h2>
        <div className="tools">
          <div className="seg" role="tablist">
            {(['usage', 'audit'] as const).map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={source === x}
                onClick={() => {
                  setSource(x);
                  setExported(null);
                }}
              >
                {x === 'usage' ? 'Requests' : 'Audit log'}
              </button>
            ))}
          </div>
          <button type="button" disabled={exporting} onClick={() => void exportCsv()}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
      <p className="muted" role="status">
        {exported?.error ? (
          <span className="error">Export failed: {exported.error}</span>
        ) : exported?.truncated ? (
          'Exported the newest 100,000 rows, the most one file holds. Older rows are left out.'
        ) : exported ? (
          `Exported every ${source === 'usage' ? 'request' : 'audit log entry'} (times in UTC).`
        ) : null}
      </p>
      {q.isError && <p className="error">{q.error.message}</p>}
      {source === 'usage' ? (
        <Table
          rows={rows}
          columns={[
            { label: TIME_LABEL, render: (r) => <Time iso={s(r.ts)} /> },
            { label: 'Type', render: (r) => s(r.type) },
            {
              label: 'Key',
              render: (r) => keyName.get(s(r.keyId)) ?? <code>{s(r.keyId)}</code>,
            },
            { label: 'SKU', render: (r) => s(r.sku) },
            // ok, the provider's error, or why Spend Brake refused it (cap, kill, loop, ...).
            { label: 'Outcome', render: (r) => s(r.outcome) },
            { label: 'Status', render: (r) => (r.status ? s(r.status) : ''), numeric: true },
            { label: 'Cost', render: (r) => usd(r.costMicros as number | null, 4), numeric: true },
          ]}
        />
      ) : (
        <Table
          rows={rows}
          columns={[
            { label: TIME_LABEL, render: (r) => <Time iso={s(r.at)} /> },
            { label: 'Actor', render: (r) => <code>{s(r.actor)}</code> },
            { label: 'Action', render: (r) => s(r.action) },
            { label: 'Target', render: (r) => <code>{s(r.target)}</code> },
            { label: 'Reason', render: (r) => s(r.reason) },
          ]}
        />
      )}
      {q.hasNextPage && (
        <button
          type="button"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load more
        </button>
      )}
    </section>
  );
}
