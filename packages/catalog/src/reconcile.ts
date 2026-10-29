import type { Catalog } from './catalog.js';
import { endpointOf } from './migration.js';

/**
 * The family a SKU is reconciled in. The ledger records each request under its primary SKU with
 * the request's total cost, while Google bills legacy Places data SKUs and Advanced tiers
 * separately; families put both sides on the same footing.
 */
export function skuFamily(sku: string): string {
  if (sku.startsWith('legacy.places.')) return 'legacy.places';
  if (sku.startsWith('legacy.directions')) return 'legacy.directions';
  if (sku.startsWith('legacy.distance_matrix')) return 'legacy.distance_matrix';
  return endpointOf(sku);
}

/** Google SKU id (billing export `sku.id`) to catalog SKU. */
export function googleSkuIndex(catalog: Catalog): Map<string, string> {
  const index = new Map<string, string>();
  for (const sku of catalog.skus.values()) if (sku.googleSku) index.set(sku.googleSku, sku.id);
  return index;
}
