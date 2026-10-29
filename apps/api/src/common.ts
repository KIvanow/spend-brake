import type { BudgetEngine, Registry } from '@spend-brake/budget';
import { type KillTarget, MAX_MICROS, type Scope, type ValkeyClient } from '@spend-brake/budget';
import { type Db, auditLog } from '@spend-brake/db';
import type { KeyWrapper } from '@spend-brake/shared';
import { z } from 'zod';
import type { Auth } from './auth.js';
import { ApiError } from './route.js';

export interface Ctx {
  db: Db;
  valkey: ValkeyClient;
  engine: BudgetEngine;
  registry: Registry;
  wrapper: KeyWrapper | null;
  now: () => Date;
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

/** JSON-safe micros: bigint -> number (all values are below 2^53). */
export const n = (v: bigint | null | undefined) =>
  v === null || v === undefined ? null : Number(v);
