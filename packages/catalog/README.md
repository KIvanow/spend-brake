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
| `data/tavily/catalog.yaml`                      | https://docs.tavily.com/documentation/api-credits (verified 2026-10-30)                          |
| `data/exa/catalog.yaml`                         | https://exa.ai/pricing (verified 2026-10-30)                                                     |
| `data/brave/catalog.yaml`                       | https://api-dashboard.search.brave.com/app/plans (verified 2026-10-30)                           |
| `data/serpapi/catalog.yaml`                     | https://serpapi.com/pricing (verified 2026-10-30)                                                |
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

Repeated parameters take the dearer reading (`permanent=true` anywhere is permanent; a route is
basic only if every `departureTime` is `any`); conflicting `transportMode` values are unpriced.
Routes with more than 100 waypoints count 2 transactions, as HERE bills them. A `POST /v8/routes`
body may only hold `avoid` or `exclude` (HERE merges body and query); anything else is unpriced.
Other transport modes, EV routing, toll costs and Lookup/Browse are unpriced until their price
lists are transcribed. Mapbox and HERE render their price tables client-side, so the worker's
drift check cannot watch those pages; re-verify them by hand.

## Agent search (Tavily, Exa, Brave, SerpApi)

Prefixes `/tavily`, `/exa`, `/brave` and `/serpapi`. Each request reserves its worst case from
the request; where the provider reports what it billed, the response settles it.

| Provider | Priced                                                                                                                                                                                                                                                                                                        | Settles from                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Tavily   | Credits at $0.008: search 1 (basic, fast, ultra-fast) or 2 (advanced, or `auto_parameters` without a 1-credit depth); extract per URL (1 or 2 credits per 5); map per page (1 or 2 with `instructions` per 10, up to `limit`, default 50); crawl = map + extract; research at its maximum (110 mini, 250 pro) | `usage.credits` on search; returned results on extract, map and crawl extraction |
| Exa      | Search by `type` ($4 lite, $7 auto, $12 deep, $15 deep-reasoning per 1k) + $1/1k per result above 10 + $1/1k per page per content type (text, highlights, summary); `/contents` per page per type (text when none named); `/answer` $5/1k                                                                     | `costDollars.total` (streamed responses keep the worst case)                     |
| Brave    | Web, news, videos, images and LLM context $5/1k; autosuggest and spellcheck $5/10k                                                                                                                                                                                                                            | Flat per request                                                                 |
| SerpApi  | One search at the plan's price per search (`BRAKE_SERPAPI_PLAN`, Starter $25/1k by default); archive, account and locations free                                                                                                                                                                              | Flat per request                                                                 |

Denied as unpriced: Exa `findSimilar`, research/agent and unknown search types; Brave Answers
(token-priced), local POIs and summarizer; Tavily bodies carrying `api_key` (the key must go in
the Authorization header). SerpApi charges cached searches nothing and its Ludicrous Speed modes
2x/4x; the proxy cannot see either, so it charges every successful search at the plan price.
The worker's drift check watches the Tavily and Exa price pages; Brave and SerpApi render
theirs client-side, so re-verify those by hand.

Tavily and Exa have native limits of their own: Tavily's per-key monthly limit (set when the key
is created; over it Tavily answers 432/433) and Exa's per-key budget (`API_KEY_BUDGET_EXCEEDED`,
402), set by a team admin. Keep them on as a backstop under Spend Brake's caps: what Spend Brake
adds is one budget per agent session across every search provider, which no single provider can.

## Migration estimator

`estimateMigration` prices the Google ledger on the OSM providers in `alternatives.yaml` (plans
and credits) and, side by side, on Mapbox and HERE through their own catalogs
(`payg.yaml` maps Google SKUs to theirs). Free allowances are not applied unless asked.
