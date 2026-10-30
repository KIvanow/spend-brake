import { type Catalog, bundledDataFiles, parseCatalog, readDataFile } from './catalog.js';
import { GoogleMapsAdapter, loadPlacesFields } from './google-maps/adapter.js';
import { HereAdapter } from './here/adapter.js';
import { MapboxAdapter } from './mapbox/adapter.js';
import { loadAlternatives, loadPayAsYouGo } from './migration.js';
import { BraveAdapter } from './search/brave.js';
import { ExaAdapter } from './search/exa.js';
import { SERPAPI_PLANS, SerpApiAdapter } from './search/serpapi.js';
import { TavilyAdapter } from './search/tavily.js';
import { TwilioAdapter, loadTwilioPrices } from './twilio/adapter.js';
import { MICROS_PER_USD } from './pricing.js';

/**
 * Load every data file the way the services do (adapters, migration estimator); throws on the
 * first one that does not. Run it inside withCatalogDir() to check an update before using it.
 */
export function loadEveryCatalog(): void {
  new GoogleMapsAdapter();
  loadPlacesFields();
  new TwilioAdapter();
  new MapboxAdapter();
  new HereAdapter();
  new TavilyAdapter();
  new ExaAdapter();
  new BraveAdapter();
  for (const plan of SERPAPI_PLANS) new SerpApiAdapter({ plan });
  loadAlternatives();
  loadPayAsYouGo();
}

const usd = (micros: bigint) => {
  const whole = micros / MICROS_PER_USD;
  const frac = (micros % MICROS_PER_USD).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

function describe(catalog: Catalog, out: Map<string, string>): void {
  for (const sku of catalog.skus.values()) {
    out.set(
      sku.id,
      sku.free ? 'free' : sku.per1000 ? `${sku.per1000.map(usd).join('/')} per 1,000` : 'unpriced',
    );
  }
}

/** Every price in the data as SKU -> human-readable price, to compare two catalog versions. */
export function priceTable(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of bundledDataFiles()) {
    if (file.endsWith('/catalog.yaml')) describe(parseCatalog(readDataFile(file)), out);
  }
  for (const [sku, micros] of loadTwilioPrices()) out.set(sku, `${usd(micros)} each`);
  return out;
}
