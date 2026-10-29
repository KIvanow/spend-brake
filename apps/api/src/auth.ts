import { apiTokens, type Db } from '@spend-brake/db';
import { and, eq, isNull } from '@spend-brake/db';
import type { FastifyRequest } from 'fastify';
import { TtlCacheLite } from './cache.js';
import { sha256 } from './ids.js';

export const ROLES = ['viewer', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export interface Auth {
  orgId: string;
  tokenId: string;
  role: Role;
  /** Audit actor. */
  actor: string;
}

export const atLeast = (have: Role, need: Role) => ROLES.indexOf(have) >= ROLES.indexOf(need);

const TOKEN = /^Bearer (sbt_[0-9A-Za-z]{32})$/;

export class Authenticator {
  // Short cache so a revoked token stops working within seconds.
  private readonly cache: TtlCacheLite<Auth | null>;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    cacheMs = 5_000,
  ) {
    this.cache = new TtlCacheLite(cacheMs);
  }

  async authenticate(req: FastifyRequest): Promise<Auth | null> {
    const m = TOKEN.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const hash = sha256(m[1]!);
    return this.cache.get(hash, async () => {
      const [row] = await this.db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
        .limit(1);
      if (!row) return null;
      if (row.expiresAt && row.expiresAt <= this.now()) return null;
      return { orgId: row.orgId, tokenId: row.id, role: row.role, actor: `token:${row.id}` };
    });
  }

  forget(): void {
    this.cache.clear();
  }
}
