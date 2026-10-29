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
    case 'catalog_drift':
      return {
        ...base,
        title: 'Price catalog source changed',
        text: `The pricing tables at ${String(job.url)} changed. Re-verify the catalog prices.`,
        actions: [{ id: 'view', label: 'View source', url: String(job.url) }],
      };
  }
}
