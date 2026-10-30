import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api.js';
import { Table } from '../ui.js';

type Role = 'owner' | 'admin' | 'viewer';

interface Person {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

const ROLES: { id: Role; about: string }[] = [
  { id: 'viewer', about: 'sees spend, caps and events' },
  { id: 'admin', about: 'also manages keys, caps and webhooks' },
  { id: 'owner', about: 'also manages the team, tokens and billing' },
];

/** The people in the org: invite by email, change roles, remove. */
export function Team() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [note, setNote] = useState<string | null>(null);
  const people = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: Person[] }>('/v1/users'),
    retry: false,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const invite = useMutation({
    mutationFn: () =>
      api<Person & { invited: boolean }>('/v1/users', {
        method: 'POST',
        body: { email: email.trim(), role },
      }),
    onSuccess: (p) => {
      setNote(
        p.invited
          ? `Invited ${p.email}: they get a sign-in link by email.`
          : `Added ${p.email}. Email sign-in is off here, so they sign in with single sign-on or a token.`,
      );
      setEmail('');
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api(`/v1/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { role } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (people.isError) {
    return (
      <section>
        <h2>Team</h2>
        <p className="muted">
          {people.error instanceof ApiError && people.error.status === 403
            ? 'Admins and owners see the team.'
            : people.error.message}
        </p>
      </section>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNote(null);
    invite.mutate();
  };
  const failed = invite.error ?? change.error ?? remove.error;

  return (
    <section>
      <h2>Team</h2>
      <p className="muted">Changing someone's role or removing them signs them out everywhere.</p>
      <Table
        rows={people.data?.items ?? []}
        empty="Nobody yet: people signed in with an API token are not listed."
        columns={[
          { label: 'Email', render: (p) => p.email },
          {
            label: 'Role',
            render: (p) => (
              <select
                aria-label={`Role of ${p.email}`}
                value={p.role}
                disabled={change.isPending}
                onChange={(e) => change.mutate({ id: p.id, role: e.target.value as Role })}
              >
                {ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
            ),
          },
          { label: 'Added', render: (p) => p.createdAt.slice(0, 10) },
          {
            label: '',
            render: (p) => (
              <button
                type="button"
                className="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(p.id)}
              >
                Remove
              </button>
            ),
          },
        ]}
      />
      <form className="form" onSubmit={submit}>
        <h3>Invite someone</h3>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}: {r.about}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary" disabled={invite.isPending}>
          Invite
        </button>
      </form>
      {note && <p>{note}</p>}
      {failed && <p className="error">{failed.message}</p>}
    </section>
  );
}
