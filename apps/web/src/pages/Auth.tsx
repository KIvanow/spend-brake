import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError, type AuthOptions, api, setToken } from '../api.js';
import { Brand, PRIVACY_URL, TERMS_URL, TermsConsent } from '../ui.js';

export interface Plan {
  id: string;
  name: string;
  monthlyUsd: number | null;
  selfHosted: boolean;
  purchasable: boolean;
  limits: {
    maxKeys: number | null;
    maxProviders: number | null;
    requestsPerMonth: number | null;
    maxOrgMonthCapMicros: number | null;
  };
}

const go = (route: string) => {
  window.location.hash = route;
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="signin">
      <h1 className="brand">
        <Brand />
      </h1>
      <div className="panel">{children}</div>
    </main>
  );
}

/** Sign in: an emailed link where that is on, an API token otherwise (or on request). */
export function SignIn({
  options,
  onSignedIn,
  error: initialError = null,
}: {
  options: AuthOptions | null;
  onSignedIn: () => void;
  error?: string | null;
}) {
  const emailFirst = options?.emailSignIn ?? false;
  const [useToken, setUseToken] = useState(false);
  const [value, setValue] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/email', { method: 'POST', body: { email: value.trim() } });
      setSentTo(value.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitToken = async (e: FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
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

  if (sentTo) {
    return (
      <Shell>
        <h2>Check your email</h2>
        <p>
          If <strong>{sentTo}</strong> has a Spend Brake account, a sign-in link is on its way. It
          works once, for 15 minutes.
        </p>
        <p className="muted">Nothing arrived? Check spam, or try again in a minute.</p>
        <button type="button" className="link" onClick={() => setSentTo(null)}>
          Use another address
        </button>
      </Shell>
    );
  }

  if (emailFirst && !useToken) {
    return (
      <Shell>
        <form onSubmit={(e) => void submitEmail(e)}>
          <label>
            Email
            <input
              type="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            Email me a sign-in link
          </button>
          {error && <p className="error">{error}</p>}
        </form>
        {options?.signup && (
          <p>
            New here?{' '}
            <a href="#/signup" onClick={() => go('/signup')}>
              Create an account
            </a>
          </p>
        )}
        <button
          type="button"
          className="link"
          onClick={() => {
            setValue('');
            setError(null);
            setUseToken(true);
          }}
        >
          Sign in with an API token
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={(e) => void submitToken(e)}>
        <label>
          Admin API token
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sbt_…"
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" className="primary">
          Sign in
        </button>
        {error && <p className="error">{error}</p>}
      </form>
      {emailFirst ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            setValue('');
            setError(null);
            setUseToken(false);
          }}
        >
          Sign in with email instead
        </button>
      ) : (
        <p className="muted">
          `brake init` saves one to ~/.config/brake/config.json; `brake` can create more.
        </p>
      )}
    </Shell>
  );
}

const money = (usd: number | null) =>
  usd === null ? 'Contact us' : usd === 0 ? '$0' : `$${usd}/month`;

function planSummary(p: Plan): string {
  if (p.selfHosted)
    return 'A license to run Spend Brake on your own servers, with SSO and approvals.';
  const parts = [
    p.limits.maxKeys === null ? 'unlimited keys' : `${p.limits.maxKeys} key`,
    p.limits.maxProviders === null
      ? 'every provider'
      : `${p.limits.maxProviders} provider${p.limits.maxProviders === 1 ? '' : 's'}`,
    p.limits.requestsPerMonth === null
      ? 'unlimited requests'
      : `${p.limits.requestsPerMonth.toLocaleString('en-US')} requests/month`,
  ];
  if (p.limits.maxOrgMonthCapMicros !== null) {
    parts.push(`up to $${p.limits.maxOrgMonthCapMicros / 1_000_000}/month of protected spend`);
  }
  return parts.join(', ');
}

/** Create an account: an org and its owner; paid plans continue to Stripe Checkout. */
export function Signup() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [wanted] = useState(() => /[?&]plan=([a-z]+)/.exec(window.location.hash)?.[1] ?? null);
  const [plan, setPlan] = useState(wanted ?? 'free');
  const [unknownPlan, setUnknownPlan] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api<{ plans: Plan[] }>('/v1/billing/plans')
      .then((r) => {
        // Self-hosted licenses are offered only to people who came for one (?plan=business):
        // the hosted org they create stays on Free limits.
        const offered = r.plans.filter((p) => p.purchasable && (!p.selfHosted || p.id === wanted));
        setPlans(offered);
        // A link naming a plan that is not sold here: fall back to Free and say so.
        if (!offered.some((p) => p.id === wanted)) {
          setUnknownPlan(wanted !== null);
          setPlan('free');
        }
      })
      .catch(() => setPlans([]));
  }, [wanted]);

  const paid = plan !== 'free';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (paid && !acceptTerms) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ checkoutUrl?: string }>('/v1/billing/signup', {
        method: 'POST',
        body: {
          name: name.trim(),
          email: email.trim(),
          plan,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(paid ? { acceptTerms } : {}),
        },
      });
      if (r.checkoutUrl) window.location.assign(r.checkoutUrl);
      else setDone(email.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Shell>
        <h2>Check your email</h2>
        <p>
          We sent a sign-in link to <strong>{done}</strong>. Open it to finish setting up: it works
          once, for 15 minutes.
        </p>
        <a href="#/" onClick={() => go('/')}>
          Back to sign in
        </a>
      </Shell>
    );
  }

  return (
    <Shell>
      <h2>Create your account</h2>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Work email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label>
          Team or project name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme"
            autoComplete="organization"
            maxLength={200}
            required
          />
        </label>
        <fieldset className="plans">
          <legend>Plan</legend>
          {plans === null && <p className="muted">Loading plans…</p>}
          {unknownPlan && (
            <p className="notice">
              The plan in your link is not sold here, so Free is selected. Pick another below.
            </p>
          )}
          {plans?.map((p) => (
            <label key={p.id} className={p.id === plan ? 'plan selected' : 'plan'}>
              <input
                type="radio"
                name="plan"
                value={p.id}
                checked={p.id === plan}
                onChange={() => setPlan(p.id)}
              />
              <span>
                <strong>{p.name}</strong> · {money(p.monthlyUsd)}
                <br />
                <span className="muted">{planSummary(p)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {paid ? (
          <TermsConsent checked={acceptTerms} onChange={setAcceptTerms} />
        ) : (
          <p className="muted">
            By creating an account you agree to the{' '}
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            .
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || (paid && !acceptTerms)}>
          {paid ? 'Continue to payment' : 'Create account'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
      <p>
        Have an account?{' '}
        <a href="#/" onClick={() => go('/')}>
          Sign in
        </a>
      </p>
    </Shell>
  );
}

/** Where Stripe Checkout returns a new customer, before they have signed in. */
export function Welcome() {
  return (
    <Shell>
      <h2>Check your email</h2>
      <p>Your account is ready and we emailed you a sign-in link. Open it to finish setting up.</p>
      <p className="muted">
        Paid? Your plan shows under Billing once Stripe confirms it, usually within a minute. Left
        the payment page? You're on Free and can upgrade under Billing any time.
      </p>
      <a href="#/" onClick={() => go('/')}>
        Back to sign in
      </a>
    </Shell>
  );
}

/** Spend an emailed link: sign in, or say why not. */
export async function redeemLoginCode(code: string): Promise<string | null> {
  try {
    const r = await api<{ token: string }>('/v1/auth/email/verify', {
      method: 'POST',
      body: { code },
    });
    setToken(r.token, { remember: true });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
