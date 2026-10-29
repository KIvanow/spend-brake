import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { Table } from '../ui.js';

interface Webhook {
  id: string;
  name: string;
  preset: string;
  urlHint: string;
  events: string[];
  createdAt: string;
}

interface Delivery {
  alertId: string;
  type: string;
  attempt: number;
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  at: string;
}

/** Alert webhooks and their delivery log. Webhooks are added with the API or CLI. */
export function Webhooks() {
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<{ items: Webhook[] }>('/v1/webhooks'),
  });
  const [open, setOpen] = useState<string | null>(null);
  const log = useQuery({
    queryKey: ['deliveries', open],
    queryFn: () =>
      api<{ items: Delivery[] }>(`/v1/webhooks/${encodeURIComponent(open!)}/deliveries`),
    enabled: open !== null,
    refetchInterval: 10_000,
  });
  return (
    <section>
      <h2>Alert webhooks</h2>
      <p className="muted">
        Signed JSON posts to Slack, Discord, Teams or any URL. URLs are stored encrypted; only the
        host is shown.
      </p>
      {hooks.isError && <p className="error">{hooks.error.message}</p>}
      <Table
        rows={hooks.data?.items ?? []}
        empty="No webhooks: alerts go to the org's alert email, if set."
        columns={[
          { label: 'Name', render: (w) => w.name },
          { label: 'Preset', render: (w) => w.preset },
          { label: 'Host', render: (w) => <code>{w.urlHint}</code> },
          { label: 'Alerts', render: (w) => (w.events.length ? w.events.join(', ') : 'all') },
          {
            label: '',
            render: (w) => (
              <button
                type="button"
                aria-pressed={open === w.id}
                onClick={() => setOpen(open === w.id ? null : w.id)}
              >
                Delivery log
              </button>
            ),
          },
        ]}
      />
      {open && (
        <>
          <h3>Deliveries</h3>
          {log.isError && <p className="error">{log.error.message}</p>}
          <Table
            rows={log.data?.items ?? []}
            empty="Nothing delivered yet."
            columns={[
              { label: 'Time', render: (d) => d.at.replace('T', ' ').slice(0, 19) },
              { label: 'Alert', render: (d) => d.type },
              { label: 'Attempt', render: (d) => d.attempt, numeric: true },
              {
                label: 'Result',
                render: (d) => (
                  <span className={d.ok ? 'badge' : 'badge danger'}>
                    {d.ok ? 'delivered' : 'failed'}
                  </span>
                ),
              },
              { label: 'HTTP', render: (d) => d.httpStatus ?? '', numeric: true },
              { label: 'Error', render: (d) => d.error ?? '' },
            ]}
          />
        </>
      )}
    </section>
  );
}
