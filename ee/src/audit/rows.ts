import { type Db, and, asc, auditLog, eq, gt, gte, lt } from '@spend-brake/db';

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
