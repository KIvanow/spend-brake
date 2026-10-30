import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type AuthOptions, SIGNED_OUT, api, getToken, setToken } from './api.js';
import { Approvals } from './pages/Approvals.js';
import { SignIn, Signup, Welcome } from './pages/Auth.js';
import { Billing } from './pages/Billing.js';
import { Caps } from './pages/Caps.js';
import { Events } from './pages/Events.js';
import { Keys } from './pages/Keys.js';
import { Migration } from './pages/Migration.js';
import { Overview } from './pages/Overview.js';
import { Setup } from './pages/Setup.js';
import { Spend } from './pages/Spend.js';
import { Team } from './pages/Team.js';
import { Telemetry } from './pages/Telemetry.js';
import { Webhooks } from './pages/Webhooks.js';
import './styles.css';

const PAGES = {
  Overview,
  Setup,
  Spend,
  Events,
  Caps,
  Approvals,
  Keys,
  Team,
  Webhooks,
  Telemetry,
  Migration,
  Billing,
} as const;
type PageName = keyof typeof PAGES;
const LABELS: Partial<Record<PageName, string>> = { Setup: 'Get started' };

const route = () => window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';

// Pages live in the URL hash (#/caps), so links from alerts and bookmarks open the right page.
const pageFromHash = (): PageName =>
  (Object.keys(PAGES) as PageName[]).find((p) => p.toLowerCase() === route().toLowerCase()) ??
  'Overview';

export function App({
  client = new QueryClient(),
  signingIn = null,
}: {
  client?: QueryClient;
  /** An emailed sign-in link being spent: resolves to an error message, or null when signed in. */
  signingIn?: Promise<string | null> | null;
}) {
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [pending, setPending] = useState(signingIn !== null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [page, setPageState] = useState<PageName>(pageFromHash);
  const [publicRoute, setPublicRoute] = useState(route);

  useEffect(() => {
    const onHash = () => {
      setPageState(pageFromHash());
      setPublicRoute(route());
    };
    const onSignedOut = () => {
      client.clear();
      setSignedIn(false);
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener(SIGNED_OUT, onSignedOut);
    };
  }, [client]);

  useEffect(() => {
    if (signingIn === null) return;
    let live = true;
    void signingIn.then((error) => {
      if (!live) return;
      setLinkError(error);
      setSignedIn(error === null);
      setPending(false);
    });
    return () => {
      live = false;
    };
  }, [signingIn]);

  useEffect(() => {
    if (signedIn) return;
    api<AuthOptions>('/v1/auth/options')
      .then(setOptions)
      .catch(() =>
        setOptions({ emailSignIn: false, signup: false, proxyUrl: null, egressIps: [] }),
      );
  }, [signedIn]);

  const setPage = (p: PageName) => {
    window.location.hash = `/${p.toLowerCase()}`;
    setPageState(p);
  };

  if (pending) {
    return (
      <main className="signin">
        <h1>Spend Brake</h1>
        <p className="muted">Signing you in…</p>
      </main>
    );
  }
  if (!signedIn) {
    if (publicRoute === 'signup') return <Signup />;
    if (publicRoute === 'welcome') return <Welcome />;
    if (!options) return null;
    return (
      <SignIn
        options={options}
        error={linkError}
        onSignedIn={() => {
          setLinkError(null);
          setSignedIn(true);
        }}
      />
    );
  }
  const Page = PAGES[page];
  return (
    <QueryClientProvider client={client}>
      <header>
        <strong>Spend Brake</strong>
        <nav>
          {(Object.keys(PAGES) as PageName[]).map((p) => (
            <button
              key={p}
              type="button"
              aria-current={p === page ? 'page' : undefined}
              onClick={() => setPage(p)}
            >
              {LABELS[p] ?? p}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="link"
          onClick={() => {
            setToken(null);
            client.clear();
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </header>
      <main>
        <Page />
      </main>
    </QueryClientProvider>
  );
}
