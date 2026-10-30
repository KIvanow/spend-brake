import { type Db, eq } from '@spend-brake/db';
import { eeExportCursors } from '../schema.js';
import { auditAfter } from './rows.js';
import type { AuditSink } from './sinks.js';

const BATCH = 1_000;
const MAX_BATCHES = 20;

/**
 * Send new audit records (every org on the install) to each sink. Each sink keeps its own
 * cursor, advanced only after a batch was written, so a failing sink retries and never holds up
 * the others. Delivery is at least once: consumers dedupe on `id`.
 */
export async function exportAudit(
  db: Db,
  sinks: AuditSink[],
  now: () => Date,
  log?: { warn(obj: object, msg: string): void },
): Promise<Record<string, number>> {
  const sent: Record<string, number> = {};
  for (const sink of sinks) {
    sent[sink.name] = 0;
    const [cursor] = await db
      .select()
      .from(eeExportCursors)
      .where(eq(eeExportCursors.sink, sink.name))
      .limit(1);
    let after = cursor?.lastId ?? 0n;
    try {
      for (let i = 0; i < MAX_BATCHES; i++) {
        const records = await auditAfter(db, after, BATCH);
        if (records.length === 0) break;
        await sink.write(records);
        after = BigInt(records.at(-1)!.id);
        const row = { sink: sink.name, lastId: after, updatedAt: now() };
        await db
          .insert(eeExportCursors)
          .values(row)
          .onConflictDoUpdate({ target: eeExportCursors.sink, set: row });
        sent[sink.name]! += records.length;
        if (records.length < BATCH) break;
      }
    } catch (err) {
      log?.warn({ sink: sink.name, err: (err as Error).message }, 'audit export failed');
    }
  }
  return sent;
}
