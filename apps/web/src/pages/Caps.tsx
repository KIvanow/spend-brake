import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { type Cap, api, toMicros, usd } from '../api.js';
import { useRole } from '../role.js';
import { Table } from '../ui.js';
import { useKeys } from './Keys.js';
import { ScopeName } from './Overview.js';

/** Micros as the dollars someone would type (5, 12.5), exactly. */
const dollars = (micros: number | null): string => {
  if (micros === null) return '';
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${Math.floor(micros / 1_000_000)}${fraction ? `.${fraction}` : ''}`;
};

export function Caps() {
  const qc = useQueryClient();
  const caps = useQuery({ queryKey: ['caps'], queryFn: () => api<{ items: Cap[] }>('/v1/caps') });
  const keys = useKeys();
  const { can } = useRole();
  const activeKeys = (keys.data?.items ?? []).filter((k) => k.status === 'active');
  const names = new Map(activeKeys.map((k) => [k.id, k.name]));
  const [scope, setScope] = useState('org');
  const [kind, setKind] = useState<'d' | 'm'>('d');
  const [hard, setHard] = useState('');
  const [soft, setSoft] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  // The form starts from the scope's current cap, so saving a soft limit alone keeps the hard
  // cap (an empty field removes that limit).
  const current = caps.data?.items.find((c) => c.scope === scope.trim() && c.kind === kind);
  const currentKey = current ? `${current.scope}|${current.kind}|${current.version}` : '';
  useEffect(() => {
    setHard(dollars(current?.hard ?? null));
    setSoft(dollars(current?.soft ?? null));
    // Only when the cap being edited (or its saved version) changes, not on every keystroke.
  }, [currentKey]);
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
          { label: 'Scope', render: (c) => <ScopeName scope={c.scope} names={names} /> },
          { label: 'Window', render: (c) => (c.kind === 'd' ? 'per day' : 'per month') },
          { label: 'Hard', render: (c) => usd(c.hard), numeric: true },
          { label: 'Soft', render: (c) => usd(c.soft), numeric: true },
          ...(can('admin')
            ? [
                {
                  label: '',
                  render: (c: Cap) => (
                    <button
                      type="button"
                      onClick={() => remove.mutate(c)}
                      disabled={remove.isPending}
                    >
                      Remove
                    </button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {!can('admin') && <p className="muted">Admins and owners can change caps.</p>}
      {can('admin') && (
        <form className="form" onSubmit={submit} aria-label="Set a cap">
          <h3>Set a cap</h3>
          <label>
            Scope
            <input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="org, key:key_…, sku:google-maps:geocoding"
              list="cap-scopes"
              required
            />
          </label>
          <datalist id="cap-scopes">
            <option value="org">the whole org</option>
            {activeKeys.map((k) => (
              <option key={k.id} value={`key:${k.id}`}>
                key {k.name}
              </option>
            ))}
          </datalist>
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
          <p className="muted full">
            {current
              ? 'Showing the current cap for this scope and window. An empty field removes that limit.'
              : 'An empty field means no limit.'}
          </p>
          {(formError ?? save.error?.message ?? remove.error?.message) && (
            <p className="error">{formError ?? save.error?.message ?? remove.error?.message}</p>
          )}
          {notice && <p className="notice">{notice}</p>}
        </form>
      )}
    </section>
  );
}
