import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useRole } from '../role.js';
import { Time } from '../ui.js';

interface OtlpView {
  endpoint: string;
  headerNames: string[];
  enabled: boolean;
  /** False when the plan no longer includes export: nothing is sent. */
  planAllows?: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  queued: number;
}

const when = (iso: string | null) =>
  iso ? (
    <>
      <Time iso={iso} /> (local)
    </>
  ) : (
    'never'
  );

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <pre>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Prometheus() {
  const { can } = useRole();
  const [token, setToken] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ token: string }>('/v1/tokens', {
        method: 'POST',
        body: { name: 'prometheus', role: 'viewer' },
      }),
    onSuccess: (t) => setToken(t.token),
  });
  const host = window.location.host;
  const config = `scrape_configs:
  - job_name: spend-brake
    scheme: ${window.location.protocol.replace(':', '')}
    metrics_path: /v1/metrics
    authorization:
      credentials: ${token ?? '<read-only token>'}
    static_configs:
      - targets: ['${host}']`;
  return (
    <>
      <h2>Prometheus</h2>
      <p className="muted">
        Calls, cost, latency (yours and the provider's) and what is left of each cap, for this org
        only. Counters by provider, SKU, key, agent, environment and outcome, including the calls
        Spend Brake refused.
      </p>
      <CopyBlock text={config} />
      {token ? (
        <p className="notice">The token is in the config above. It is not shown again.</p>
      ) : !can('owner') ? (
        <p className="muted">An owner of the org can create the read-only token.</p>
      ) : (
        <button type="button" disabled={create.isPending} onClick={() => create.mutate()}>
          Create a read-only token for Prometheus
        </button>
      )}
      {create.isError && <p className="error">{create.error.message}</p>}
    </>
  );
}

const EXAMPLES = [
  { name: 'Honeycomb', endpoint: 'https://api.honeycomb.io', header: 'x-honeycomb-team' },
  {
    name: 'Grafana Cloud',
    endpoint: 'https://otlp-gateway-<zone>.grafana.net/otlp',
    header: 'Authorization (Basic …)',
  },
  {
    name: 'Your own collector',
    endpoint: 'https://otel.example.com:4318',
    header: 'as configured',
  },
];

function OpenTelemetry() {
  const qc = useQueryClient();
  const { can } = useRole();
  const current = useQuery({
    queryKey: ['otlp'],
    queryFn: () => api<{ otlp: OtlpView | null }>('/v1/telemetry/otlp'),
    refetchInterval: 15_000,
  });
  const otlp = current.data?.otlp ?? null;
  const [endpoint, setEndpoint] = useState('');
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([]);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (otlp && !editing) setEndpoint(otlp.endpoint);
  }, [otlp, editing]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['otlp'] });
  const save = useMutation({
    mutationFn: () => {
      const filled = headers.filter((h) => h.name.trim());
      return api<OtlpView>('/v1/telemetry/otlp', {
        method: 'PUT',
        body: {
          endpoint: endpoint.trim(),
          // Leaving the headers untouched keeps the stored ones.
          ...(filled.length || !otlp
            ? { headers: Object.fromEntries(filled.map((h) => [h.name.trim(), h.value])) }
            : {}),
        },
      });
    },
    onSuccess: () => {
      setHeaders([]);
      setEditing(false);
      refresh();
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; status: number | null; error: string | null }>('/v1/telemetry/otlp/test', {
        method: 'POST',
        body: {},
      }),
  });
  const remove = useMutation({
    mutationFn: () => api('/v1/telemetry/otlp', { method: 'DELETE' }),
    onSuccess: () => {
      setEndpoint('');
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <>
      <h2>OpenTelemetry</h2>
      <p className="muted">
        Every call as a span, sent to your collector over OTLP/HTTP, with its cost, SKU, key,
        session, outcome and timings. If your app sends a <code>traceparent</code> header, the span
        appears inside your own trace.
      </p>
      {otlp && (
        <div className="callout">
          <p>
            Sending to <code>{otlp.endpoint}</code>
            {otlp.headerNames.length > 0 && <> with {otlp.headerNames.join(', ')}</>}.
          </p>
          {otlp.planAllows === false && (
            <p className="error">
              Paused: your plan no longer includes OpenTelemetry export, so nothing is sent. Upgrade
              on the Billing page to resume.
            </p>
          )}
          <p className="muted">
            Last delivered: {when(otlp.lastSuccessAt)}. Waiting: {otlp.queued}.
          </p>
          {otlp.lastError && (
            <p className="error">
              Last error ({when(otlp.lastErrorAt)}): {otlp.lastError}
            </p>
          )}
          <div className="row" hidden={!can('admin')}>
            <button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
              Send test span
            </button>
            <button
              type="button"
              className="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Stop sending
            </button>
          </div>
          {test.data && (
            <p className={test.data.ok ? 'ok' : 'error'}>
              {test.data.ok
                ? 'Delivered: look for a span named "spend-brake test".'
                : `Not delivered: ${test.data.error ?? `HTTP ${test.data.status}`}`}
            </p>
          )}
          {test.isError && <p className="error">{test.error.message}</p>}
        </div>
      )}
      {!can('admin') && <p className="muted">Admins and owners can change where spans go.</p>}
      <form className="form" onSubmit={submit} hidden={!can('admin')}>
        <h3>{otlp ? 'Change the destination' : 'Send spans to'}</h3>
        <label className="grow">
          OTLP/HTTP endpoint
          <input
            type="url"
            value={endpoint}
            onChange={(e) => {
              setEditing(true);
              setEndpoint(e.target.value);
            }}
            placeholder="https://api.honeycomb.io"
            required
          />
        </label>
        {headers.map((h, i) => (
          <div key={i} className="row full">
            <label>
              Header
              <input
                value={h.name}
                onChange={(e) =>
                  setHeaders((all) =>
                    all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  )
                }
                placeholder="x-honeycomb-team"
              />
            </label>
            <label className="grow">
              Value
              <input
                type="password"
                value={h.value}
                autoComplete="off"
                onChange={(e) =>
                  setHeaders((all) =>
                    all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                  )
                }
              />
            </label>
            <button
              type="button"
              onClick={() => setHeaders((all) => all.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setHeaders((all) => [...all, { name: '', value: '' }])}
        >
          Add header
        </button>
        <button type="submit" className="primary" disabled={save.isPending}>
          Save
        </button>
        <p className="muted full">
          Header values are stored encrypted and never shown again
          {otlp?.headerNames.length ? '; add headers only to replace the stored ones' : ''}.
        </p>
      </form>
      {save.isError && <p className="error">{save.error.message}</p>}
      <h3>Examples</h3>
      <ul className="muted">
        {EXAMPLES.map((x) => (
          <li key={x.name}>
            {x.name}: <code>{x.endpoint}</code>, header {x.header}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The org's calls as Prometheus metrics and OpenTelemetry spans, for its own dashboards. */
export function Telemetry() {
  return (
    <section>
      <Prometheus />
      <OpenTelemetry />
    </section>
  );
}
