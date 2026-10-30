import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type AuthOptions, SIGNED_OUT, api, getToken, setToken, takeLoginCode } from './api.js';
import { Approvals } from './pages/Approvals.js';
import { useAuthOptions } from './pages/Keys.js';
import { SignIn, Signup, Welcome, redeemLoginCode } from './pages/Auth.js';
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

/**
 * The page links. Approvals need a self-hosted Business or Enterprise license, so the hosted
 * service (where sign-up is open) leaves them out.
 */
function Nav({ page, setPage }: { page: PageName; setPage: (p: PageName) => void }) {
  const options = useAuthOptions();
  const hidden = new Set<PageName>(options.data?.signup ? ['Approvals'] : []);
  return (
    <nav>
      {(Object.keys(PAGES) as PageName[])
        .filter((p) => !hidden.has(p) || p === page)
        .map((p) => (
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
  );
}

const route = () => window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';

// Pages live in the URL hash (#/caps), so links from alerts and bookmarks open the right page.
const pageFromHash = (): PageName =>
  (Object.keys(PAGES) as PageName[]).find((p) => p.toLowerCase() === route().toLowerCase()) ??
  'Overview';

export function App({
  client = new QueryClient(),
  signingIn: firstLink = null,
}: {
  client?: QueryClient;
  /** An emailed sign-in link being spent: resolves to an error message, or null when signed in. */
  signingIn?: Promise<string | null> | null;
}) {
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [signingIn, setSigningIn] = useState(firstLink);
  const [pending, setPending] = useState(firstLink !== null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [page, setPageState] = useState<PageName>(pageFromHash);
  const [publicRoute, setPublicRoute] = useState(route);

  useEffect(() => {
    const onHash = () => {
      // An emailed link opened in a tab that is already open: spend it now, not on reload.
      const code = takeLoginCode();
      if (code) {
        setPending(true);
        setSigningIn(redeemLoginCode(code));
      }
      setPageState(pageFromHash());
      setPublicRoute(route());
    };
    const onSignedOut = () => {
      client.clear();
      setSignedIn(false);
      setLinkError(
        'Your session ended: it expired, you were signed out, or your role changed. Sign in again.',
      );
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
      if (error === null) client.clear();
      setLinkError(error);
      setSignedIn(error === null || getToken() !== null);
      setPending(false);
    });
    return () => {
      live = false;
    };
  }, [signingIn, client]);

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
        <Nav page={page} setPage={setPage} />
        <button
          type="button"
          className="link"
          onClick={() => {
            // End the session on the server too, so a copied token stops working; signing
            // out here never waits for it.
            void api('/v1/auth/session', { method: 'DELETE' }).catch(() => undefined);
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
