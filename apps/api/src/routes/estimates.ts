import {
  estimateMigration,
  loadAlternatives,
  loadHereCatalog,
  loadMapboxCatalog,
  loadPayAsYouGo,
} from '@spend-brake/catalog';
import { and, eq, gte, sql, usageEvents } from '@spend-brake/db';
import { z } from 'zod';
import type { Ctx } from '../common.js';
import type { Router } from '../route.js';
import { orgTimeZone } from './budget.js';

const alternatives = loadAlternatives();
const payg = {
  providers: loadPayAsYouGo(),
  catalogs: new Map([
    ['mapbox', loadMapboxCatalog()],
    ['here', loadHereCatalog()],
  ]),
};

export function estimateRoutes(r: Router, ctx: Ctx): void {
  r.add({
    method: 'post',
    path: '/v1/estimates/migration',
    role: 'viewer',
    tag: 'Spend',
    summary:
      'Price the last N days of Google Maps usage on Geoapify, Stadia Maps, Open Places API, Mapbox and HERE',
    body: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    response: z.object({}).passthrough(),
    handler: async ({ auth, body }) => {
      const tz = await orgTimeZone(ctx, auth.orgId);
      const since = new Date(ctx.now().getTime() - body.days * 86_400_000);
      const day = sql<string>`to_char(${usageEvents.ts} at time zone ${sql.raw(`'${tz.replace(/'/g, "''")}'`)}, 'YYYY-MM-DD')`;
      // Billed requests only: what Google charged for (2xx, and photo redirects).
      const rows = await ctx.db
        .select({
          sku: usageEvents.sku,
          day,
          requests: sql<string>`count(*)::text`,
          // Units of the primary SKU (matrix elements, etc.); 1 per request when not recorded.
          units: sql<string>`sum(coalesce(nullif(split_part(${usageEvents.data}->>'units', ',', 1), '')::bigint, 1))::text`,
          cost: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)::text`,
        })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.orgId, auth.orgId),
            eq(usageEvents.type, 'usage'),
            eq(usageEvents.provider, 'google-maps'),
            gte(usageEvents.ts, since),
            sql`${usageEvents.status} between 200 and 399`,
            sql`${usageEvents.sku} is not null`,
          ),
        )
        .groupBy(sql`1, 2`);
      return estimateMigration(
        rows.map((x) => ({
          sku: x.sku!,
          day: x.day,
          requests: Number(x.requests),
          units: Number(x.units),
          costMicros: BigInt(x.cost),
        })),
        alternatives,
        body.days,
        payg,
      );
    },
  });
}
