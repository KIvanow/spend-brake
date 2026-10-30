import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api, usd } from '../api.js';
import {
  AddProviderKey,
  CreateKey,
  KeyAdvice,
  type KeyCheck,
  NewKey,
  useAuthOptions,
  useCredentials,
  useKeys,
} from './Keys.js';

interface CapRow {
  scope: string;
  kind: 'd' | 'm';
  hard: number | null;
}

const go = (page: string) => {
  window.location.hash = `/${page}`;
};

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <li className={done ? 'step done' : 'step'}>
      <h3>
        <span className="step-n" aria-hidden="true">
          {done ? '✓' : n}
        </span>
        {title}
      </h3>
      {children}
    </li>
  );
}

/** First run: connect a provider, create a key, set a cap, make a call. */
export function Setup() {
  const credentials = useCredentials();
  const keys = useKeys();
  const options = useAuthOptions();
  const caps = useQuery({
    queryKey: ['caps'],
    queryFn: () => api<{ items: CapRow[] }>('/v1/caps'),
  });
  const calls = useQuery({
    queryKey: ['spend', 'setup'],
    queryFn: () => api<{ items: { requests: number }[] }>('/v1/spend?groupBy=key'),
    refetchInterval: 10_000,
  });
  const [created, setCreated] = useState<{ token: string; providers: string[] } | null>(null);
  // Google's verdict on the key just added: shown after the step completes, too.
  const [check, setCheck] = useState<KeyCheck | null>(null);

  const creds = credentials.data?.items ?? [];
  const activeKeys = (keys.data?.items ?? []).filter((k) => k.status === 'active');
  const orgCaps = (caps.data?.items ?? []).filter((c) => c.scope === 'org' && c.hard !== null);
  const requests = (calls.data?.items ?? []).reduce((n, r) => n + r.requests, 0);

  return (
    <section>
      <h2>Get started</h2>
      <p className="muted">
        Spend Brake sits between your apps and the paid APIs they call. It prices every call and
        refuses the ones that would go over your caps, before the provider bills you.
      </p>
      <ol className="steps">
        <Step n={1} title="Add your provider key" done={creds.length > 0}>
          {creds.length > 0 ? (
            <p className="muted">
              Connected: {[...new Set(creds.map((c) => c.provider))].join(', ')}.{' '}
              <a href="#/keys" onClick={() => go('keys')}>
                Add another
              </a>
            </p>
          ) : (
            <AddProviderKey onAdded={setCheck} />
          )}
          {check && <KeyAdvice check={check} />}
        </Step>
        <Step
          n={2}
          title="Create a key for your app"
          done={activeKeys.length > 0 || created !== null}
        >
          {created ? (
            <NewKey
              token={created.token}
              providers={created.providers}
              proxyUrl={options.data?.proxyUrl ?? null}
            />
          ) : activeKeys.length > 0 ? (
            <p className="muted">
              {activeKeys.length} key{activeKeys.length === 1 ? '' : 's'}.{' '}
              <a href="#/keys" onClick={() => go('keys')}>
                Manage keys
              </a>
            </p>
          ) : (
            <CreateKey
              key={creds.map((c) => c.id).join()}
              credentials={creds}
              onCreated={setCreated}
            />
          )}
        </Step>
        <Step n={3} title="Set your spending caps" done={orgCaps.length > 0}>
          <p className="muted">
            {orgCaps.length > 0
              ? `Your org stops at ${orgCaps
                  .map((c) => `${usd(c.hard)} a ${c.kind === 'd' ? 'day' : 'month'}`)
                  .join(' and ')}. `
              : 'No cap yet: calls go through with no limit. '}
            <a href="#/caps" onClick={() => go('caps')}>
              {orgCaps.length > 0 ? 'Change caps' : 'Set a cap'}
            </a>
          </p>
        </Step>
        <Step n={4} title="Make a call from your app" done={requests > 0}>
          <p className="muted">
            {requests > 0
              ? `${requests.toLocaleString('en-US')} call${requests === 1 ? '' : 's'} so far. `
              : 'Waiting for the first call through Spend Brake (this updates by itself). '}
            <a href="#/spend" onClick={() => go('spend')}>
              See spend
            </a>
          </p>
        </Step>
      </ol>
    </section>
  );
}
