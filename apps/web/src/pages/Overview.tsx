import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ScopeStatus, api, usd } from '../api.js';
import { useRole } from '../role.js';
import { Meter, Table, windowName } from '../ui.js';
import { useCredentials, useKeys } from './Keys.js';

interface Status {
  killed: string[];
  /**
   * Keys refused for every provider (429 loop_detected) until their circuit closes, opened by the
   * loop breaker or the SMS pumping guard.
   */
  paused?: { keyId: string; retryAfterSec: number; reason?: 'loop' | 'pumping' }[];
  scopes: ScopeStatus[];
}

/** A scope or kill target as people know it: keys by name (the label stays in the tooltip). */
export function ScopeName({ scope, names }: { scope: string; names: Map<string, string> }) {
  const name = scope.startsWith('key:') ? names.get(scope.slice(4)) : undefined;
  return name ? (
    <span title={scope}>
      key <strong>{name}</strong>
    </span>
  ) : (
    <code>{scope}</code>
  );
}

const minutes = (sec: number) => (sec < 60 ? `${sec} s` : `${Math.ceil(sec / 60)} min`);

/** Live remaining budget per scope (from Valkey) with the kill switch. */
export function Overview() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api<Status>('/v1/status'),
    refetchInterval: 5_000,
  });
  const credentials = useCredentials();
  const keys = useKeys();
  const { can } = useRole();
  const names = new Map((keys.data?.items ?? []).map((k) => [k.id, k.name]));
  const resume = useMutation({
    mutationFn: (keyId: string) =>
      api(`/v1/keys/${encodeURIComponent(keyId)}/resume`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['status'] }),
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
  const paused = status.data.paused ?? [];
  const targets = [
    'org',
    ...new Set(status.data.scopes.map((s) => s.scope).filter((s) => s.startsWith('key:'))),
  ];

  return (
    <section>
      {credentials.data?.items.length === 0 && (
        <div className="callout">
          <strong>Welcome!</strong> Connect your first API in a few minutes.{' '}
          <a href="#/setup">Get started</a>
        </div>
      )}
      {(['loop', 'pumping'] as const).map((reason) => {
        const keys = paused.filter((p) => (p.reason ?? 'loop') === reason);
        if (keys.length === 0) return null;
        return (
          <div className="callout" key={reason}>
            {reason === 'loop' ? (
              <>
                <strong>Paused by the loop breaker.</strong> These keys sent the same request too
                many times in a row, so Spend Brake refuses their calls (HTTP 429 loop_detected) for
                a while, for all providers on the key. Stop the app repeating the request first:
                resuming clears the count, but the same repeats trip it again.
              </>
            ) : (
              <>
                <strong>Paused for possible SMS pumping.</strong> These keys sent too many messages
                to one number or number range, which is how SMS pumping fraud looks. Spend Brake
                refuses their calls (HTTP 429 loop_detected) for a while, for all providers on the
                key. Resuming keeps the per-number counts for the hour: messages to other numbers go
                through, and the flagged numbers pause the key again.
              </>
            )}
            <ul>
              {keys.map((p) => (
                <li key={p.keyId}>
                  <ScopeName scope={`key:${p.keyId}`} names={names} />: resumes by itself in{' '}
                  {minutes(p.retryAfterSec)}.{' '}
                  {can('admin') && (
                    <button
                      type="button"
                      disabled={resume.isPending}
                      onClick={() => resume.mutate(p.keyId)}
                    >
                      Resume now
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {resume.isError && <p className="error">{resume.error.message}</p>}
          </div>
        );
      })}
      <h2>Live budget</h2>
      <p className="muted">Refreshes every 5 seconds. Held = reserved by requests in flight.</p>
      <Table
        rows={status.data.scopes}
        columns={[
          { label: 'Scope', render: (s) => <ScopeName scope={s.scope} names={names} /> },
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
        {!can('admin') && ' Admins and owners can kill and lift kills.'}
      </p>
      <ul className="kills">
        {targets.map((t) => {
          const isKilled = killed.has(t);
          const pause = paused.find((p) => `key:${p.keyId}` === t);
          const isPaused = pause !== undefined;
          return (
            <li key={t}>
              <ScopeName scope={t} names={names} />
              <span className={isKilled || isPaused ? 'badge danger' : 'badge'}>
                {isKilled
                  ? 'killed'
                  : pause
                    ? `paused (${pause.reason === 'pumping' ? 'SMS pumping' : 'loop'})`
                    : 'live'}
              </span>
              {can('admin') && (
                <button
                  type="button"
                  className={isKilled ? '' : 'danger'}
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ target: t, kill: !isKilled })}
                >
                  {isKilled ? 'Lift kill' : 'Kill'}
                </button>
              )}
            </li>
          );
        })}
        {status.data.killed
          .filter((t) => !targets.includes(t))
          .map((t) => (
            <li key={t}>
              <ScopeName scope={t} names={names} />
              <span className="badge danger">killed</span>
              {can('admin') && (
                <button type="button" onClick={() => toggle.mutate({ target: t, kill: false })}>
                  Lift kill
                </button>
              )}
            </li>
          ))}
      </ul>
      {toggle.isError && <p className="error">{toggle.error.message}</p>}
    </section>
  );
}
