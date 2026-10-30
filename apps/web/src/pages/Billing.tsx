import { useMutation, useQuery } from '@tanstack/react-query';
import { api, usd } from '../api.js';
import { Table } from '../ui.js';

interface BillingView {
  plan: string | null;
  planName: string | null;
  status: 'active' | 'past_due' | null;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
  limits: {
    maxKeys: number | null;
    maxProviders: number | null;
    agentSessionsPerMonth: number | null;
    requestsPerMonth: number | null;
    maxOrgMonthCapMicros: number | null;
    retentionDays: number;
  } | null;
  usage: {
    keys: number;
    providers: number;
    agentSessionsThisMonth: number;
    requestsThisMonth: number;
  };
  plans: { id: string; name: string }[];
  licenses: { id: string; edition: string; expiresAt: string; issuedAt: string }[];
}

const of = (used: number, max: number | null | undefined) =>
  `${used.toLocaleString('en-US')} of ${max === null || max === undefined ? 'unlimited' : max.toLocaleString('en-US')}`;

/** The hosted plan: usage against limits, buying and managing it, license files. */
export function Billing() {
  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<BillingView>('/v1/billing'),
    retry: false,
  });
  const go = useMutation({
    mutationFn: (to: { checkout: string } | 'portal') =>
      to === 'portal'
        ? api<{ url: string }>('/v1/billing/portal', { method: 'POST', body: {} })
        : api<{ url: string }>('/v1/billing/checkout', {
            method: 'POST',
            body: { plan: to.checkout },
          }),
    onSuccess: (r) => window.location.assign(r.url),
  });
  const download = useMutation({
    mutationFn: async () => {
      const license = await api<unknown>('/v1/billing/license');
      const blob = new Blob([`${JSON.stringify(license)}\n`], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'spend-brake.license';
      a.click();
      URL.revokeObjectURL(a.href);
    },
  });

  if (billing.isError) {
    return (
      <section>
        <h2>Billing</h2>
        <p className="muted">
          Plans and billing are part of the hosted service; a self-hosted install has no plan
          limits.
        </p>
      </section>
    );
  }
  const b = billing.data;
  if (!b)
    return (
      <section>
        <h2>Billing</h2>
      </section>
    );
  return (
    <section>
      <h2>Billing</h2>
      <p className="stat">
        {b.planName ?? 'No plan'}{' '}
        <span className="muted">
          {b.currentPeriodEnd ? `renews ${new Date(b.currentPeriodEnd).toLocaleDateString()}` : ''}
        </span>
      </p>
      {b.status === 'past_due' && (
        <p className="error">
          A payment failed. Existing keys and caps keep working; new keys, providers and sessions
          wait until it is paid. Update the card in Manage billing.
        </p>
      )}
      {b.limits && (
        <Table
          rows={[
            { what: 'Keys', value: of(b.usage.keys, b.limits.maxKeys) },
            { what: 'Providers', value: of(b.usage.providers, b.limits.maxProviders) },
            {
              what: 'Agent sessions this month',
              value: of(b.usage.agentSessionsThisMonth, b.limits.agentSessionsPerMonth),
            },
            {
              what: 'Proxied requests this month',
              value: of(b.usage.requestsThisMonth, b.limits.requestsPerMonth),
            },
            ...(b.limits.maxOrgMonthCapMicros !== null
              ? [{ what: 'Protected spend a month', value: usd(b.limits.maxOrgMonthCapMicros) }]
              : []),
            { what: 'Event history', value: `${b.limits.retentionDays} days` },
          ]}
          columns={[
            { label: 'Limit', render: (r) => r.what },
            { label: 'Used', render: (r) => r.value },
          ]}
        />
      )}
      <div className="row">
        {b.hasSubscription ? (
          <button type="button" disabled={go.isPending} onClick={() => go.mutate('portal')}>
            Manage billing
          </button>
        ) : (
          b.plans.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={go.isPending}
              onClick={() => go.mutate({ checkout: p.id })}
            >
              Buy {p.name}
            </button>
          ))
        )}
      </div>
      {go.error && <p className="error">{go.error.message}</p>}
      {b.licenses.length > 0 && (
        <>
          <h3>License</h3>
          <p className="muted">
            Install on your server with <code>brake license install spend-brake.license</code>.
          </p>
          <Table
            rows={b.licenses}
            columns={[
              { label: 'Edition', render: (l) => l.edition },
              { label: 'Valid until', render: (l) => new Date(l.expiresAt).toLocaleDateString() },
            ]}
          />
          <button type="button" onClick={() => download.mutate()} disabled={download.isPending}>
            Download the latest license
          </button>
          {download.error && <p className="error">{download.error.message}</p>}
        </>
      )}
    </section>
  );
}
