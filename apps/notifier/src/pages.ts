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

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#f6f6f4;color:#1c1c1a}
main{max-width:480px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;padding:24px}
h1{font-size:20px;margin:0 0 12px}button{font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#1c1c1a;color:#fff;cursor:pointer}
button.danger{background:#b3261e}input{font:inherit;padding:8px;width:8em}.muted{color:#666;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#151514;color:#eee}main{background:#1f1f1d;border-color:#333}button{background:#eee;color:#111}.muted{color:#aaa}}
</style></head><body><main>${body}</main></body></html>`;
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
  opts: { loginRequired: boolean; keyName?: string | null },
): string {
  const d = describe(c, opts.keyName ?? null);
  if (c.act === 'raise' && opts.loginRequired) {
    return layout(
      d.title,
      `<h1>${esc(d.title)}</h1><p>Your organisation raises caps from the dashboard only. Sign in there to change this cap.</p>`,
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
  );
}

export function resultPage(ok: boolean, message: string): string {
  const title = ok ? 'Done' : 'Not done';
  return layout(title, `<h1>${title}</h1><p>${esc(message)}</p>`);
}
