import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download, usd } from '../api.js';
import { TIME_LABEL, Table, Time } from '../ui.js';
import { useKeys } from './Keys.js';

interface Page {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

/**
 * The start of a local calendar day (a date input's `YYYY-MM-DD`, plus `addDays`) in this
 * browser's time zone, as ISO 8601 with its offset: `2026-10-31T00:00:00+02:00`. Where a zone
 * skips midnight (a DST change), it is the first local time that day.
 */
export function localDayStart(day: string, addDays = 0): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y!, m! - 1, d! + addDays);
  const p = (v: number) => String(v).padStart(2, '0');
  const off = -t.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  return (
    `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}` +
    `T${p(t.getHours())}:${p(t.getMinutes())}:00${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

/** What a complete export holds, in words. */
function exportedText(source: 'usage' | 'audit', rows: number, ranged: boolean): string {
  const [one, many] =
    source === 'usage' ? ['request', 'requests'] : ['audit log entry', 'audit log entries'];
  const days = ranged ? ' in the dates picked (your local days)' : '';
  if (rows === 0) return `No ${many}${days}: the file has only the header row.`;
  const count = rows === 1 ? `1 ${one}` : `${rows.toLocaleString('en-US')} ${many}`;
  return `Exported ${count}${days}. Times in the file are UTC.`;
}

/** Data rows in an exported CSV: row ends outside quotes, less the header. */
function csvDataRows(text: string): number {
  let rows = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '\n') rows++;
  }
  return Math.max(rows - 1, 0);
}

export function Events() {
  const [source, setSource] = useState<'usage' | 'audit'>('usage');
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{
    error?: string;
    truncated?: boolean;
    ranged?: boolean;
    rows?: number;
  } | null>(null);
  // Optional local days, as the table shows times: From's midnight up to the midnight after To.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const backwards = !!from && !!to && from > to;
  // The current view: the tab shown. The API caps one file at its newest 100,000 rows.
  const exportCsv = async () => {
    if (backwards) return;
    setExporting(true);
    setExported(null);
    const bound = (name: string, day: string, addDays: number) =>
      day ? `&${name}=${encodeURIComponent(localDayStart(day, addDays))}` : '';
    const range = `${bound('from', from, 0)}${bound('to', to, 1)}`;
    try {
      const { headers, blob } = await download(
        `/v1/events.csv?source=${source}${range}`,
        `spend-brake-${source === 'usage' ? 'requests' : 'audit'}.csv`,
      );
      setExported({
        truncated: headers.get('x-brake-truncated') === 'true',
        ranged: !!range,
        rows: csvDataRows(await blob.text()),
      });
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
          <label>
            From
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button type="button" disabled={exporting || backwards} onClick={() => void exportCsv()}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
      <p className="muted" role="status">
        {backwards ? (
          <span className="error">From is after To. Pick a From date on or before To.</span>
        ) : exported?.error ? (
          <span className="error">Export failed: {exported.error}</span>
        ) : exported?.truncated ? (
          'Exported the newest 100,000 rows, the most one file holds. Older rows are left out: set an earlier To date to get them.'
        ) : exported ? (
          exportedText(source, exported.rows ?? 0, !!exported.ranged)
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
