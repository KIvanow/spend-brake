import { parse } from 'yaml';
import { z } from 'zod';

export const TIERS = [
  'ids_only',
  'essentials',
  'pro',
  'enterprise',
  'enterprise_atmosphere',
] as const;
export type Tier = (typeof TIERS)[number];
export type PlacesEndpoint = 'details' | 'textSearch' | 'nearbySearch';

const HIGHEST: Tier = 'enterprise_atmosphere';

const tier = z.enum(TIERS).nullable();
const fieldsSchema = z.strictObject({
  source: z.url(),
  sourceUpdated: z.string(),
  verifiedAt: z.string(),
  fields: z.record(
    z.string(),
    z.strictObject({ details: tier, textSearch: tier, nearbySearch: tier }),
  ),
});

export type PlacesFields = z.infer<typeof fieldsSchema>;

export function parsePlacesFields(yamlText: string): PlacesFields {
  return fieldsSchema.parse(parse(yamlText));
}

const rank = (t: Tier) => TIERS.indexOf(t);
const max = (a: Tier, b: Tier) => (rank(a) >= rank(b) ? a : b);

export interface MaskResolution {
  tier: Tier;
  /** Mask entries we could not map to a field; they price at the highest tier. */
  unknown: string[];
}

/** Lowest tier each endpoint can bill. */
const FLOOR: Record<PlacesEndpoint, Tier> = {
  details: 'ids_only',
  textSearch: 'ids_only',
  nearbySearch: 'pro',
};

/**
 * Resolve a field mask to the highest tier any of its fields triggers. Search endpoints take
 * `places.<field>` paths plus a few top-level response fields (`nextPageToken`, `routingSummaries`).
 * Wildcards, unknown fields and fields the endpoint does not offer price at the highest tier.
 */
export function resolveFieldMask(
  fields: PlacesFields,
  endpoint: PlacesEndpoint,
  mask: string | undefined,
): MaskResolution {
  const entries = (mask ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (entries.length === 0) return { tier: HIGHEST, unknown: ['<missing field mask>'] };

  let result = FLOOR[endpoint];
  const unknown: string[] = [];
  for (const entry of entries) {
    if (entry === '*' || (endpoint !== 'details' && (entry === 'places' || entry === 'places.*'))) {
      result = HIGHEST;
      continue;
    }
    let path = entry;
    if (endpoint !== 'details' && path.startsWith('places.')) path = path.slice('places.'.length);
    const name = path.split('.')[0]!;
    const t = fields.fields[name]?.[endpoint];
    if (!t) {
      unknown.push(entry);
      result = HIGHEST;
      continue;
    }
    result = max(result, t);
  }
  return { tier: result, unknown };
}
