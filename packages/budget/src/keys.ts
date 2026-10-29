// Every key for one org shares the hash tag {o:<orgId>} so one Lua script can touch them all,
// including on Valkey Cluster.

const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE_PART = /^[A-Za-z0-9_.-]{1,128}$/;

export type Scope =
  | { kind: 'org' }
  | { kind: 'key'; id: string }
  | { kind: 'sku'; provider: string; sku: string }
  | { kind: 'env'; name: string }
  | { kind: 'sess'; id: string }
  | { kind: 'agent'; id: string };

export type KillTarget =
  | { kind: 'org' }
  | { kind: 'key'; id: string }
  | { kind: 'prov'; name: string }
  | { kind: 'sess'; id: string };

export type WindowKind = 'd' | 'm';

function part(value: string, what: string): string {
  if (!SCOPE_PART.test(value)) throw new Error(`invalid ${what}: ${JSON.stringify(value)}`);
  return value;
}

export function assertOrgId(orgId: string): string {
  if (!ORG_ID.test(orgId)) throw new Error(`invalid orgId: ${JSON.stringify(orgId)}`);
  return orgId;
}

export function scopeLabel(scope: Scope): string {
  switch (scope.kind) {
    case 'org':
      return 'org';
    case 'key':
      return `key:${part(scope.id, 'key id')}`;
    case 'sku':
      return `sku:${part(scope.provider, 'provider')}:${part(scope.sku, 'sku')}`;
    case 'env':
      return `env:${part(scope.name, 'env name')}`;
    case 'sess':
      return `sess:${part(scope.id, 'session id')}`;
    case 'agent':
      return `agent:${part(scope.id, 'agent id')}`;
  }
}

export function killLabel(target: KillTarget): string {
  switch (target.kind) {
    case 'org':
      return 'org';
    case 'key':
      return `key:${part(target.id, 'key id')}`;
    case 'prov':
      return `prov:${part(target.name, 'provider')}`;
    case 'sess':
      return `sess:${part(target.id, 'session id')}`;
  }
}

export function keys(orgId: string) {
  const p = `bk:{o:${assertOrgId(orgId)}}`;
  return {
    spent: (scope: string, window: string) => `${p}:spent:${scope}:${window}`,
    held: (scope: string, window: string) => `${p}:held:${scope}:${window}`,
    /** Caps are per window kind (day or month), not per window instance. */
    cap: (scope: string, kind: WindowKind) => `${p}:cap:${scope}:${kind}`,
    /** Hash of alert marks (50, 80, 100, soft) already fired for a scope in a window. */
    alerted: (scope: string, window: string) => `${p}:alerted:${scope}:${window}`,
    res: (reqId: string) => `${p}:res:${reqId}`,
    /** Open while a key's loop circuit is tripped. */
    circuit: (keyId: string) => `${p}:circuit:key:${part(keyId, 'key id')}`,
    /** Identical-request counter for one key. */
    loop: (keyId: string, hash: string) =>
      `${p}:loop:${part(keyId, 'key id')}:${part(hash, 'hash')}`,
    /** Requests per minute for a key or session scope label. */
    rate: (scope: string) => `${p}:rate:${scope}`,
    /** Units of one SKU billed in a month window, for volume bands and free allowances. */
    units: (sku: string, window: string) => `${p}:units:${part(sku, 'sku')}:${window}`,
    /** Marks a provider billing session (e.g. an autocomplete session token) as started. */
    billingSession: (provider: string, tokenHash: string) =>
      `${p}:bsess:${part(provider, 'provider')}:${part(tokenHash, 'hash')}`,
    events: () => `${p}:events`,
    resexp: () => `${p}:resexp`,
    kill: () => `${p}:kill`,
  };
}
