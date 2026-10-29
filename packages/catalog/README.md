# @spend-brake/catalog

Turns a proxied request into SKUs and a price in integer micro-dollars. Code lives in adapters;
prices live in data files that cite their source and verification date.

## Data

| File                                            | Source                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `data/google-maps/catalog.yaml`                 | https://developers.google.com/maps/billing-and-pricing/pricing (updated 2026-10-28)              |
| `data/google-maps/places-fields.yaml`           | https://developers.google.com/maps/documentation/places/web-service/data-fields                  |
| `data/mapbox/catalog.yaml`                      | https://www.mapbox.com/pricing (verified 2026-10-30)                                             |
| `data/here/catalog.yaml`                        | https://www.here.com/get-started/pricing, each service's "Pricing details" (verified 2026-10-30) |
| `data/migration/alternatives.yaml`, `payg.yaml` | Plans and SKU mappings for the migration estimator                                               |

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
  charges the per-session SKU on the token's first request and nothing after it.
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
- `needsBody(c)` says whether `actual()` needs the response body (legacy JSON statuses, matrices);
  otherwise the proxy streams the response untouched.
- `billingSession(req)` and `classify(req, { billingSessionStarted })` price provider billing
  sessions once: a legacy autocomplete session token is charged on its first request only.
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

## Twilio (Messaging and Verify)

Prefixes `/twilio` (`https://api.twilio.com`) and `/twilio-verify` (`https://verify.twilio.com`);
the credential is `<AccountSid>:<AuthToken>` (or an API key pair), injected as Basic auth.

- **SMS:** segments × the destination country's highest carrier price from Twilio's price CSV
  (`data/twilio/sms.yaml`, source and verifiedAt in the file), plus the US carrier pass-through fee
  for US numbers. Segments follow GSM-7 / UCS-2 rules (153 / 67 per concatenated segment,
  extension characters and surrogate pairs never split).
- **MMS:** per message where Twilio publishes a price (US); elsewhere unpriced and denied.
- **Verify:** $0.05 base fee per verification plus the channel's delivery fee (SMS priced as an SMS
  to that country; WhatsApp US only; email base fee only); voice is not published as data and is
  unpriced. The base fee is reserved with the verification; the check itself costs nothing more.
- Sends are billed on creation (Twilio charges undelivered messages too). The proxy commits the
  worst case and queues the message SID; the worker reads the message's final `price` from Twilio
  and adjusts spend by the difference (`TwilioAdapter.settledPrice`, carrier fees included).
- WhatsApp messaging and numbers that cannot be placed in a country are unpriced.

## Mapbox

Prefix `/mapbox` (`https://api.mapbox.com`); the token is injected as `access_token`. Prices are
tiered per month (`data/mapbox/catalog.yaml`); the free tier is ignored unless the org trusts it.

| Route                                                                             | Billed as                                                                         |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /search/geocode/v6/forward`, `/reverse`, `GET /geocoding/v5/mapbox.places/…` | Temporary geocoding; `permanent=true` (or `mapbox.places-permanent`) is permanent |
| `POST /search/geocode/v6/batch`, `mapbox.places-permanent/a;b;c.json`             | One request per query in the batch                                                |
| `/directions/v5/mapbox/{profile}/…`                                               | One request                                                                       |
| `GET /directions-matrix/v1/mapbox/{profile}/…`                                    | Sources x destinations elements                                                   |
| `GET /search/searchbox/v1/suggest`, `/retrieve/{id}`                              | Per session (below)                                                               |
| `GET /search/searchbox/v1/forward`, `/category/{id}`, `/reverse`                  | One request                                                                       |
| `GET /styles/v1/{user}/{style}/static/…`                                          | Static Images, one request                                                        |

Search Box sessions follow Mapbox's rules: the first `/suggest` with a `session_token` opens a
billed session, later `/suggest` calls in it are free, `/retrieve` closes it, and the 51st
`/suggest` or a pause of 180 s opens a new one. The page lists "introductory preview" and
"standard" Search Box prices without saying which applies; the higher (standard) ones are used.
Tiles, styles, fonts, GL and the other APIs (Isochrone, Optimization, Map Matching) are unpriced.

## HERE

Prefixes `/here-geocode`, `/here-revgeocode`, `/here-discover`, `/here-autosuggest`,
`/here-autocomplete`, `/here-router` and `/here-matrix`. The credential is an API key (sent as
`apiKey`) or `Bearer <token>` (sent as the Authorization header; HERE OAuth tokens expire after
24 hours, so a stored token has to be rotated by hand).

| Route                                                 | Billed as                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/v1/geocode`, `/v1/revgeocode`                       | Geocode and Reverse Geocode                                                                                                  |
| `/v1/discover`, `/v1/autosuggest`, `/v1/autocomplete` | Discover / Search, Autosuggest, Autocomplete                                                                                 |
| `/v8/routes` car, pedestrian, bicycle                 | Routing ($0.88) with `departureTime=any` or `traffic[mode]=disabled`, otherwise time-aware routing ($2.92), as HERE bills it |
| `/v8/routes` truck                                    | Routing Truck                                                                                                                |
| `POST /v8/matrix`                                     | Transactions: origins x destinations when either is below 5, else 5 x the larger                                             |
| `GET /v8/matrix/{id}`, `/status`                      | Free (polling an asynchronous matrix)                                                                                        |

Other transport modes, EV routing, toll costs and Lookup/Browse are unpriced until their price
lists are transcribed. HERE renders prices client-side, so the worker's price drift check cannot
watch the page; re-verify by hand.

## Migration estimator

`estimateMigration` prices the Google ledger on the OSM providers in `alternatives.yaml` (plans
and credits) and, side by side, on Mapbox and HERE through their own catalogs
(`payg.yaml` maps Google SKUs to theirs). Free allowances are not applied unless asked.
