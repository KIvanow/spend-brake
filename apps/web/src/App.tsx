import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  type AuthOptions,
  SIGNED_OUT,
  api,
  getToken,
  setToken,
  takeLoginCode,
  tokenChangedElsewhere,
} from './api.js';
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
import { Brand } from './ui.js';
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
const pageLabel = (p: PageName) => LABELS[p] ?? p;

/**
 * The page links. Approvals need a self-hosted Business or Enterprise license, so the hosted
 * service (where sign-up is open) leaves them out.
 *
 * Below 1180px the links fold into a menu, as on the website: the Menu button names the current
 * page, opens the list, and Escape, focus or a click outside it, or picking a page closes it.
 */
function Nav({ page, setPage }: { page: PageName; setPage: (p: PageName) => void }) {
  const options = useAuthOptions();
  const hidden = new Set<PageName>(options.data?.signup ? ['Approvals'] : []);
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    // Move focus into the list, onto the current page; Tab goes on from there.
    list.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !toggle.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', outside);
    // Tab past the last page (to Sign out, say) closes the list too.
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);
  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="menu-toggle"
        aria-expanded={open}
        aria-controls="pages"
        aria-label={`Menu, current page: ${pageLabel(page)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="label">Menu</span>
        <span className="here">{pageLabel(page)}</span>
      </button>
      <nav id="pages" ref={list} aria-label="Pages" className={open ? 'open' : undefined}>
        {(Object.keys(PAGES) as PageName[])
          .filter((p) => !hidden.has(p) || p === page)
          .map((p) => (
            <button
              key={p}
              type="button"
              aria-current={p === page ? 'page' : undefined}
              onClick={() => {
                setOpen(false);
                setPage(p);
              }}
            >
              {pageLabel(p)}
            </button>
          ))}
      </nav>
    </>
  );
}

const route = () => window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';

// Pages live in the URL hash (#/caps), so links from alerts and bookmarks open the right page.
const pageFromHash = (): PageName =>
  (Object.keys(PAGES) as PageName[]).find((p) => p.toLowerCase() === route().toLowerCase()) ??
  'Overview';

export function App({
  client: givenClient,
  signingIn: firstLink = null,
}: {
  client?: QueryClient;
  /** An emailed sign-in link being spent: resolves to an error message, or null when signed in. */
  signingIn?: Promise<string | null> | null;
}) {
  // One cache for the life of the page: a new client on every render would drop queries in
  // flight and re-run every effect that depends on it.
  const [client] = useState(() => givenClient ?? new QueryClient());
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [signingIn, setSigningIn] = useState(firstLink);
  const [pending, setPending] = useState(firstLink !== null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [page, setPageState] = useState<PageName>(pageFromHash);
  const [publicRoute, setPublicRoute] = useState(route);
  // Bumped when another tab signs in as someone else: every page mounts afresh, so nothing the
  // previous person's queries loaded (their role, their org's tables) stays on screen.
  const [session, setSession] = useState(0);

  // One title per page, so tabs and history entries say where they are.
  useEffect(() => {
    document.title = signedIn && !pending ? `${pageLabel(page)} · Spend Brake` : 'Spend Brake';
  }, [page, signedIn, pending]);

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
      setSigningIn(null);
      setPending(false);
      setSignedIn(false);
      setLinkError(
        'Your session ended: it expired, you were signed out, or your role changed. Sign in again.',
      );
    };
    // Signed out, or in as another person or org, in another tab: follow it here.
    const onStorage = (e: StorageEvent) => {
      const change = tokenChangedElsewhere(e);
      if (!change) return;
      client.clear();
      setSigningIn(null);
      setPending(false);
      setSignedIn(change.token !== null);
      setLinkError(change.token === null ? 'You signed out in another tab. Sign in again.' : null);
      setSession((n) => n + 1);
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener(SIGNED_OUT, onSignedOut);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener(SIGNED_OUT, onSignedOut);
      window.removeEventListener('storage', onStorage);
    };
  }, [client]);

  useEffect(() => {
    if (signingIn === null) return;
    let live = true;
    void signingIn.then((error) => {
      if (!live) return;
      // Handled once: later renders must not sign the tab back in (after Sign out, say).
      setSigningIn(null);
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

  const heading = useRef<HTMLHeadingElement>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  // A page picked from the nav: move focus to its heading, so keyboard and screen-reader users
  // land on the new page instead of at the top of the document.
  useEffect(() => {
    if (!focusHeading) return;
    setFocusHeading(false);
    heading.current?.focus();
  }, [focusHeading, page]);

  const setPage = (p: PageName) => {
    window.location.hash = `/${p.toLowerCase()}`;
    setPageState(p);
    setFocusHeading(true);
  };

  if (pending) {
    return (
      <main className="signin">
        <h1 className="brand">
          <Brand />
        </h1>
        <div className="panel">
          <p className="muted">Signing you in…</p>
        </div>
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
    <QueryClientProvider key={session} client={client}>
      {/* A hash link would change the page (routes live in the hash), so it moves focus itself. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          heading.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="top">
        <strong className="brand">
          <Brand />
        </strong>
        <Nav page={page} setPage={setPage} />
        <button
          type="button"
          className="link signout"
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
      <main id="main">
        {/* Each page's own headings start at h2; this names the page for the outline. */}
        <h1 className="visually-hidden" ref={heading} tabIndex={-1}>
          {pageLabel(page)}
        </h1>
        <Page />
      </main>
    </QueryClientProvider>
  );
}
