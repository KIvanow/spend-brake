import type { Ctx, Router } from '@spend-brake/api';
import { z } from 'zod';
import { auditAfter, jsonl } from '../audit/rows.js';
import type { Entitlements } from '../entitlements.js';

const PAGE = 5_000;

export function auditRoutes(r: Router, ctx: Ctx, ent: Entitlements): void {
  r.add({
    method: 'get',
    path: '/v1/audit/export',
    role: 'admin',
    tag: 'Audit',
    summary:
      "The org's audit log as JSON Lines, oldest first; follow X-Next-Cursor for the next page",
    query: z.object({
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      cursor: z
        .string()
        .regex(/^\d{1,19}$/)
        .refine((v) => BigInt(v) <= 9_223_372_036_854_775_807n, 'Too large.')
        .optional(),
    }),
    response: z.string().openapi({ description: 'application/x-ndjson' }),
    handler: async ({ auth, query, reply }) => {
      await ent.require('audit_export', 'read');
      const records = await auditAfter(ctx.db, BigInt(query.cursor ?? '0'), PAGE, {
        orgId: auth.orgId,
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
      });
      if (records.length === PAGE) reply.header('x-next-cursor', records.at(-1)!.id);
      reply.type('application/x-ndjson');
      return jsonl(records);
    },
  });
}
