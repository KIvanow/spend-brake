import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { startAnalytics } from './analytics.js';
import { type AuthOptions, api, takeLoginCode, takeSsoToken } from './api.js';
import { redeemLoginCode } from './pages/Auth.js';

takeSsoToken();
// Spent here, once: a link works only one time (StrictMode runs effects twice in development).
const code = takeLoginCode();
const signingIn = code ? redeemLoginCode(code) : null;
// After the hash lost any code or token: analytics only when this install turned them on.
void api<AuthOptions>('/v1/auth/options')
  .then((o) => startAnalytics(o.analytics))
  .catch(() => undefined);

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App signingIn={signingIn} />
  </StrictMode>,
);
