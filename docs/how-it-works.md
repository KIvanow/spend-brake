---
title: How it works
nav_order: 4
description: What happens to a request on its way through the proxy, and every status it can return.
---

# How it works

```
app / agent ──▶ proxy ──▶ provider
                 │  1 authenticate the virtual key (cached 5 s)
                 │  2 price: SKU from path + field mask, worst case in micro-dollars
                 │  3 one Lua call: kill switch, loop breaker, reserve against every cap
                 │  4 forward with the real key (decrypted locally, never logged)
                 │  5 settle the actual cost + usage event (one Lua call, background)
                 ▼
               Valkey ──▶ worker ──▶ Postgres ledger, alerts ──▶ notifier ──▶ webhooks / email
```

1. **Authenticate.** The virtual key comes from `X-Brake-Key`, or in place of the provider's
   key (`?key=sb_live_…`, `X-Goog-Api-Key: sb_live_…` and so on). Key and org config are cached
   for 5 seconds.
2. **Price.** The provider adapter works out the SKU from the path, the field mask and the body,
   and the worst-case cost in micro-dollars, from price files that cite their source.
3. **Reserve.** One Lua call on Valkey checks the kill switch and the loop breaker, then
   reserves the worst case against every cap that applies: org, key, SKU, environment, agent and
   session, per day and per month. Parallel requests cannot slip past together.
4. **Forward.** The request goes to the provider's fixed origin with the real key injected.
   Every `X-Brake-*` header, client credential and cookie is removed. Responses stream through;
   nothing is cached.
5. **Settle.** In the background, the actual cost replaces the reservation and a usage event is
   appended for the ledger. If settling fails, a sweeper commits the reservation at its worst
   case.

Overshoot is bounded by one request's worst case. If Valkey is down, the proxy fails closed
(`503`) unless a key opts into a small fail-open allowance; fail-open spend is recorded as soon
as Valkey answers again.

Twilio sends are settled later, at the price Twilio reports for the message. The difference to
the worst case shows up as an `adjustment` event.

## Caps

A cap belongs to a scope and a window. Scopes:

| Scope            | Example                     |
| ---------------- | --------------------------- |
| The whole org    | `org`                       |
| One virtual key  | `key:key_ab12`              |
| One SKU          | `sku:google-maps:geocoding` |
| An environment   | `env:production`            |
| An agent         | `agent:claude`              |
| An agent session | `sess:sess_ab12`            |

Each scope can have a hard cap per day and per month (the request is refused) and a soft limit
(alerts only). Daily windows follow the org's time zone.

## Kill switch

`brake kill <target>`, `POST /v1/kill`, a dashboard button or an alert link stops all spend for
the org (`org`), a key (`key:<id>`), a provider (`prov:<name>`) or a session (`sess:<id>`)
immediately. `unkill` lifts it.

## Messaging (Twilio)

On top of dollar caps, message sends are checked before any money moves:

- **Countries:** a key may only send to the countries in its `countries` list; without a list,
  only the US and Canada.
- **Pumping:** at most 5 sends per destination number and 50 per number prefix per hour per key.
  Going over opens the key's circuit for an hour (`429 loop_detected`, `reason: "pumping"`) and
  raises a loop alert.

## Responses

Every response carries `X-Brake-Request-Id` and `X-Brake-Cost-Micros`. Requests that were
reserved also carry `X-Brake-Remaining-Micros`: the smallest headroom left across the request's
capped scopes, omitted when nothing is capped. Fail-open requests add `X-Brake-Fail-Open: 1`.

| Status | `error`                | When                                                             |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| 401    | `invalid_key`          | Missing, unknown, revoked, expired key, or IP not allowed        |
| 402    | `budget_exceeded`      | `scope`, `window`, `cap`, `spent` (committed + held), `resetsAt` |
| 402    | `unpriced_route`       | No price and the org's policy is `deny`                          |
| 403    | `killed`               | `target` is in the kill set                                      |
| 403    | `sku_not_allowed`      | SKU or provider not allowed for the key                          |
| 429    | `loop_detected`        | Circuit open; `retryAfter` and `Retry-After`                     |
| 503    | `budget_unavailable`   | Valkey unreachable and the key is fail-closed                    |
| 400    | `invalid_request`      | Malformed `X-Brake-Session` or body too large                    |
| 404    | `unknown_route`        | No provider for the path prefix                                  |
| 502    | `upstream_unavailable` | Provider unreachable (refunded)                                  |
| 504    | `upstream_timeout`     | Provider timed out (committed at worst case)                     |

Every error body has a one-line `message` an agent can act on.

## Provider terms

Spend Brake is built to stay inside the Google Maps Platform Terms of Service:

- **Bring your own key, always.** Each org uses its own Google key and billing account; Spend
  Brake never resells access or shares a key.
- **No caching to cut billing.** Responses are streamed through, never stored to answer later
  requests. Spend Brake stores only request metadata (SKU, units, cost, status, a hash), never
  Place IDs, coordinates, bodies or query strings.
- **Usage stays visible to Google.** Every request reaches Google with your key.
- **Client-side Maps is out of scope.** The Maps JavaScript API, tiles and client widgets are not
  proxied.

This is not legal advice: have someone read sections 3.2 and 3.3 of the Maps Platform Terms and
the Service Specific Terms before you offer Spend Brake to others as a hosted service.

## The parts

| Part                                                                                  | What it does                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [apps/proxy](https://github.com/KIvanow/spend-brake/tree/main/apps/proxy)             | The request path                                                             |
| [apps/api](https://github.com/KIvanow/spend-brake/tree/main/apps/api)                 | Admin API (keys, caps, kill, credentials, spend, events, webhooks, sessions) |
| [apps/worker](https://github.com/KIvanow/spend-brake/tree/main/apps/worker)           | Ledger, sweeper, alert jobs, partitions, price drift check                   |
| [apps/notifier](https://github.com/KIvanow/spend-brake/tree/main/apps/notifier)       | Signed webhooks, email, action-link pages                                    |
| [apps/cli](https://github.com/KIvanow/spend-brake/tree/main/apps/cli)                 | `brake`: init, agent sessions, capped calls, admin                           |
| [apps/web](https://github.com/KIvanow/spend-brake/tree/main/apps/web)                 | Dashboard                                                                    |
| [packages/budget](https://github.com/KIvanow/spend-brake/tree/main/packages/budget)   | Atomic budgets on Valkey (Lua)                                               |
| [packages/catalog](https://github.com/KIvanow/spend-brake/tree/main/packages/catalog) | Prices, SKU rules, provider adapters, migration estimator                    |
| [packages/db](https://github.com/KIvanow/spend-brake/tree/main/packages/db)           | Postgres schema and migrations                                               |
| [packages/shared](https://github.com/KIvanow/spend-brake/tree/main/packages/shared)   | Envelope encryption, signing, redaction, telemetry                           |
