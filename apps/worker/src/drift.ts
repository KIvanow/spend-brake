import { createHash } from 'node:crypto';
import { type Db, catalogChecks, eq } from '@spend-brake/db';

export interface DriftResult {
  url: string;
  changed: boolean;
  hash: string;
  previous: string | null;
}

/**
 * Hash only the tables on a pricing page: the prices and field tiers live there, while the rest
 * of the page (navigation, banners, "last updated") changes for unrelated reasons.
 */
export function tablesHash(html: string): string {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const text = tables
    .join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(text).digest('hex');
}

/** Compare each catalog source page with its last seen hash; the first check records a baseline. */
export async function checkSources(
  db: Db,
  urls: readonly string[],
  fetchPage: (url: string) => Promise<string>,
  now = new Date(),
): Promise<DriftResult[]> {
  const results: DriftResult[] = [];
  for (const url of urls) {
    const hash = tablesHash(await fetchPage(url));
    const [prev] = await db.select().from(catalogChecks).where(eq(catalogChecks.url, url)).limit(1);
    const changed = prev !== undefined && prev.hash !== hash;
    await db
      .insert(catalogChecks)
      .values({ url, hash, checkedAt: now, changedAt: changed ? now : null })
      .onConflictDoUpdate({
        target: catalogChecks.url,
        set: { hash, checkedAt: now, ...(changed ? { changedAt: now } : {}) },
      });
    results.push({ url, changed, hash, previous: prev?.hash ?? null });
  }
  return results;
}

/** Open a GitHub issue for a changed source page (optional; needs a token with issues:write). */
export async function openDriftIssue(
  repo: string,
  token: string,
  r: DriftResult,
  post: typeof fetch = fetch,
): Promise<void> {
  const res = await post(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: `Catalog source changed: ${r.url}`,
      body: `The pricing tables at ${r.url} changed (hash ${r.previous?.slice(0, 12)} -> ${r.hash.slice(0, 12)}).\n\nRe-verify the catalog data against the page and update verifiedAt.`,
      labels: ['catalog'],
    }),
  });
  if (!res.ok) throw new Error(`GitHub issue failed: ${res.status}`);
}
