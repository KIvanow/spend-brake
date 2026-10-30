import { type ActionKind, type AlertJob, signAction } from '@spend-brake/shared';

export interface Action {
  id: string;
  label: string;
  url: string;
}

/** The provider-neutral alert every preset is rendered from (also the `raw` payload). */
export interface Message {
  id: string;
  type: AlertJob['type'];
  orgId: string | null;
  occurredAt: string;
  title: string;
  text: string;
  data: Record<string, unknown>;
  actions: Action[];
}

/** One SKU price change in a catalog update (readable prices; null = not in that version). */
interface PriceChange {
  sku: string;
  from: string | null;
  to: string | null;
}

export interface LinkOptions {
  publicUrl: string;
  dashboardUrl?: string | undefined;
  actionSecret: string;
  ttlSec: number;
  maxCustomMicros: bigint;
  now: () => Date;
}

export const usd = (micros: unknown): string => {
  const m =
    typeof micros === 'bigint' || typeof micros === 'number' || typeof micros === 'string'
      ? BigInt(micros)
      : 0n;
  const cents = (m + 5_000n) / 10_000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
};

const windowName = (w: unknown) => (String(w).startsWith('d:') ? 'today' : 'this month');

/**
 * Which kill target stops spend for a cap scope. Agent and environment scopes have no kill
 * target of their own: the key that crossed the mark is killed rather than the whole org.
 */
export function killTargetFor(scope: string, keyId?: unknown): string | null {
  const [kind, a] = scope.split(':');
  if (kind === 'key' || kind === 'sess') return `${kind}:${a}`;
  if (kind === 'sku') return `prov:${a}`;
  if (kind === 'org') return 'org';
  return typeof keyId === 'string' && keyId ? `key:${keyId}` : null;
}

export function buildMessage(alertId: string, job: AlertJob, o: LinkOptions): Message {
  const now = o.now();
  const exp = Math.floor(now.getTime() / 1000) + o.ttlSec;
  const link = (act: ActionKind, target: string, extra: Record<string, string> = {}) =>
    `${o.publicUrl.replace(/\/$/, '')}/a/${signAction(o.actionSecret, {
      org: job.orgId!,
      act,
      target,
      exp,
      alert: alertId,
      ...extra,
    })}`;
  const view = (path: string): Action[] =>
    o.dashboardUrl
      ? [{ id: 'view', label: 'View', url: `${o.dashboardUrl.replace(/\/$/, '')}${path}` }]
      : [];
  const raise = (scope: string, window: unknown): Action[] => {
    const kind = String(window).startsWith('m:') ? 'm' : 'd';
    return [
      {
        id: 'raise_25',
        label: 'Raise +$25',
        url: link('raise', scope, { kind, amount: '25000000' }),
      },
      {
        id: 'raise_50',
        label: 'Raise +$50',
        url: link('raise', scope, { kind, amount: '50000000' }),
      },
      {
        id: 'raise_custom',
        label: 'Raise…',
        url: link('raise', scope, { kind, amount: 'custom', max: o.maxCustomMicros.toString() }),
      },
    ];
  };

  const base = {
    id: alertId,
    type: job.type,
    orgId: job.orgId,
    occurredAt: now.toISOString(),
    data: job as Record<string, unknown>,
  };
  const scope = String(job.scope ?? 'org');
  switch (job.type) {
    case 'threshold': {
      const kill = killTargetFor(scope, job.keyId);
      const what = job.mark === 'soft' ? 'Soft limit reached' : `Spend at ${job.mark}% of cap`;
      return {
        ...base,
        title: `${what}: ${scope} (${windowName(job.window)})`,
        text: `Spending for ${scope} ${windowName(job.window)} crossed ${job.mark === 'soft' ? 'its soft limit' : `${job.mark}% of its hard cap`}.`,
        actions: [
          ...(kill ? [{ id: 'kill', label: `Kill ${kill}`, url: link('kill', kill) }] : []),
          ...raise(scope, job.window),
          { id: 'mute', label: 'Mute 24 h', url: link('mute', scope) },
        ],
      };
    }
    case 'blocked':
      return {
        ...base,
        title: `Request blocked: cap reached for ${scope} (${windowName(job.window)})`,
        text: `A request needing up to ${usd(job.worstMicros)} was refused because ${scope} reached its hard cap ${windowName(job.window)}.`,
        actions: [...raise(scope, job.window), ...view('/#/caps')],
      };
    case 'loop':
      return {
        ...base,
        title: `Loop detected on key ${String(job.keyId)}`,
        text: `Repeated identical requests tripped the circuit for key ${String(job.keyId)}${job.session ? ` (session ${String(job.session)})` : ''}; it is paused for the cool-down.`,
        actions: [
          { id: 'kill', label: 'Kill key', url: link('kill', `key:${String(job.keyId)}`) },
          { id: 'reset', label: 'Reset circuit', url: link('reset', String(job.keyId)) },
        ],
      };
    case 'catalog_underpriced':
      return {
        ...base,
        title: `Catalog underpriced: ${String(job.route)}`,
        text: `A ${String(job.route)} request cost ${usd(job.costMicros)} but only ${usd(job.worstMicros)} was reserved. The price catalog needs a fix.`,
        actions: view('/#/events'),
      };
    case 'upstream_key_error':
      return {
        ...base,
        title: `${String(job.provider)} rejected the API key (${String(job.status)})`,
        text: `The provider refused the stored credential. Check that the key is valid and allows the APIs you call.`,
        actions: view('/#/keys'),
      };
    case 'reservations_expired':
      return {
        ...base,
        title: `${String(job.committed)} requests were never settled`,
        text: 'Their reservations were committed at worst case after 120 s. A proxy instance probably stopped mid-request.',
        actions: view('/#/events'),
      };
    case 'reconcile_drift': {
      const ratio = typeof job.ratio === 'number' ? Math.round(job.ratio * 1000) / 10 : null;
      return {
        ...base,
        title: `Spend differs from Google's bill by ${ratio ?? '?'}% on ${String(job.day)}`,
        text: `The proxy recorded ${usd(job.ledgerMicros)} and the billing export shows ${usd(job.billedMicros)} for ${String(job.day)} (Pacific time). Check for traffic that bypasses the proxy or a catalog price that changed.`,
        actions: view('/#/spend'),
      };
    }
    case 'catalog_price_change': {
      const changes = Array.isArray(job.changes) ? (job.changes as PriceChange[]) : [];
      const lines = changes
        .slice(0, 10)
        .map((c) => `${c.sku}: ${c.from ?? 'none'} -> ${c.to ?? 'none'}`);
      if (changes.length > 10) lines.push(`and ${changes.length - 10} more`);
      return {
        ...base,
        title: `Catalog update ${String(job.version)} changed ${changes.length} prices`,
        text: `The verified catalog feed installed new prices. ${lines.join('; ')}.`,
        actions: view('/#/spend'),
      };
    }
    case 'license_issued':
      return {
        ...base,
        title: `Your Spend Brake ${String(job.edition)} license`,
        text: `The license for org ${String(job.orgId)} is attached (valid until ${String(job.expiresAt).slice(0, 10)}). Install it with: brake license install ${String(job.orgId)}.license. It is also in the dashboard under Billing.`,
        actions: view('/#/billing'),
      };
    case 'login_link':
      return { ...base, data: {}, ...loginMessage(job) };
    case 'catalog_drift':
      return {
        ...base,
        title: 'Price catalog source changed',
        text: `The pricing tables at ${String(job.url)} changed. Re-verify the catalog prices.`,
        actions: [{ id: 'view', label: 'View source', url: String(job.url) }],
      };
  }
}

/** Sign-in and invite emails: one link per org the address may sign in to. */
function loginMessage(job: AlertJob): Pick<Message, 'title' | 'text' | 'actions'> {
  const links = (Array.isArray(job.links) ? job.links : []) as {
    orgName: string;
    url: string;
  }[];
  const actions = links.map((l, i) => ({
    id: `sign_in_${i}`,
    label: links.length > 1 ? `Sign in to ${l.orgName}` : 'Sign in',
    url: l.url,
  }));
  const org = links[0]?.orgName ?? 'Spend Brake';
  switch (job.purpose) {
    case 'invite':
      return {
        title: `You're invited to ${org} on Spend Brake`,
        text: `You were added to ${org} on Spend Brake, which caps what your apps and agents spend on paid APIs. Open the link to sign in.`,
        actions,
      };
    case 'welcome':
      return {
        title: 'Welcome to Spend Brake',
        text: `Your org ${org} is ready. Open the link to sign in and connect your first API.`,
        actions,
      };
    default:
      return {
        title: 'Your Spend Brake sign-in link',
        text:
          links.length > 1
            ? 'This address belongs to more than one org. Pick the one to sign in to.'
            : `Open the link to sign in to ${org}.`,
        actions,
      };
  }
}
