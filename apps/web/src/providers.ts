import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

// What the dashboard tells people about each provider: what its key looks like, and the one
// change in their app (base URL, and the Spend Brake key where the provider's key went).
// The prefixes match the proxy's upstreams in @spend-brake/catalog.

export interface ProviderInfo {
  id: string;
  name: string;
  /** What to paste as the provider key. */
  secret: string;
  /** Provider base URL -> proxy path prefix. */
  routes: { from: string; prefix: string }[];
  /** Where the Spend Brake key goes in requests. */
  keyIn: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'google-maps',
    name: 'Google Maps Platform',
    secret: 'API key (AIza…)',
    routes: [
      { from: 'https://maps.googleapis.com', prefix: '/google-maps' },
      { from: 'https://places.googleapis.com', prefix: '/google-places' },
      { from: 'https://routes.googleapis.com', prefix: '/google-routes' },
    ],
    keyIn: 'the key= parameter or the X-Goog-Api-Key header',
  },
  {
    id: 'mapbox',
    name: 'Mapbox',
    secret: 'access token (pk.… or sk.…)',
    routes: [{ from: 'https://api.mapbox.com', prefix: '/mapbox' }],
    keyIn: 'the access_token parameter',
  },
  {
    id: 'here',
    name: 'HERE',
    secret: 'API key',
    routes: [
      { from: 'https://geocode.search.hereapi.com', prefix: '/here-geocode' },
      { from: 'https://revgeocode.search.hereapi.com', prefix: '/here-revgeocode' },
      { from: 'https://discover.search.hereapi.com', prefix: '/here-discover' },
      { from: 'https://autosuggest.search.hereapi.com', prefix: '/here-autosuggest' },
      { from: 'https://autocomplete.search.hereapi.com', prefix: '/here-autocomplete' },
      { from: 'https://router.hereapi.com', prefix: '/here-router' },
      { from: 'https://matrix.router.hereapi.com', prefix: '/here-matrix' },
    ],
    keyIn: 'the apiKey parameter (or as a bearer token)',
  },
  {
    id: 'twilio',
    name: 'Twilio (SMS, Verify)',
    secret: 'AccountSid:AuthToken (or ApiKeySid:ApiKeySecret)',
    routes: [
      { from: 'https://api.twilio.com', prefix: '/twilio' },
      { from: 'https://verify.twilio.com', prefix: '/twilio-verify' },
    ],
    keyIn: 'the X-Brake-Key header (leave out your Twilio credentials)',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    secret: 'API key (tvly-…)',
    routes: [{ from: 'https://api.tavily.com', prefix: '/tavily' }],
    keyIn: 'the Authorization: Bearer header',
  },
  {
    id: 'exa',
    name: 'Exa',
    secret: 'API key',
    routes: [{ from: 'https://api.exa.ai', prefix: '/exa' }],
    keyIn: 'the x-api-key header',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    secret: 'subscription token',
    routes: [{ from: 'https://api.search.brave.com', prefix: '/brave' }],
    keyIn: 'the X-Subscription-Token header',
  },
  {
    id: 'serpapi',
    name: 'SerpApi',
    secret: 'API key',
    routes: [{ from: 'https://serpapi.com', prefix: '/serpapi' }],
    keyIn: 'the api_key parameter',
  },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

export type CustomApiPricing =
  | { model: 'perRequest'; usd: string }
  | {
      model: 'reported';
      header?: string;
      jsonPath?: string;
      usdPerUnit: string;
      maxPerRequest: string;
    };

export interface CustomApiRoute {
  method: string;
  path: string;
  sku: string;
  pricing: CustomApiPricing;
}

/** An API the org prices itself (Custom APIs page). */
export interface CustomApi {
  id: string;
  name: string;
  origin: string;
  auth: { type: 'header'; name: string; valuePrefix: string } | { type: 'query'; name: string };
  routes: CustomApiRoute[];
  billed: '2xx' | 'all';
  timeoutBilled: boolean;
  proxyPath: string;
  createdAt: string;
  updatedAt: string;
}

/** A custom API as a provider: called at `/custom/<id>` with the key in X-Brake-Key. */
export const customApiInfo = (a: Pick<CustomApi, 'id' | 'name' | 'origin'>): ProviderInfo => ({
  id: a.id,
  name: a.name,
  secret: 'API key',
  routes: [{ from: a.origin, prefix: `/custom/${a.id}` }],
  keyIn: 'the X-Brake-Key header',
});

export const useCustomApis = () =>
  useQuery({
    queryKey: ['custom-apis'],
    queryFn: () => api<{ items: CustomApi[] }>('/v1/custom-apis'),
  });

/**
 * Look a provider up by id: built-in ones first, then the org's custom APIs (a list that fails
 * to load counts as empty).
 */
export function useProviderInfo(): (id: string) => ProviderInfo | undefined {
  const custom = useCustomApis();
  const items = custom.data?.items ?? [];
  return (id) => {
    const builtIn = providerById(id);
    if (builtIn) return builtIn;
    const c = items.find((a) => a.id === id);
    return c ? customApiInfo(c) : undefined;
  };
}
