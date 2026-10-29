import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, usd } from '../api.js';
import { Table } from '../ui.js';

interface Page {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

export function Events() {
  const [source, setSource] = useState<'usage' | 'audit'>('usage');
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
        <div className="seg" role="tablist">
          {(['usage', 'audit'] as const).map((x) => (
            <button
              key={x}
              type="button"
              role="tab"
              aria-selected={source === x}
              onClick={() => setSource(x)}
            >
              {x === 'usage' ? 'Requests' : 'Audit log'}
            </button>
          ))}
        </div>
      </div>
      {q.isError && <p className="error">{q.error.message}</p>}
      {source === 'usage' ? (
        <Table
          rows={rows}
          columns={[
            { label: 'Time', render: (r) => s(r.ts).replace('T', ' ').slice(0, 19) },
            { label: 'Type', render: (r) => s(r.type) },
            { label: 'Key', render: (r) => <code>{s(r.keyId)}</code> },
            { label: 'SKU', render: (r) => s(r.sku) },
            { label: 'Status', render: (r) => s(r.status), numeric: true },
            { label: 'Cost', render: (r) => usd(r.costMicros as number | null, 4), numeric: true },
          ]}
        />
      ) : (
        <Table
          rows={rows}
          columns={[
            { label: 'Time', render: (r) => s(r.at).replace('T', ' ').slice(0, 19) },
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
