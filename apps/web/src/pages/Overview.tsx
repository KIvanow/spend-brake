import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ScopeStatus, api, usd } from '../api.js';
import { Meter, Table, windowName } from '../ui.js';

interface Status {
  killed: string[];
  scopes: ScopeStatus[];
}

/** Live remaining budget per scope (from Valkey) with the kill switch. */
export function Overview() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api<Status>('/v1/status'),
    refetchInterval: 5_000,
  });
  const toggle = useMutation({
    mutationFn: ({ target, kill }: { target: string; kill: boolean }) =>
      api(`/v1/${kill ? 'kill' : 'unkill'}`, {
        method: 'POST',
        body: { target, reason: 'dashboard' },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  if (status.isPending) return <p className="muted">Loading…</p>;
  if (status.isError) return <p className="error">{status.error.message}</p>;
  const killed = new Set(status.data.killed);
  const targets = [
    'org',
    ...new Set(status.data.scopes.map((s) => s.scope).filter((s) => s.startsWith('key:'))),
  ];

  return (
    <section>
      <h2>Live budget</h2>
      <p className="muted">Refreshes every 5 seconds. Held = reserved by requests in flight.</p>
      <Table
        rows={status.data.scopes}
        columns={[
          { label: 'Scope', render: (s) => <code>{s.scope}</code> },
          { label: 'Window', render: (s) => windowName(s.window) },
          { label: 'Spent', render: (s) => usd(s.spent, 4), numeric: true },
          { label: 'Held', render: (s) => usd(s.held, 4), numeric: true },
          { label: 'Hard cap', render: (s) => usd(s.hard), numeric: true },
          { label: 'Remaining', render: (s) => usd(s.remaining, 4), numeric: true },
          { label: 'Used', render: (s) => <Meter spent={s.spent + s.held} hard={s.hard} /> },
        ]}
      />
      <h2>Kill switch</h2>
      <p className="muted">
        Stops spending immediately on the next request. Every change is audited.
      </p>
      <ul className="kills">
        {targets.map((t) => {
          const isKilled = killed.has(t);
          return (
            <li key={t}>
              <code>{t}</code>
              <span className={isKilled ? 'badge danger' : 'badge'}>
                {isKilled ? 'killed' : 'live'}
              </span>
              <button
                type="button"
                className={isKilled ? '' : 'danger'}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ target: t, kill: !isKilled })}
              >
                {isKilled ? 'Lift kill' : 'Kill'}
              </button>
            </li>
          );
        })}
        {status.data.killed
          .filter((t) => !targets.includes(t))
          .map((t) => (
            <li key={t}>
              <code>{t}</code>
              <span className="badge danger">killed</span>
              <button type="button" onClick={() => toggle.mutate({ target: t, kill: false })}>
                Lift kill
              </button>
            </li>
          ))}
      </ul>
      {toggle.isError && <p className="error">{toggle.error.message}</p>}
    </section>
  );
}
