import { type Db, and, asc, auditLog, eq, gt, gte, lt, sql } from '@spend-brake/db';

/**
 * Rows written by transactions older than every transaction still running. audit_log ids come
 * from a sequence, so a slow transaction can commit a lower id after a higher one is visible;
 * reading only these rows means a cursor past them never skips one. (32-bit xid arithmetic,
 * modulo wraparound.)
 */
const SETTLED = sql`((pg_snapshot_xmin(pg_current_snapshot())::text::bigint - ${auditLog}.xmin::text::bigint) % 4294967296 + 4294967296) % 4294967296 between 1 and 2147483647`;

export interface AuditRecord {
  id: string;
  orgId: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  reason: string | null;
  data: unknown;
}

export function toRecord(row: typeof auditLog.$inferSelect): AuditRecord {
  return {
    id: row.id.toString(),
    orgId: row.orgId,
    at: row.at.toISOString(),
    actor: row.actor,
    action: row.action,
    target: row.target,
    reason: row.reason,
    data: row.data,
  };
}

/** Audit rows after `afterId` in id order, optionally for one org and a time range. */
export async function auditAfter(
  db: Db,
  afterId: bigint,
  limit: number,
  filter: { orgId?: string; from?: Date; to?: Date } = {},
): Promise<AuditRecord[]> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        gt(auditLog.id, afterId),
        SETTLED,
        filter.orgId ? eq(auditLog.orgId, filter.orgId) : undefined,
        filter.from ? gte(auditLog.at, filter.from) : undefined,
        filter.to ? lt(auditLog.at, filter.to) : undefined,
      ),
    )
    .orderBy(asc(auditLog.id))
    .limit(limit);
  return rows.map(toRecord);
}

export const jsonl = (records: AuditRecord[]) =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');
