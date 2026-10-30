import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, usd } from '../api.js';
import { TIME_LABEL, Table, Time } from '../ui.js';

interface Approval {
  id: string;
  subject: 'cap' | 'policy';
  scope: string;
  kind: 'd' | 'm';
  fromHard: number | null;
  toHard: number | null;
  remove: boolean;
  status: string;
  requestedBy: string;
  requestedAt: string;
}

const change = (a: Approval) =>
  a.subject === 'policy'
    ? 'Switch two-person approval off'
    : `${a.scope} ${a.kind === 'd' ? 'per day' : 'per month'}: ${usd(a.fromHard)} → ${
        a.remove ? 'no cap' : usd(a.toHard)
      }`;

/** Cap raises waiting for a second person (Business and Enterprise). */
export function Approvals() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api<{ items: Approval[] }>('/v1/approvals?status=pending'),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) =>
      api(`/v1/approvals/${encodeURIComponent(v.id)}/${v.decision}`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['caps'] });
    },
  });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return (
      <section>
        <h2>Approvals</h2>
        <p className="muted">
          Two-person approval of cap raises comes with a Business or Enterprise license on a
          self-hosted install.
        </p>
      </section>
    );
  }
  if (list.error instanceof ApiError && list.error.status === 403) {
    return (
      <section>
        <h2>Approvals</h2>
        <p className="muted">{list.error.message}</p>
      </section>
    );
  }
  return (
    <section>
      <h2>Approvals</h2>
      <p className="muted">
        With two-person approval on, raising or removing a hard cap waits here until someone other
        than the requester approves it (within 24 hours).
      </p>
      <Table
        rows={list.data?.items ?? []}
        empty="Nothing is waiting."
        columns={[
          { label: 'Change', render: (a) => change(a) },
          { label: 'Asked by', render: (a) => <code>{a.requestedBy}</code> },
          { label: TIME_LABEL, render: (a) => <Time iso={a.requestedAt} /> },
          {
            label: '',
            render: (a) => (
              <>
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: a.id, decision: 'approve' })}
                >
                  Approve
                </button>{' '}
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: a.id, decision: 'reject' })}
                >
                  Reject
                </button>
              </>
            ),
          },
        ]}
      />
      {decide.error && <p className="error">{decide.error.message}</p>}
    </section>
  );
}
