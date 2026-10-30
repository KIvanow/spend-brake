import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, getToken, setToken } from './api.js';
import { Approvals } from './pages/Approvals.js';
import { Billing } from './pages/Billing.js';
import { Caps } from './pages/Caps.js';
import { Events } from './pages/Events.js';
import { Keys } from './pages/Keys.js';
import { Migration } from './pages/Migration.js';
import { Overview } from './pages/Overview.js';
import { Spend } from './pages/Spend.js';
import { Webhooks } from './pages/Webhooks.js';
import './styles.css';

const PAGES = {
  Overview,
  Spend,
  Events,
  Caps,
  Approvals,
  Keys,
  Webhooks,
  Migration,
  Billing,
} as const;
type PageName = keyof typeof PAGES;

// Pages live in the URL hash (#/caps), so links from alerts and bookmarks open the right page.
const pageFromHash = (): PageName => {
  const name = window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';
  return (
    (Object.keys(PAGES) as PageName[]).find((p) => p.toLowerCase() === name.toLowerCase()) ??
    'Overview'
  );
};

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setToken(token.trim());
    try {
      await api('/v1/org');
      onSignedIn();
    } catch (err) {
      setToken(null);
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That token is not valid.'
          : (err as Error).message,
      );
    }
  };
  return (
    <main className="signin">
      <h1>Spend Brake</h1>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Admin API token
          <input
            type="password"
            value={token}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sbt_…"
            autoComplete="off"
            required
          />
        </label>
        <button type="submit">Sign in</button>
        {error && <p className="error">{error}</p>}
      </form>
      <p className="muted">
        `brake init` saves one to ~/.config/brake/config.json; `brake` can create more.
      </p>
    </main>
  );
}

export function App({ client = new QueryClient() }: { client?: QueryClient }) {
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [page, setPageState] = useState<PageName>(pageFromHash);
  useEffect(() => {
    const onHash = () => setPageState(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setPage = (p: PageName) => {
    window.location.hash = `/${p.toLowerCase()}`;
    setPageState(p);
  };
  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;
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
              {p}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="link"
          onClick={() => {
            setToken(null);
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
