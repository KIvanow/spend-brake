import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Key, api } from '../api.js';
import { Table } from '../ui.js';

export function Keys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => api<{ items: Key[] }>('/v1/keys') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['keys'] }),
  });
  return (
    <section>
      <h2>Virtual keys</h2>
      <p className="muted">
        Create keys with the CLI (`brake keys create`): the token is shown once.
      </p>
      <Table
        rows={keys.data?.items ?? []}
        columns={[
          { label: 'Name', render: (k) => k.name },
          { label: 'Id', render: (k) => <code>{k.id}</code> },
          { label: 'Token', render: (k) => <code>{k.prefix}…</code> },
          { label: 'Env', render: (k) => k.config.env ?? '' },
          { label: 'Agent', render: (k) => k.config.agentId ?? '' },
          {
            label: 'Status',
            render: (k) => (
              <span className={k.status === 'active' ? 'badge' : 'badge danger'}>{k.status}</span>
            ),
          },
          {
            label: '',
            render: (k) =>
              k.status === 'active' ? (
                <button
                  type="button"
                  className="danger"
                  onClick={() => revoke.mutate(k.id)}
                  disabled={revoke.isPending}
                >
                  Revoke
                </button>
              ) : null,
          },
        ]}
      />
    </section>
  );
}
