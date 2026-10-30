import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../api.js';
import { useRole } from '../role.js';
import { CopyButton, TIME_LABEL, Table, Time } from '../ui.js';

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

/** Where alerts go when no webhook takes them: the org's alert email (owners change it). */
function AlertEmail() {
  const qc = useQueryClient();
  const { can } = useRole();
  const org = useQuery({
    queryKey: ['org'],
    queryFn: () => api<{ settings?: { alertEmail?: string | null } }>('/v1/org'),
  });
  const current = org.data?.settings?.alertEmail ?? null;
  const [email, setEmail] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (alertEmail: string | null) =>
      api('/v1/org', { method: 'PUT', body: { alertEmail } }),
    onSuccess: () => {
      setEmail(null);
      void qc.invalidateQueries({ queryKey: ['org'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = (email ?? current ?? '').trim();
    save.mutate(v === '' ? null : v);
  };
  return (
    <>
      <h2>Alert email</h2>
      <p className="muted">
        Cap warnings, loop pauses and rejected provider keys are emailed here, with Kill, Raise and
        Mute links, when no webhook takes them.{' '}
        {current ? (
          <>
            Now: <strong>{current}</strong>.
          </>
        ) : (
          <strong>No address set: alerts with no webhook are dropped.</strong>
        )}
      </p>
      {can('owner') ? (
        <form className="form" onSubmit={submit} aria-label="Alert email">
          <label className="grow">
            Email alerts to
            <input
              type="email"
              value={email ?? current ?? ''}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ops@example.com"
            />
          </label>
          <button type="submit" className="primary" disabled={save.isPending}>
            Save
          </button>
        </form>
      ) : (
        <p className="muted">Owners can change it.</p>
      )}
      {save.isError && <p className="error">{save.error.message}</p>}
    </>
  );
}

const PRESETS = [
  { id: 'slack', name: 'Slack', hint: 'https://hooks.slack.com/services/…' },
  { id: 'discord', name: 'Discord', hint: 'https://discord.com/api/webhooks/…' },
  { id: 'teams', name: 'Microsoft Teams', hint: 'https://….webhook.office.com/…' },
  { id: 'raw', name: 'Any URL (signed JSON)', hint: 'https://example.com/spend-brake' },
] as const;

/**
 * Add a webhook (admins and owners). Its signing secret is shown once, until the webhook is
 * deleted (`removed`).
 */
function AddWebhook({ removed }: { removed: ReadonlySet<string> }) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('slack');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const info = PRESETS.find((p) => p.id === preset)!;
  const add = useMutation({
    mutationFn: () =>
      api<Webhook & { secret: string }>('/v1/webhooks', {
        method: 'POST',
        body: { name: name.trim() || info.name, url: url.trim(), preset },
      }),
    onSuccess: () => {
      setName('');
      setUrl('');
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <>
      <form className="form" onSubmit={submit} aria-label="Add a webhook">
        <h3>Add a webhook</h3>
        <label>
          Send to
          <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={info.name}
            maxLength={200}
          />
        </label>
        <label className="grow">
          Webhook URL
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={info.hint}
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" className="primary" disabled={add.isPending}>
          Add webhook
        </button>
        <p className="muted full">
          It gets every alert instead of the alert email: while any webhook takes an alert, that
          alert is not emailed. The URL is stored encrypted.
        </p>
      </form>
      {add.isError && <p className="error">{add.error.message}</p>}
      {add.data && !removed.has(add.data.id) && (
        <div className="callout">
          <p>
            <strong>Added {add.data.name}.</strong> Each post is signed with this secret, so your
            endpoint can check it came from Spend Brake. Copy it now: it is not shown again.
          </p>
          <p className="secret">
            <code>{add.data.secret}</code>
            <CopyButton text={add.data.secret} />
          </p>
        </div>
      )}
    </>
  );
}

/** Alert webhooks and their delivery log. */
export function Webhooks() {
  const qc = useQueryClient();
  const { can } = useRole();
  const [open, setOpen] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      setOpen((o) => (o === id ? null : o));
      setRemoved((r) => new Set(r).add(id));
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<{ items: Webhook[] }>('/v1/webhooks'),
  });
  const log = useQuery({
    queryKey: ['deliveries', open],
    queryFn: () =>
      api<{ items: Delivery[] }>(`/v1/webhooks/${encodeURIComponent(open!)}/deliveries`),
    enabled: open !== null,
    refetchInterval: 10_000,
  });
  return (
    <section>
      <AlertEmail />
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
              <>
                <button
                  type="button"
                  aria-pressed={open === w.id}
                  onClick={() => setOpen(open === w.id ? null : w.id)}
                >
                  Delivery log
                </button>
                {can('admin') && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="danger"
                      aria-label={`Delete webhook ${w.name}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        const last = (hooks.data?.items.length ?? 0) <= 1;
                        const next = last
                          ? 'Alerts go back to the alert email.'
                          : 'Alerts no other webhook takes go back to the alert email.';
                        if (window.confirm(`Delete the webhook "${w.name}"? ${next}`)) {
                          remove.mutate(w.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </>
            ),
          },
        ]}
      />
      {remove.isError && <p className="error">{remove.error.message}</p>}
      {can('admin') ? (
        <AddWebhook removed={removed} />
      ) : (
        <p className="muted">Admins and owners can add and delete webhooks.</p>
      )}
      {open && (
        <>
          <h3>Deliveries</h3>
          {log.isError && <p className="error">{log.error.message}</p>}
          <Table
            rows={log.data?.items ?? []}
            empty="Nothing delivered yet."
            columns={[
              { label: TIME_LABEL, render: (d) => <Time iso={d.at} /> },
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
