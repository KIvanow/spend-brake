// Providers by the names people know them by, for API errors and alert emails. The dashboard
// keeps its own, richer list (apps/web/src/providers.ts); the ids match the catalog adapters.

export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  'google-maps': 'Google Maps Platform',
  mapbox: 'Mapbox',
  here: 'HERE',
  twilio: 'Twilio',
  tavily: 'Tavily',
  exa: 'Exa',
  brave: 'Brave Search',
  serpapi: 'SerpApi',
};

/** A provider's display name, or its id when it has none. */
export const providerName = (id: string): string => PROVIDER_NAMES[id] ?? id;
