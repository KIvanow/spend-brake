import type { ActionClaims } from '@spend-brake/shared';
import { targetName, usd } from './message.js';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

// The dashboard's tokens, type and brand mark (apps/web/src/styles.css), inlined: the CSP allows
// inline styles only, and nothing is fetched.
const STYLE = `
:root{--bg:#f7f7f5;--surface:#fff;--text:#1b1b19;--muted:#6b6b66;--border:#e2e2dc;--accent:#1d4ed8;--accent-ink:#fff;--brake:#c92a1f;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--surface:#1d1d1b;--text:#ececea;--muted:#9b9b95;--border:#33332f;--accent:#7aa2ff;--accent-ink:#0f1a33;--brake:#ff7a6e;color-scheme:dark}}
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:40px 16px;background:var(--bg);color:var(--text)}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 20px;font-size:18px;font-weight:650;letter-spacing:-0.01em}
.brand svg{width:28px;height:28px}.ring{fill:none;stroke:var(--accent);stroke-width:3}.pad{fill:var(--brake)}
main{max-width:480px;margin:0 auto;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;box-shadow:0 1px 2px rgb(0 0 0/.04),0 12px 32px -16px rgb(0 0 0/.18)}
h1{font-size:20px;line-height:1.25;letter-spacing:-0.015em;margin:0 0 12px}p{margin:0 0 1em}main>:last-child{margin-bottom:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{font:inherit;font-weight:600;padding:9px 18px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--accent-ink);cursor:pointer}
button.danger{background:var(--brake);border-color:var(--brake);color:#fff}
input{font:inherit;padding:7px 10px;width:8em;border:1px solid #8a8a84;border-radius:8px;background:var(--surface);color:var(--text)}
.muted{color:var(--muted);font-size:14px}.back{text-align:center;margin-top:20px;font-size:14px}`;

const MARK =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><circle class="ring" cx="16" cy="16" r="12.5"/><rect class="pad" x="8" y="14" width="16" height="4" rx="1"/></svg>';

/** A link to the dashboard, when the notifier knows where it is (BRAKE_DASHBOARD_URL). */
const dashboardLink = (url: string | undefined, text: string) =>
  url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text);

function layout(title: string, body: string, dashboardUrl?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Spend Brake</title>
<style>${STYLE}</style></head><body>
<p class="brand">${MARK}Spend Brake</p>
<main>${body}</main>
${dashboardUrl ? `<p class="back"><a href="${esc(dashboardUrl)}">Back to the dashboard</a></p>` : ''}
</body></html>`;
}

function describe(
  c: ActionClaims,
  keyName: string | null,
): { title: string; detail: string; danger: boolean } {
  // A reset link carries the bare key id; every other target is a scope or kill label.
  const target = targetName(c.act === 'reset' ? `key:${c.target}` : c.target, keyName);
  switch (c.act) {
    case 'kill':
      return {
        title: `Stop all spending for ${target}?`,
        detail: 'Requests are refused immediately until someone lifts the kill in the dashboard.',
        danger: true,
      };
    case 'raise':
      return {
        title: `Raise the ${c.kind === 'm' ? 'monthly' : 'daily'} cap of ${target}?`,
        detail:
          c.amount === 'custom'
            ? `Choose how much to add (up to ${usd(c.max ?? 0)}).`
            : `The hard cap goes up by ${usd(c.amount)}.`,
        danger: false,
      };
    case 'mute':
      return {
        title: `Mute alerts for ${target} for 24 hours?`,
        detail: 'Caps keep enforcing; only the messages stop.',
        danger: false,
      };
    case 'reset':
      return {
        title: `Reset the loop circuit of ${keyName ? target : `key ${c.target}`}?`,
        detail: 'The key can make requests again right away. If the loop continues it trips again.',
        danger: false,
      };
  }
}

/** Confirm page. GET only renders it; nothing changes until the form is posted. */
export function confirmPage(
  c: ActionClaims,
  opts: { loginRequired: boolean; keyName?: string | null; dashboardUrl?: string | undefined },
): string {
  const d = describe(c, opts.keyName ?? null);
  if (c.act === 'raise' && opts.loginRequired) {
    return layout(
      d.title,
      `<h1>${esc(d.title)}</h1><p>Your organisation raises caps from the dashboard only. ${dashboardLink(opts.dashboardUrl, 'Sign in there')} to change this cap.</p>`,
      opts.dashboardUrl,
    );
  }
  const amount =
    c.act === 'raise' && c.amount === 'custom'
      ? `<p><label>Amount in USD <input name="amountUsd" type="number" min="1" step="1" max="${esc(String(Number(BigInt(c.max ?? '0') / 1_000_000n)))}" required></label></p>`
      : '';
  return layout(
    d.title,
    `<h1>${esc(d.title)}</h1><p>${esc(d.detail)}</p>
<form method="post">${amount}<button type="submit"${d.danger ? ' class="danger"' : ''}>Confirm</button></form>
<p class="muted">This link works once and expires ${esc(new Date(c.exp * 1000).toISOString().replace('T', ' ').slice(0, 16))} UTC.</p>`,
    opts.dashboardUrl,
  );
}

export function resultPage(ok: boolean, message: string, dashboardUrl?: string): string {
  const title = ok ? 'Done' : 'Not done';
  return layout(title, `<h1>${title}</h1><p>${esc(message)}</p>`, dashboardUrl);
}
