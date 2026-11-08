import { LICENSE_ORG } from '@spend-brake/shared/license-org';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { track } from '../analytics.js';
import { type Cap, api, download as downloadFile, usd } from '../api.js';
import { useRole } from '../role.js';
import { Table, TermsConsent, Time } from '../ui.js';

interface BillingView {
  plan: string | null;
  planName: string | null;
  status: 'active' | 'past_due' | null;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
  /** Business / Enterprise: the org id of the install licenses name. */
  licenseOrg?: string | null;
  limits: {
    maxKeys: number | null;
    maxProviders: number | null;
    /** Absent from billing services older than custom APIs. */
    maxCustomApis?: number | null;
    agentSessionsPerMonth: number | null;
    requestsPerMonth: number | null;
    maxOrgMonthCapMicros: number | null;
    retentionDays: number;
  } | null;
  usage: {
    keys: number;
    providers: number;
    customApis?: number;
    agentSessionsThisMonth: number;
    requestsThisMonth: number;
  };
  /** The org month cap is still the one sign-up set, unchanged since. */
  signupCap?: boolean;
  /** selfHosted: a license, which needs the install's org id (absent from older services). */
  plans: { id: string; name: string; selfHosted?: boolean }[];
  licenses: {
    id: string;
    edition: string;
    /** The org the license names (absent from older billing services). */
    org?: string | null;
    expiresAt: string;
    issuedAt: string;
  }[];
}

const of = (used: number, max: number | null | undefined) =>
  `${used.toLocaleString('en-US')} of ${max === null || max === undefined ? 'unlimited' : max.toLocaleString('en-US')}`;

/** The hosted plan: usage against limits, buying and managing it, license files. */
export function Billing() {
  const { can } = useRole();
  const queryClient = useQueryClient();
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [installOrg, setInstallOrg] = useState<string | null>(null);
  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<BillingView>('/v1/billing'),
    retry: false,
  });
  // Free sign-ups start with an org hard cap a month, and it stays after an upgrade: say so here,
  // so paying for a plan is not mistaken for lifting it.
  const caps = useQuery({
    queryKey: ['caps'],
    queryFn: () => api<{ items: Cap[] }>('/v1/caps'),
    enabled: billing.isSuccess,
  });
  const orgCap = caps.data?.items.find(
    (c) => c.scope === 'org' && c.kind === 'm' && c.hard !== null,
  );
  const go = useMutation({
    mutationFn: (to: { checkout: string; licenseOrg?: string } | 'portal') =>
      to === 'portal'
        ? api<{ url: string }>('/v1/billing/portal', { method: 'POST', body: {} })
        : api<{ url: string }>('/v1/billing/checkout', {
            method: 'POST',
            body: {
              plan: to.checkout,
              ...(to.licenseOrg ? { licenseOrg: to.licenseOrg } : {}),
              acceptTerms,
            },
          }),
    onSuccess: (r, to) => {
      if (to !== 'portal') track('checkout_started', { plan: to.checkout });
      window.location.assign(r.url);
    },
  });
  const saveInstallOrg = useMutation({
    mutationFn: (licenseOrg: string) =>
      api('/v1/billing/license-org', { method: 'PUT', body: { licenseOrg } }),
    // The field goes back to the saved value once it has been fetched, not before (it would
    // show the old one in between).
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['billing'] });
      setInstallOrg(null);
    },
  });
  // Saved under the name the API gives the file (the org the license names).
  const download = useMutation({
    mutationFn: (fallbackName: string) => downloadFile('/v1/billing/license', fallbackName),
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
  const latest = b.licenses[0];
  const licenseFile = `${latest?.org ?? b.licenseOrg ?? 'spend-brake'}.license`;
  // The install's org id: as typed, else as stored. A license plan is bought for it.
  const installValue = (installOrg ?? b.licenseOrg ?? '').trim();
  const installValid = LICENSE_ORG.test(installValue);
  // Also for a license plan with no id stored yet (bought before the id was asked for): its
  // owner sets the id here, and the license waiting for it is issued.
  const licenseSection =
    b.licenses.length > 0 ||
    Boolean(b.licenseOrg) ||
    b.plan === 'business' ||
    b.plan === 'enterprise';
  const buying = can('owner') && !b.hasSubscription;
  const installField = (hint: string) => (
    <label>
      Org id on your install
      <input
        value={installOrg ?? b.licenseOrg ?? ''}
        onChange={(e) => setInstallOrg(e.target.value)}
        placeholder="acme"
        // Checked as trimmed (installValid), which is what is sent: a pattern would refuse
        // "acme " while Save stays enabled.
        aria-invalid={installOrg !== null && !installValid}
        title="Up to 64 letters, digits, - or _"
        autoComplete="off"
        required
      />
      <span className="muted">{hint}</span>
    </label>
  );
  return (
    <section>
      <h2>Billing</h2>
      <p className="stat plan">
        {b.planName ?? 'No plan'}{' '}
        <span className="muted">
          {b.currentPeriodEnd ? (
            <>
              renews <Time iso={b.currentPeriodEnd} date />
            </>
          ) : (
            ''
          )}
        </span>
      </p>
      {b.status === 'past_due' && (
        <p className="error">
          A payment failed. Existing keys and caps keep working; new keys, providers and sessions
          wait until it is paid. Update the card in Manage billing.
        </p>
      )}
      {orgCap && (
        <p className="callout" role="note">
          Your org has a {usd(orgCap.hard, orgCap.hard! % 1_000_000 === 0 ? 0 : 2)}/month hard cap
          {b.signupCap ? ' (set at sign-up)' : ''}. Calls stop when it&apos;s reached. Change it on{' '}
          <a href="#/caps">Caps</a>.
        </p>
      )}
      {b.limits && (
        <Table
          rows={[
            { what: 'Keys', value: of(b.usage.keys, b.limits.maxKeys) },
            { what: 'Providers', value: of(b.usage.providers, b.limits.maxProviders) },
            ...(b.limits.maxCustomApis !== undefined
              ? [
                  {
                    what: 'Custom APIs',
                    value: of(b.usage.customApis ?? 0, b.limits.maxCustomApis),
                  },
                ]
              : []),
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
      {!can('owner') && <p className="muted">Owners manage billing.</p>}
      {buying && !licenseSection && b.plans.some((p) => p.selfHosted) && (
        // Nowhere else to give it yet: the License section shows once there is one.
        <div className="row">
          {installField(
            'For a self-hosted license: the --org you gave brake init. The license installs only into the org with this id.',
          )}
        </div>
      )}
      {buying && b.plans.length > 0 && (
        <TermsConsent checked={acceptTerms} onChange={setAcceptTerms} />
      )}
      <div className="row actions">
        {!can('owner') ? null : b.hasSubscription ? (
          <button type="button" disabled={go.isPending} onClick={() => go.mutate('portal')}>
            Manage billing
          </button>
        ) : (
          b.plans.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={go.isPending || !acceptTerms || (p.selfHosted === true && !installValid)}
              onClick={() =>
                go.mutate(
                  p.selfHosted ? { checkout: p.id, licenseOrg: installValue } : { checkout: p.id },
                )
              }
            >
              Buy {p.name}
            </button>
          ))
        )}
      </div>
      {go.error && <p className="error">{go.error.message}</p>}
      {licenseSection && (
        <>
          <h3>License</h3>
          {/* Licenses already issued keep the id they were issued for; only the next changes. */}
          {latest?.org ? (
            <p>
              Your current license names the org <code>{latest.org}</code> on your install.
              {b.licenseOrg && b.licenseOrg !== latest.org && (
                <>
                  {' '}
                  The next license issued will name <code>{b.licenseOrg}</code>.
                </>
              )}
            </p>
          ) : (
            b.licenseOrg && (
              <p>
                Licenses will name the org <code>{b.licenseOrg}</code> on your install.
              </p>
            )
          )}
          {can('owner') && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (installOrg !== null && installValid) saveInstallOrg.mutate(installValue);
              }}
            >
              {installField('The --org you gave brake init. Renewals are issued for this id.')}
              <button
                type="submit"
                disabled={saveInstallOrg.isPending || installOrg === null || !installValid}
              >
                Save
              </button>
            </form>
          )}
          {saveInstallOrg.error && <p className="error">{saveInstallOrg.error.message}</p>}
        </>
      )}
      {b.licenses.length > 0 && (
        <>
          <p className="muted">
            Install on your server with an owner token of that org:{' '}
            <code>brake license install {licenseFile}</code>.
          </p>
          <Table
            rows={b.licenses}
            columns={[
              { label: 'Edition', render: (l) => l.edition },
              { label: 'Valid until', render: (l) => <Time iso={l.expiresAt} date /> },
            ]}
          />
          {can('owner') && (
            <button
              type="button"
              onClick={() => download.mutate(licenseFile)}
              disabled={download.isPending}
            >
              Download the latest license
            </button>
          )}
          {download.error && <p className="error">{download.error.message}</p>}
        </>
      )}
    </section>
  );
}
