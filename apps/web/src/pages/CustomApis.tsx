import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { track } from '../analytics.js';
import { api } from '../api.js';
import { type CustomApi, type CustomApiRoute, useCustomApis } from '../providers.js';
import { useRole } from '../role.js';
import { CopyButton, Table } from '../ui.js';
import { useAuthOptions } from './Keys.js';

export const CUSTOM_APIS_DOCS = 'https://docs.spendbrake.dev/custom-apis/';

const METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface RouteDraft {
  method: string;
  path: string;
  sku: string;
  model: 'perRequest' | 'reported';
  usd: string;
  source: 'header' | 'json';
  field: string;
  usdPerUnit: string;
  maxPerRequest: string;
}

interface Draft {
  id: string;
  name: string;
  origin: string;
  authType: 'header' | 'query';
  authName: string;
  valuePrefix: string;
  billed: '2xx' | 'all';
  timeoutBilled: boolean;
  routes: RouteDraft[];
}

const emptyRoute = (): RouteDraft => ({
  method: '*',
  path: '/**',
  sku: '',
  model: 'perRequest',
  usd: '',
  source: 'header',
  field: '',
  usdPerUnit: '1',
  maxPerRequest: '',
});

const emptyDraft = (): Draft => ({
  id: '',
  name: '',
  origin: 'https://',
  authType: 'header',
  authName: 'Authorization',
  valuePrefix: 'Bearer ',
  billed: '2xx',
  timeoutBilled: true,
  routes: [emptyRoute()],
});

function draftOf(a: CustomApi): Draft {
  return {
    id: a.id,
    name: a.name,
    origin: a.origin,
    authType: a.auth.type,
    authName: a.auth.name,
    valuePrefix: a.auth.type === 'header' ? a.auth.valuePrefix : '',
    billed: a.billed,
    timeoutBilled: a.timeoutBilled,
    routes: a.routes.map((r) => {
      const p = r.pricing;
      return {
        ...emptyRoute(),
        method: r.method,
        path: r.path,
        sku: r.sku,
        model: p.model,
        ...(p.model === 'perRequest'
          ? { usd: p.usd }
          : {
              source: p.header !== undefined ? ('header' as const) : ('json' as const),
              field: p.header ?? p.jsonPath ?? '',
              usdPerUnit: p.usdPerUnit,
              maxPerRequest: p.maxPerRequest,
            }),
      };
    }),
  };
}

function bodyOf(d: Draft) {
  const routes: CustomApiRoute[] = d.routes.map((r) => ({
    method: r.method,
    path: r.path.trim(),
    sku: r.sku.trim(),
    pricing:
      r.model === 'perRequest'
        ? { model: 'perRequest', usd: r.usd.trim() }
        : {
            model: 'reported',
            ...(r.source === 'header' ? { header: r.field.trim() } : { jsonPath: r.field.trim() }),
            usdPerUnit: r.usdPerUnit.trim(),
            maxPerRequest: r.maxPerRequest.trim(),
          },
  }));
  return {
    name: d.name.trim(),
    origin: d.origin.trim(),
    auth:
      d.authType === 'header'
        ? { type: 'header', name: d.authName.trim(), valuePrefix: d.valuePrefix }
        : { type: 'query', name: d.authName.trim() },
    routes,
    billed: d.billed,
    timeoutBilled: d.timeoutBilled,
  };
}

/** Add or edit a custom API (admins and owners). */
function CustomApiForm({ editing, onDone }: { editing: CustomApi | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => (editing ? draftOf(editing) : emptyDraft()));
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const setRoute = (i: number, patch: Partial<RouteDraft>) =>
    setD((prev) => ({
      ...prev,
      routes: prev.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  const save = useMutation({
    mutationFn: () =>
      editing
        ? api<CustomApi>(`/v1/custom-apis/${encodeURIComponent(editing.id)}`, {
            method: 'PUT',
            body: bodyOf(d),
          })
        : api<CustomApi>('/v1/custom-apis', {
            method: 'POST',
            body: { id: d.id.trim(), ...bodyOf(d) },
          }),
    onSuccess: () => {
      if (!editing) track('custom_api_created', {});
      void qc.invalidateQueries({ queryKey: ['custom-apis'] });
      if (!editing) setD(emptyDraft());
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const title = editing ? `Edit ${editing.name}` : 'Add a custom API';
  return (
    <>
      <form className="form" onSubmit={submit} aria-label={title}>
        <h3>{title}</h3>
        {!editing && (
          <label>
            Id
            <input
              value={d.id}
              onChange={(e) => set({ id: e.target.value })}
              placeholder="acme"
              pattern="[A-Za-z0-9_.\-]{1,128}"
              title="Letters, digits, _ . and -"
              required
            />
          </label>
        )}
        <label>
          Name
          <input
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Acme Search"
            maxLength={200}
            required
          />
        </label>
        <label className="grow">
          Origin
          <input
            type="url"
            value={d.origin}
            onChange={(e) => set({ origin: e.target.value })}
            placeholder="https://api.acme.example"
            required
          />
        </label>
        <label>
          Key goes in
          <select
            value={d.authType}
            onChange={(e) => set({ authType: e.target.value as Draft['authType'] })}
          >
            <option value="header">a header</option>
            <option value="query">a query parameter</option>
          </select>
        </label>
        <label>
          {d.authType === 'header' ? 'Header name' : 'Parameter name'}
          <input value={d.authName} onChange={(e) => set({ authName: e.target.value })} required />
        </label>
        {d.authType === 'header' && (
          <label>
            Value prefix
            <input
              value={d.valuePrefix}
              onChange={(e) => set({ valuePrefix: e.target.value })}
              placeholder="Bearer "
            />
          </label>
        )}
        <label>
          Billed responses
          <select
            value={d.billed}
            onChange={(e) => set({ billed: e.target.value as Draft['billed'] })}
          >
            <option value="2xx">2xx only</option>
            <option value="all">all</option>
          </select>
        </label>
        <fieldset className="checks">
          <legend>Timeouts</legend>
          <label>
            <input
              type="checkbox"
              checked={d.timeoutBilled}
              onChange={(e) => set({ timeoutBilled: e.target.checked })}
            />
            Charge a timed-out call
          </label>
        </fieldset>
        {d.routes.map((r, i) => {
          const n = i + 1;
          return (
            <fieldset key={i} className="route-row full" aria-label={`Route ${n}`}>
              <legend>Route {n}</legend>
              <label>
                Method
                <select
                  aria-label={`Route ${n} method`}
                  value={r.method}
                  onChange={(e) => setRoute(i, { method: e.target.value })}
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m === '*' ? 'any' : m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grow">
                Path
                <input
                  aria-label={`Route ${n} path`}
                  value={r.path}
                  onChange={(e) => setRoute(i, { path: e.target.value })}
                  placeholder="/v1/search"
                  required
                />
              </label>
              <label>
                SKU
                <input
                  aria-label={`Route ${n} SKU`}
                  value={r.sku}
                  onChange={(e) => setRoute(i, { sku: e.target.value })}
                  placeholder="search"
                  required
                />
              </label>
              <label>
                Pricing
                <select
                  aria-label={`Route ${n} pricing`}
                  value={r.model}
                  onChange={(e) => setRoute(i, { model: e.target.value as RouteDraft['model'] })}
                >
                  <option value="perRequest">flat price per request</option>
                  <option value="reported">cost the API reports</option>
                </select>
              </label>
              {r.model === 'perRequest' ? (
                <label>
                  USD per request
                  <input
                    aria-label={`Route ${n} USD per request`}
                    value={r.usd}
                    onChange={(e) => setRoute(i, { usd: e.target.value })}
                    placeholder="0.005"
                    inputMode="decimal"
                    required
                  />
                </label>
              ) : (
                <>
                  <label>
                    Reported in
                    <select
                      aria-label={`Route ${n} reported in`}
                      value={r.source}
                      onChange={(e) =>
                        setRoute(i, { source: e.target.value as RouteDraft['source'] })
                      }
                    >
                      <option value="header">a response header</option>
                      <option value="json">a JSON field</option>
                    </select>
                  </label>
                  <label>
                    {r.source === 'header' ? 'Header name' : 'JSON path'}
                    <input
                      aria-label={`Route ${n} ${r.source === 'header' ? 'header name' : 'JSON path'}`}
                      value={r.field}
                      onChange={(e) => setRoute(i, { field: e.target.value })}
                      placeholder={r.source === 'header' ? 'X-Credits-Used' : 'usage.cost'}
                      required
                    />
                  </label>
                  <label>
                    USD per unit
                    <input
                      aria-label={`Route ${n} USD per unit`}
                      value={r.usdPerUnit}
                      onChange={(e) => setRoute(i, { usdPerUnit: e.target.value })}
                      placeholder="0.001"
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <label>
                    Max USD per request
                    <input
                      aria-label={`Route ${n} max USD per request`}
                      value={r.maxPerRequest}
                      onChange={(e) => setRoute(i, { maxPerRequest: e.target.value })}
                      placeholder="0.50"
                      inputMode="decimal"
                      required
                    />
                  </label>
                </>
              )}
              {d.routes.length > 1 && (
                <button
                  type="button"
                  className="danger"
                  aria-label={`Remove route ${n}`}
                  onClick={() =>
                    setD((prev) => ({ ...prev, routes: prev.routes.filter((_, j) => j !== i) }))
                  }
                >
                  Remove
                </button>
              )}
            </fieldset>
          );
        })}
        <button
          type="button"
          onClick={() => setD((prev) => ({ ...prev, routes: [...prev.routes, emptyRoute()] }))}
        >
          Add route
        </button>
        <button type="submit" className="primary" disabled={save.isPending}>
          {editing ? 'Save' : 'Add custom API'}
        </button>
        {editing && (
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        )}
        <p className="muted full">
          Paths are globs: <code>*</code> matches one segment, <code>**</code> any number. Requests
          that match no route are refused.
        </p>
      </form>
      {save.isError && <p className="error">{save.error.message}</p>}
    </>
  );
}

/** APIs without a built-in adapter, priced by the org itself. */
export function CustomApis() {
  const qc = useQueryClient();
  const { can } = useRole();
  const apis = useCustomApis();
  const options = useAuthOptions();
  const [editing, setEditing] = useState<CustomApi | null>(null);
  const base = (options.data?.proxyUrl ?? 'https://<your proxy>').replace(/\/$/, '');
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/custom-apis/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      setEditing((e) => (e?.id === id ? null : e));
      void qc.invalidateQueries({ queryKey: ['custom-apis'] });
      // Its provider keys are deleted with it.
      void qc.invalidateQueries({ queryKey: ['credentials'] });
    },
  });
  return (
    <section>
      <h2>Custom APIs</h2>
      <p className="muted">
        Any API without a built-in provider. You give the prices; Spend Brake prices each call with
        them and checks it against your caps, so a cap is only as accurate as the prices you enter.{' '}
        <a href={CUSTOM_APIS_DOCS}>How custom APIs work</a>
      </p>
      <p className="muted">
        A flat price is charged per request. With a cost the API reports, the max per request is
        held before each call and the reported cost is charged after it; when no cost is reported,
        the max is charged, and a cost above the max is charged in full and flagged in Events.
      </p>
      {apis.isError && <p className="error">{apis.error.message}</p>}
      <Table
        rows={apis.data?.items ?? []}
        empty="No custom APIs yet."
        columns={[
          { label: 'Name', render: (a) => a.name },
          { label: 'Id', render: (a) => <code>{a.id}</code> },
          { label: 'Origin', render: (a) => <code>{a.origin}</code> },
          { label: 'Routes', render: (a) => a.routes.length, numeric: true },
          {
            label: 'Call it at',
            render: (a) => {
              const url = `${base}/custom/${a.id}/`;
              return (
                <span className="secret">
                  <code>{url}…</code>
                  <CopyButton text={url} />
                </span>
              );
            },
          },
          ...(can('admin')
            ? [
                {
                  label: '',
                  render: (a: CustomApi) => (
                    <>
                      <button
                        type="button"
                        aria-label={`Edit ${a.name}`}
                        onClick={() => setEditing(a)}
                      >
                        Edit
                      </button>{' '}
                      <button
                        type="button"
                        className="danger"
                        aria-label={`Delete ${a.name}`}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete the custom API "${a.name}"? Its provider keys are deleted too.`,
                            )
                          ) {
                            remove.mutate(a.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
      {remove.isError && <p className="error">{remove.error.message}</p>}
      <p className="muted">
        Then add its API key on <a href="#/keys">Keys</a> and let a Spend Brake key call it. Send
        requests to the URL above plus the path, with the Spend Brake key in X-Brake-Key.
      </p>
      {can('admin') ? (
        <CustomApiForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <p className="muted">Admins and owners can add, change and delete custom APIs.</p>
      )}
    </section>
  );
}
