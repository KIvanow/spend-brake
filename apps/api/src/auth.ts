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
  /**
   * How the person behind the token signed in: 'sso' when an identity provider vouches for
   * them, 'email' for an email sign-in link; null for tokens not issued to a person.
   */
  signIn: 'sso' | 'email' | null;
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
      // Recorded when the token is looked up (at most once per cache period), never awaited.
      void this.db
        .update(apiTokens)
        .set({ lastUsedAt: this.now() })
        .where(eq(apiTokens.id, row.id))
        .catch(() => undefined);
      // Tokens issued to a person act as that person, whichever token it is.
      const actor = row.userId ? `user:${row.userId}` : `token:${row.id}`;
      const signIn = row.userId ? (row.signIn ?? 'sso') : null;
      return { orgId: row.orgId, tokenId: row.id, role: row.role, actor, signIn };
    });
  }

  forget(): void {
    this.cache.clear();
  }
}
