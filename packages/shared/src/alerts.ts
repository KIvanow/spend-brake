// The contract between the worker (which decides alerts) and the notifier (which delivers them).

export const ALERT_QUEUE = 'alerts';
/** Hash-tagged prefix so every BullMQ key lands in one slot on Valkey Cluster. */
export const QUEUE_PREFIX = '{brake-alerts}';

export const ALERT_TYPES = [
  'threshold',
  'blocked',
  'loop',
  'catalog_underpriced',
  'upstream_key_error',
  'reservations_expired',
  'catalog_drift',
  'reconcile_drift',
  'catalog_price_change',
  'license_issued',
  // Email sign-in and invite links: emailed to that person only, never to webhooks.
  'login_link',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

/** Job data on the alerts queue. Fields beyond these depend on the type. */
export interface AlertJob {
  type: AlertType;
  /** null for operator alerts (catalog drift, catalog price changes). */
  orgId: string | null;
  scope?: string;
  window?: string;
  mark?: string;
  keyId?: string;
  session?: string;
  provider?: string;
  [field: string]: unknown;
}
