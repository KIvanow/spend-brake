# @spend-brake/catalog

Turns a proxied request into SKUs and a price in integer micro-dollars. Code lives in adapters;
prices live in data files that cite their source and verification date.

## Data

| File                                  | Source                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `data/google-maps/catalog.yaml`       | https://developers.google.com/maps/billing-and-pricing/pricing (updated 2026-10-28) |
| `data/google-maps/places-fields.yaml` | https://developers.google.com/maps/documentation/places/web-service/data-fields     |

Both were verified on 2026-10-29. Prices are copied as USD per 1,000 events, exactly as on the
page, with Google's SKU ID next to each. A SKU whose price is not verified has `per1000: null`;
routes that bill it are unpriced and the proxy denies them by default.

## Google Maps routes

| Proxy prefix     | Upstream                        | Endpoints                                                                     |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `/google-places` | `https://places.googleapis.com` | Text Search, Nearby Search, Place Details, Place Photos, Autocomplete (New)   |
| `/google-routes` | `https://routes.googleapis.com` | `computeRoutes`, `computeRouteMatrix`                                         |
| `/google-maps`   | `https://maps.googleapis.com`   | Geocoding (forward and reverse); Places, Directions, Distance Matrix (Legacy) |

Pricing rules, all built to never undercharge:

- **Places (New):** the highest tier of any field in the field mask. `*`, unknown fields and a
  missing mask price at Enterprise + Atmosphere. A Place Details call with a `sessionToken` and
  any Pro-or-higher field prices at Enterprise + Atmosphere, as Google bills the call that closes
  an Autocomplete session.
- **Photos:** Google answers with a 302 redirect to the image and bills it, so a 3xx counts as
  billed on the two photo routes.
- **Autocomplete (New):** per request; session pricing can only lower it.
- **Routes:** Essentials, Pro or Enterprise from the features in the body (traffic, waypoints,
  location modifiers, tolls, two-wheeler). Any field we do not recognise prices as Enterprise.
  `extraComputations` values that are not SKU triggers (fuel consumption, HTML instructions,
  flyover and narrow-road info) stay at the current tier. The matrix bills origins × destinations
  elements; it only settles higher if the response holds more elements than that.
- **Legacy Places:** base SKU plus Contact and Atmosphere data SKUs from `fields`. Text and Nearby
  Search take no field list, so both data SKUs always apply. Autocomplete with a session token
  prices at the per-session SKU.
- **Billing:** only 2xx responses are billed. Legacy APIs answering `REQUEST_DENIED`,
  `INVALID_REQUEST`, `OVER_QUERY_LIMIT` or `OVER_DAILY_LIMIT` are not billed; other statuses
  (`ZERO_RESULTS`, `NOT_FOUND`, ...) are.
- **Free allowances** are ignored unless `trustFreeTier` is set. The volume band comes from the
  proxy's own monthly unit counter, which can only see less traffic than Google, so the band is
  never cheaper than the real one.

## Differences from the design doc

- `ProviderAdapter` also carries `upstreams` (the SSRF allow-list of origins, each behind a proxy
  prefix) and `timeoutBilled`. `match()` checks the upstream origin the prefix resolved to.
- `classify()` returns `{ priced: false, reason }` for routes the catalog cannot price, so the
  proxy can answer `402 unpriced_route`; `worstCase`/`actual` only take priced requests.
- One request can bill several SKUs (`items`), as legacy Places data SKUs do.
- `billedOnStatus(status, classified?)` is route-aware: photo endpoints bill their 302 redirect.
- Prices keep Google's own unit (USD per 1,000 events, as strings) with volume bands shared per
  file; `source` and `verifiedAt` are recorded per file, with Google's SKU ID on every price.

## Generic adapter

For any API without a dedicated adapter: an origin, an auth method (header or query parameter) and
routes with a flat price per request.

```ts
new GenericAdapter({
  id: 'acme',
  prefix: '/acme',
  origin: 'https://api.acme.example',
  auth: { type: 'header', name: 'Authorization', valuePrefix: 'Bearer ' },
  routes: [{ method: 'POST', path: '/v1/search', sku: 'search', pricePerRequest: '0.005' }],
});
```
