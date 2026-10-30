import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { type Cap, api, toMicros, usd } from '../api.js';
import { Table } from '../ui.js';

export function Caps() {
  const qc = useQueryClient();
  const caps = useQuery({ queryKey: ['caps'], queryFn: () => api<{ items: Cap[] }>('/v1/caps') });
  const [scope, setScope] = useState('org');
  const [kind, setKind] = useState<'d' | 'm'>('d');
  const [hard, setHard] = useState('');
  const [soft, setSoft] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const held = (r: { pending?: unknown[] }) =>
    setNotice(
      r.pending?.length
        ? 'Waiting for a second person to approve this on the Approvals page; the cap is unchanged until then.'
        : null,
    );

  const save = useMutation({
    mutationFn: (v: { scope: string; kind: 'd' | 'm'; hard: number | null; soft: number | null }) =>
      api<{ pending?: unknown[] }>(`/v1/caps/${encodeURIComponent(v.scope)}`, {
        method: 'PUT',
        body: { [v.kind === 'd' ? 'day' : 'month']: { hard: v.hard, soft: v.soft } },
      }),
    onSuccess: (r) => {
      held(r);
      void qc.invalidateQueries({ queryKey: ['caps'] });
      void qc.invalidateQueries({ queryKey: ['status'] });
      setHard('');
      setSoft('');
    },
  });
  const remove = useMutation({
    mutationFn: (c: Cap) =>
      api<{ pending?: unknown[] }>(`/v1/caps/${encodeURIComponent(c.scope)}?kind=${c.kind}`, {
        method: 'DELETE',
      }),
    onSuccess: (r) => {
      held(r);
      void qc.invalidateQueries({ queryKey: ['caps'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const h = hard.trim() === '' ? null : toMicros(hard);
    const s = soft.trim() === '' ? null : toMicros(soft);
    if ((hard.trim() && h === null) || (soft.trim() && s === null)) {
      setFormError('Amounts are dollars, like 5 or 12.50.');
      return;
    }
    setFormError(null);
    save.mutate({ scope: scope.trim(), kind, hard: h, soft: s });
  };

  return (
    <section>
      <h2>Caps</h2>
      <p className="muted">
        Hard caps block requests before they reach the provider; soft limits only alert. Changes
        apply on the next request.
      </p>
      <Table
        rows={caps.data?.items ?? []}
        empty="No caps yet."
        columns={[
          { label: 'Scope', render: (c) => <code>{c.scope}</code> },
          { label: 'Window', render: (c) => (c.kind === 'd' ? 'per day' : 'per month') },
          { label: 'Hard', render: (c) => usd(c.hard), numeric: true },
          { label: 'Soft', render: (c) => usd(c.soft), numeric: true },
          {
            label: '',
            render: (c) => (
              <button type="button" onClick={() => remove.mutate(c)} disabled={remove.isPending}>
                Remove
              </button>
            ),
          },
        ]}
      />
      <form className="form" onSubmit={submit} aria-label="Set a cap">
        <h3>Set a cap</h3>
        <label>
          Scope
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="org, key:key_…, sku:google-maps:geocoding"
            required
          />
        </label>
        <label>
          Window
          <select value={kind} onChange={(e) => setKind(e.target.value as 'd' | 'm')}>
            <option value="d">per day</option>
            <option value="m">per month</option>
          </select>
        </label>
        <label>
          Hard cap ($)
          <input
            value={hard}
            onChange={(e) => setHard(e.target.value)}
            inputMode="decimal"
            placeholder="none"
          />
        </label>
        <label>
          Soft limit ($)
          <input
            value={soft}
            onChange={(e) => setSoft(e.target.value)}
            inputMode="decimal"
            placeholder="none"
          />
        </label>
        <button type="submit" disabled={save.isPending}>
          Save
        </button>
        {(formError ?? save.error?.message ?? remove.error?.message) && (
          <p className="error">{formError ?? save.error?.message ?? remove.error?.message}</p>
        )}
        {notice && <p className="notice">{notice}</p>}
      </form>
    </section>
  );
}
