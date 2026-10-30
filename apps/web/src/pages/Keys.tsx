import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { type AuthOptions, type Key, api } from '../api.js';
import { PROVIDERS, providerById } from '../providers.js';
import { Table } from '../ui.js';

export interface Credential {
  id: string;
  provider: string;
  name: string;
  hint: string;
  createdAt: string;
}

export interface KeyCheck {
  apiRestricted: boolean | null;
  ipRestricted: boolean | null;
  valid: boolean | null;
  warnings: string[];
}

export const useCredentials = () =>
  useQuery({
    queryKey: ['credentials'],
    queryFn: () => api<{ items: Credential[] }>('/v1/providers/credentials'),
  });

export const useKeys = () =>
  useQuery({ queryKey: ['keys'], queryFn: () => api<{ items: Key[] }>('/v1/keys') });

export const useAuthOptions = () =>
  useQuery({
    queryKey: ['auth-options'],
    queryFn: () => api<AuthOptions>('/v1/auth/options'),
    staleTime: Infinity,
  });

/** Store a provider's real key (encrypted; never shown again). */
export function AddProviderKey({
  onAdded,
}: {
  /** Called with Google's verdict on the key, when it was checked. */
  onAdded?: (check: KeyCheck | null) => void;
}) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState(PROVIDERS[0]!.id);
  const [secret, setSecret] = useState('');
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const info = providerById(provider)!;
  const add = useMutation({
    mutationFn: () =>
      api<Credential & { check?: KeyCheck }>('/v1/providers/credentials', {
        method: 'POST',
        body: { provider, name: info.name, secret: secret.trim() },
      }),
    onSuccess: (c) => {
      setSecret('');
      setCheck(c.check ?? null);
      void qc.invalidateQueries({ queryKey: ['credentials'] });
      onAdded?.(c.check ?? null);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <>
      <form className="form" onSubmit={submit}>
        <h3>Add a provider key</h3>
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Your {info.name} {info.secret}
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" className="primary" disabled={add.isPending}>
          Add key
        </button>
        <p className="muted full">
          Stored encrypted. Spend Brake uses it to call {info.name} for you and never shows it
          again.
        </p>
      </form>
      {add.isError && <p className="error">{add.error.message}</p>}
      {check && !onAdded && <KeyAdvice check={check} />}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * After a Google key is added: the exact Google Cloud changes that leave Spend Brake the only way
 * to spend with it (the proxy's addresses, the Maps APIs only).
 */
export function KeyAdvice({ check }: { check: KeyCheck }) {
  const options = useAuthOptions();
  const ips = options.data?.egressIps ?? [];
  if (check.valid === false) {
    return (
      <p className="error">Google says this API key is not valid. Check it and add it again.</p>
    );
  }
  const needIps = check.ipRestricted !== true;
  const needApis = check.apiRestricted === false;
  if (!needIps && !needApis) {
    return check.warnings.length ? <p className="muted">{check.warnings.join(' ')}</p> : null;
  }
  if (needIps && ips.length === 0) {
    return (
      <div className="callout">
        <strong>Lock this key down so it only works through Spend Brake:</strong>
        <ul>
          {check.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="callout">
      <strong>Lock this key down so it only works through Spend Brake.</strong> Anyone who gets a
      copy of an unrestricted key can spend on your Google bill without passing any cap.
      <p>
        In Google Cloud, open{' '}
        <a
          href="https://console.cloud.google.com/apis/credentials"
          target="_blank"
          rel="noreferrer"
        >
          APIs &amp; Services → Credentials
        </a>{' '}
        and click this key. Then:
      </p>
      <ol>
        {needIps && (
          <li>
            Under <strong>Application restrictions</strong>, choose <strong>IP addresses</strong>{' '}
            and add {ips.length > 1 ? 'these addresses' : 'this address'} (where Spend Brake calls
            Google from):
            {ips.map((ip) => (
              <p key={ip} className="secret">
                <code>{ip}</code>
                <CopyButton text={ip} />
              </p>
            ))}
          </li>
        )}
        {needApis && (
          <li>
            Under <strong>API restrictions</strong>, choose <strong>Restrict key</strong> and tick
            only the Maps APIs you use: Places API (New), Geocoding API, Routes API.
          </li>
        )}
        <li>
          Save. Google takes up to 5 minutes to apply it; until then, calls may still go through
          from anywhere.
        </li>
      </ol>
      <p className="muted">
        Calls from your own servers will then fail: send them through Spend Brake.
      </p>
    </div>
  );
}

/** Create a Spend Brake key for an app or agent: the token is shown once. */
export function CreateKey({
  credentials,
  onCreated,
}: {
  credentials: Credential[];
  onCreated?: (created: { token: string; providers: string[] }) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(() => credentials.map((c) => c.id));
  const create = useMutation({
    mutationFn: () => {
      const picked = credentials.filter((c) => chosen.includes(c.id));
      return api<Key & { token: string }>('/v1/keys', {
        method: 'POST',
        body: {
          name: name.trim(),
          credentials: Object.fromEntries(picked.map((c) => [c.provider, c.id])),
        },
      }).then((k) => ({ token: k.token, providers: picked.map((c) => c.provider) }));
    },
    onSuccess: (created) => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['keys'] });
      onCreated?.(created);
    },
  });
  if (credentials.length === 0) {
    return <p className="muted">Add a provider key first: a Spend Brake key calls it for you.</p>;
  }
  // One key per provider: the newest of each.
  const perProvider = [...new Map(credentials.map((c) => [c.provider, c])).values()];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <>
      <form className="form" onSubmit={submit}>
        <h3>Create a Spend Brake key</h3>
        <label className="grow">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="web app (production)"
            maxLength={200}
            required
          />
        </label>
        <fieldset className="checks">
          <legend>Can call</legend>
          {perProvider.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={chosen.includes(c.id)}
                onChange={(e) =>
                  setChosen((prev) =>
                    e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id),
                  )
                }
              />
              {providerById(c.provider)?.name ?? c.provider}
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          className="primary"
          disabled={create.isPending || !perProvider.some((c) => chosen.includes(c.id))}
        >
          Create key
        </button>
      </form>
      {create.isError && <p className="error">{create.error.message}</p>}
    </>
  );
}

/** The new key, once, with the change to make in the app. */
export function NewKey({
  token,
  providers,
  proxyUrl,
}: {
  token: string;
  providers: string[];
  proxyUrl: string | null;
}) {
  const base = (proxyUrl ?? 'https://<your proxy>').replace(/\/$/, '');
  return (
    <div className="callout">
      <p>
        <strong>Your Spend Brake key.</strong> Copy it now: it is not shown again.
      </p>
      <p className="secret">
        <code>{token}</code>
        <CopyButton text={token} />
      </p>
      <p>In your app, change two things for each provider:</p>
      {providers.map((id) => {
        const info = providerById(id);
        if (!info) return null;
        return (
          <div key={id}>
            <h4>{info.name}</h4>
            <ul>
              {info.routes.map((r) => (
                <li key={r.prefix}>
                  <code>{r.from}</code> → <code>{`${base}${r.prefix}`}</code>
                </li>
              ))}
              <li>
                Use this key instead of your {info.name} key, in {info.keyIn}.
              </li>
            </ul>
          </div>
        );
      })}
      <p className="muted">
        Every response carries X-Brake-Cost-Micros. Past a cap, requests get HTTP 402 instead of a
        bill.
      </p>
    </div>
  );
}

export function Keys() {
  const qc = useQueryClient();
  const keys = useKeys();
  const credentials = useCredentials();
  const options = useAuthOptions();
  const [created, setCreated] = useState<{ token: string; providers: string[] } | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['keys'] }),
  });
  const removeCredential = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/providers/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['credentials'] }),
  });
  return (
    <section>
      <h2>Provider keys</h2>
      <p className="muted">
        Your real keys for each provider. Apps never see them: they use Spend Brake keys.
      </p>
      <Table
        rows={credentials.data?.items ?? []}
        empty="No provider keys yet."
        columns={[
          { label: 'Provider', render: (c) => providerById(c.provider)?.name ?? c.provider },
          { label: 'Key', render: (c) => <code>…{c.hint}</code> },
          { label: 'Added', render: (c) => c.createdAt.slice(0, 10) },
          {
            label: '',
            render: (c) => (
              <button
                type="button"
                className="danger"
                disabled={removeCredential.isPending}
                onClick={() => removeCredential.mutate(c.id)}
              >
                Delete
              </button>
            ),
          },
        ]}
      />
      <AddProviderKey />
      {removeCredential.isError && <p className="error">{removeCredential.error.message}</p>}

      <h2>Spend Brake keys</h2>
      <p className="muted">
        One per app or agent. Each call through Spend Brake is priced and checked against your caps
        before it reaches the provider.
      </p>
      <Table
        rows={keys.data?.items ?? []}
        empty="No keys yet."
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
      {credentials.data && (
        <CreateKey
          key={credentials.data.items.map((c) => c.id).join()}
          credentials={credentials.data.items}
          onCreated={setCreated}
        />
      )}
      {created && (
        <NewKey
          token={created.token}
          providers={created.providers}
          proxyUrl={options.data?.proxyUrl ?? null}
        />
      )}
    </section>
  );
}
