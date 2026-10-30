import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { takeLoginCode, takeSsoToken } from './api.js';
import { redeemLoginCode } from './pages/Auth.js';

takeSsoToken();
// Spent here, once: a link works only one time (StrictMode runs effects twice in development).
const code = takeLoginCode();
const signingIn = code ? redeemLoginCode(code) : null;

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App signingIn={signingIn} />
  </StrictMode>,
);
