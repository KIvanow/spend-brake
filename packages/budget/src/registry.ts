import { createHash, randomInt } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_LOOP_POLICY } from './engine.js';
import { assertOrgId } from './keys.js';
import type { ValkeyClient } from './scripts.js';

// Org and virtual-key config the proxy reads on every request (through a short local cache).
// Postgres is the source of truth from Phase 4 on; it writes through to these records.
//
// Virtual keys are looked up by hash before the org is known, so `bk:vk:<sha256>` is the one
// record outside an org hash tag. It is a single-key GET and never touched by a Lua script.

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const micros = z.string().regex(/^\d{1,16}$/);

const loopPolicy = z.strictObject({
  identical: z.number().int().positive(),
  windowSec: z.number().int().positive(),
  perMinute: z.number().int().positive(),
  cooldownSec: z.number().int().positive(),
});

export const orgRecordSchema = z.strictObject({
  id,
  /** Day and month cap windows are cut in this zone. */
  timeZone: z.string().default('UTC'),
  providers: z
    .record(
      z.string(),
      z.strictObject({
        trustFreeTier: z.boolean().default(false),
        unpricedPolicy: z.enum(['deny', 'allow-with-default-price']).default('deny'),
        /** Micros charged for an unpriced route when the policy allows it. */
        defaultPriceMicros: micros.optional(),
      }),
    )
    .default({}),
  loop: loopPolicy.default(DEFAULT_LOOP_POLICY),
});

export const keyRecordSchema = z.strictObject({
  id,
  orgId: id,
  status: z.enum(['active', 'revoked']).default('active'),
  /** ISO timestamp after which the key stops working. */
  expiresAt: z.string().datetime().nullable().default(null),
  /** Providers this key may call, each bound to a stored credential id. */
  credentials: z.record(z.string(), id),
  /** Allowed SKUs; null allows every SKU of the allowed providers. */
  skus: z.array(z.string()).nullable().default(null),
  env: id.nullable().default(null),
  agentId: id.nullable().default(null),
  /** Budget created for each new session (X-Brake-Session), in micros, for its month window. */
  sessionCapMicros: micros.nullable().default(null),
  loop: loopPolicy.nullable().default(null),
  /** When Valkey is unreachable, allow up to this many micros per day from a local counter. */
  failOpenMicros: micros.nullable().default(null),
  /** Source IPs (exact match) allowed to use the key; null allows any. */
  allowedIps: z.array(z.string()).nullable().default(null),
  canMintSessions: z.boolean().default(false),
  /**
   * Messaging: destination countries (ISO 3166 alpha-2) the key may send to. Null means the
   * default, US and CA only: every other country is denied until allowed explicitly.
   */
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .nullable()
    .default(null),
  pumping: z
    .strictObject({
      perNumberPerHour: z.number().int().positive(),
      perPrefixPerHour: z.number().int().positive(),
      cooldownSec: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  /** Session keys minted by `brake session`: every request belongs to this session. */
  sessionId: id.nullable().default(null),
  /** Daily cap created for the key's agent scope on first use (the agent's budget per day). */
  agentDayCapMicros: micros.nullable().default(null),
  /** The key that minted this session key. */
  parentKeyId: id.nullable().default(null),
});

export type OrgRecord = z.output<typeof orgRecordSchema>;
export type KeyRecord = z.output<typeof keyRecordSchema>;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const VIRTUAL_KEY = /^sb_live_[0-9A-Za-z]{22}$/;

/** `sb_live_` + 22 base62 characters (about 131 bits). Shown once; only its hash is stored. */
export function generateVirtualKey(): string {
  let s = 'sb_live_';
  for (let i = 0; i < 22; i++) s += BASE62[randomInt(62)];
  return s;
}

export function isVirtualKey(token: string): boolean {
  return VIRTUAL_KEY.test(token);
}

export function hashVirtualKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const keyLookup = (hash: string) => `bk:vk:${hash}`;
const orgRecord = (orgId: string) => `bk:{o:${assertOrgId(orgId)}}:org`;
const credentialRecord = (orgId: string, id: string) => `bk:{o:${assertOrgId(orgId)}}:cred:${id}`;

/** An encrypted provider credential as the proxy reads it (the envelope is opaque here). */
export interface CredentialRecord {
  id: string;
  orgId: string;
  provider: string;
  envelope: unknown;
}

export class Registry {
  constructor(private readonly client: ValkeyClient) {}

  async putOrg(org: z.input<typeof orgRecordSchema>): Promise<OrgRecord> {
    const parsed = orgRecordSchema.parse(org);
    await this.client.set(orgRecord(parsed.id), JSON.stringify(parsed));
    return parsed;
  }

  async getOrg(orgId: string): Promise<OrgRecord | null> {
    const raw = await this.client.get(orgRecord(orgId));
    return raw === null ? null : orgRecordSchema.parse(JSON.parse(raw));
  }

  /** Store a key under the hash of its token. Returns the token, which is never stored. */
  async createKey(
    key: z.input<typeof keyRecordSchema>,
    token = generateVirtualKey(),
  ): Promise<{ token: string; record: KeyRecord }> {
    if (!isVirtualKey(token)) throw new Error('invalid virtual key format');
    const record = keyRecordSchema.parse(key);
    await this.client.set(keyLookup(hashVirtualKey(token)), JSON.stringify(record));
    return { token, record };
  }

  async getKeyByToken(token: string): Promise<KeyRecord | null> {
    if (!isVirtualKey(token)) return null;
    const raw = await this.client.get(keyLookup(hashVirtualKey(token)));
    return raw === null ? null : keyRecordSchema.parse(JSON.parse(raw));
  }

  /** Write-through from the admin API, which only ever holds the token's hash. */
  async putKeyByHash(tokenHash: string, key: z.input<typeof keyRecordSchema>): Promise<KeyRecord> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('invalid token hash');
    const record = keyRecordSchema.parse(key);
    await this.client.set(keyLookup(tokenHash), JSON.stringify(record));
    return record;
  }

  async putCredential(c: CredentialRecord): Promise<void> {
    await this.client.set(credentialRecord(c.orgId, id.parse(c.id)), JSON.stringify(c));
  }

  async getCredential(orgId: string, credentialId: string): Promise<CredentialRecord | null> {
    const raw = await this.client.get(credentialRecord(orgId, id.parse(credentialId)));
    return raw === null ? null : (JSON.parse(raw) as CredentialRecord);
  }

  async deleteCredential(orgId: string, credentialId: string): Promise<void> {
    await this.client.del(credentialRecord(orgId, id.parse(credentialId)));
  }

  async revokeKey(token: string): Promise<void> {
    const key = await this.getKeyByToken(token);
    if (!key) return;
    await this.client.set(
      keyLookup(hashVirtualKey(token)),
      JSON.stringify({ ...key, status: 'revoked' }),
    );
  }
}
