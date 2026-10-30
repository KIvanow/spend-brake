import type { BudgetEngine, Registry } from '@spend-brake/budget';
import { type KillTarget, MAX_MICROS, type Scope, type ValkeyClient } from '@spend-brake/budget';
import { type Db, auditLog, caps } from '@spend-brake/db';
import type { KeyWrapper } from '@spend-brake/shared';
import { z } from 'zod';
import type { Auth, Role } from './auth.js';
import type { KeyCheck } from './google-check.js';
import { ApiError } from './route.js';

/** A route as the authorization hook sees it. */
export interface RouteRef {
  method: string;
  /** OpenAPI-style path, e.g. `/v1/keys/{id}`. */
  path: string;
  role: Role;
}

/** A cap about to be raised or removed (lowering and new caps apply directly). */
export interface CapRaise {
  auth: Auth;
  orgId: string;
  /** Scope label, e.g. `key:k_1`. */
  scope: string;
  kind: 'd' | 'm';
  from: { hard: bigint | null; soft: bigint | null };
  /** null `to` removes the cap. */
  to: { hard: bigint | null; soft: bigint | null } | null;
  via: 'api' | 'action_link';
}

/**
 * Extension points for builds that add features on top of the core (see buildApi's
 * `extensions`). Every hook is optional; without them the core behaves as documented.
 */
export interface ApiHooks {
  /** Allow a route the token's core role does not reach (extra roles). */
  authorize?: (auth: Auth, route: RouteRef) => Promise<boolean>;
  /** Hold a cap raise for approval: return its id, or null to apply it now. */
  holdCapRaise?: (change: CapRaise) => Promise<string | null>;
}

export interface Ctx {
  hooks: ApiHooks;
  db: Db;
  valkey: ValkeyClient;
  engine: BudgetEngine;
  registry: Registry;
  wrapper: KeyWrapper | null;
  now: () => Date;
  /** Checks a newly added Google key's restrictions; absent disables the check. */
  checkGoogleKey?: (key: string) => Promise<KeyCheck>;
}

export const id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);

/** Micro-dollars as a JSON integer or a numeric string, up to 2^53 - 1. */
export const micros = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,16}$/)])
  .transform((v) => BigInt(v))
  .refine((v) => v <= MAX_MICROS, 'Too large.')
  .openapi({ description: 'Micro-dollars (1 USD = 1,000,000)', example: 5_000_000 });

const PART = '[A-Za-z0-9_.-]{1,128}';
const SCOPE = new RegExp(
  `^(org|key:${PART}|sku:${PART}:${PART}|env:${PART}|sess:${PART}|agent:${PART})$`,
);
const KILL = new RegExp(`^(org|key:${PART}|prov:${PART}|sess:${PART})$`);

export const scopeLabel = z
  .string()
  .regex(
    SCOPE,
    'Expected org, key:<id>, sku:<provider>:<sku>, env:<name>, sess:<id> or agent:<id>.',
  );
export const killLabel = z
  .string()
  .regex(KILL, 'Expected org, key:<id>, prov:<name> or sess:<id>.');

export function toScope(label: string): Scope {
  const [kind, a, b] = label.split(':');
  switch (kind) {
    case 'org':
      return { kind: 'org' };
    case 'key':
      return { kind: 'key', id: a! };
    case 'sku':
      return { kind: 'sku', provider: a!, sku: b! };
    case 'env':
      return { kind: 'env', name: a! };
    case 'sess':
      return { kind: 'sess', id: a! };
    case 'agent':
      return { kind: 'agent', id: a! };
  }
  throw new ApiError(400, 'invalid_request', 'Unknown scope.');
}

export function toKillTarget(label: string): KillTarget {
  const [kind, a] = label.split(':');
  switch (kind) {
    case 'org':
      return { kind: 'org' };
    case 'key':
      return { kind: 'key', id: a! };
    case 'prov':
      return { kind: 'prov', name: a! };
    case 'sess':
      return { kind: 'sess', id: a! };
  }
  throw new ApiError(400, 'invalid_request', 'Unknown kill target.');
}

export async function audit(
  ctx: Ctx,
  auth: Auth,
  action: string,
  target: string | null,
  data: Record<string, unknown> = {},
  reason: string | null = null,
): Promise<void> {
  await ctx.db.insert(auditLog).values({
    orgId: auth.orgId,
    actor: auth.actor,
    action,
    target,
    reason,
    data,
    at: ctx.now(),
  });
}

/** Set a cap in Valkey (enforced on the next request), then record it in Postgres. */
export async function writeCap(
  ctx: Ctx,
  orgId: string,
  label: string,
  kind: 'd' | 'm',
  values: { hard: bigint | null; soft: bigint | null },
): Promise<number> {
  const version = await ctx.engine.setCap(orgId, toScope(label), kind, values);
  const row = {
    orgId,
    scope: label,
    kind,
    hardMicros: values.hard,
    softMicros: values.soft,
    version,
    updatedAt: ctx.now(),
  };
  await ctx.db
    .insert(caps)
    .values(row)
    .onConflictDoUpdate({ target: [caps.orgId, caps.scope, caps.kind], set: row });
  return version;
}

/** Whether a change takes a hard cap up (or away). Soft caps only alert, so they never count. */
export function raisesCap(from: bigint | null | undefined, to: bigint | null | undefined): boolean {
  if (from === null || from === undefined) return false;
  return to === null || to === undefined || to > from;
}

/** JSON-safe micros: bigint -> number (all values are below 2^53). */
export const n = (v: bigint | null | undefined) =>
  v === null || v === undefined ? null : Number(v);
