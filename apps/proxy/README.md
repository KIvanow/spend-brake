# @spend-brake/proxy

The request path. Every proxied call goes through these steps:

1. **Authenticate**: virtual key from `X-Brake-Key`, or in place of the provider key
   (`?key=sb_live_…` or `X-Goog-Api-Key: sb_live_…`). Key and org config are cached for 5 s;
   if Valkey is down, a cached copy up to 10 min old is used for fail-open keys only.
2. **Classify and price** with the provider adapter (`@spend-brake/catalog`). Volume bands use
   the org's monthly unit counters (cached 5 s; counts only grow, so a stale count is never
   cheaper).
3. **Loop check and reserve** in one Lua call: kill set, loop circuit, identical-request and
   per-minute counters, then the worst case against every cap scope.
4. **Forward** to the adapter's fixed upstream origin with the real key injected and every
   `X-Brake-*` header, client credential and cookie removed.
5. **Settle** from the response in the background: commit the actual cost, count billed units and
   append the usage event in one Lua call. If that fails, the sweeper commits the reservation at
   its worst case.

## Behaviour worth knowing

- **Sessions** (`X-Brake-Session`) are only accepted on keys with a session budget
  (`sessionCapMicros`); their counters expire after two days.
- **Loop rule:** more than `identical` identical requests in the window trips the key's circuit;
  the per-minute rule applies only to sessions.
- **trustFreeTier:** the reservation is always the list price; the free allowance is applied
  only to the actual cost, from fresh (uncached) unit counts. Units are counted for every billed
  request, including free ones, so the allowance runs out when it should.
- **Request bodies** are parsed as JSON whatever the content type says; a body-priced route whose
  body cannot be read (a matrix of unknown size) is unpriced and denied.
- **Fail-open** spend is kept in a local journal and recorded in Valkey (spend, units, usage
  event) as soon as it answers again.

## Routes

| Prefix           | Upstream                        |
| ---------------- | ------------------------------- |
| `/google-maps`   | `https://maps.googleapis.com`   |
| `/google-places` | `https://places.googleapis.com` |
| `/google-routes` | `https://routes.googleapis.com` |

Generic providers add their own prefix (`BRAKE_GENERIC_PROVIDERS`).

## Responses

Every response carries `X-Brake-Request-Id` and `X-Brake-Cost-Micros`. Requests that were
reserved also carry `X-Brake-Remaining-Micros` (smallest headroom left across the request's capped
scopes); it is omitted when nothing is capped. Fail-open requests add `X-Brake-Fail-Open: 1`.

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

Every error body has a one-line `message` an agent can act on. A 402 `budget_exceeded` also
carries `X-Brake-Remaining-Micros` (headroom left in the denying scope).

Metrics (`:9465/metrics`): `brake_requests_total{provider,sku,outcome}`,
`brake_cost_micros_total`, `brake_reserve_latency_ms`, `brake_upstream_latency_ms`,
`brake_fail_open_replayed_total`.

## Configuration (env)

| Variable                   | Default                   |                                             |
| -------------------------- | ------------------------- | ------------------------------------------- |
| `PORT`, `HOST`             | `8080`, `0.0.0.0`         |                                             |
| `VALKEY_URL`               | `redis://localhost:16379` |                                             |
| `UPSTREAM_TIMEOUT_MS`      | `30000`                   |                                             |
| `TRUST_PROXY`              | `false`                   | Use `X-Forwarded-For` for IP allow-lists    |
| `BRAKE_DEV_SECRETS`        |                           | Dev only: `{"<credentialId>": "<secret>"}`  |
| `BRAKE_UPSTREAM_OVERRIDES` |                           | Dev/test only: `{"<origin>": "<base url>"}` |
| `BRAKE_GENERIC_PROVIDERS`  |                           | JSON array of generic adapter configs       |

Provider credentials come from `BRAKE_DEV_SECRETS` until Phase 4 adds encrypted storage. Keys and
orgs are created with `pnpm --filter @spend-brake/proxy seed` until the admin API exists.

## Load test

```sh
pnpm infra:up && pnpm build
PORT=9090 pnpm --filter @spend-brake/proxy bench:upstream &      # fast mock Google
BRAKE_DEV_SECRETS='{"cred-google":"x"}' \
BRAKE_UPSTREAM_OVERRIDES='{"https://maps.googleapis.com":"http://127.0.0.1:9090"}' \
LOG_LEVEL=warn pnpm --filter @spend-brake/proxy start &
KEY=$(pnpm --silent --filter @spend-brake/proxy seed -- --org bench --key bench --no-loop)
docker run --rm --network host -v "$PWD/infra/k6:/scripts:ro" -e BRAKE_KEY=$KEY \
  grafana/k6:1.0.0 run /scripts/proxy.js
```

The script runs 2,000 rps straight at the mock, then 2,000 rps through the proxy; added latency is
the difference.

Last run (2026-10-29, one proxy process, Valkey 8 in Docker, everything including k6 on one
16-core dev machine, warm runs):

|                             | p50     | p95     | p99          |
| --------------------------- | ------- | ------- | ------------ |
| Direct to mock              | 0.10 ms | 0.20 ms | 0.34–0.45 ms |
| Through the proxy           | 0.49 ms | 1.4 ms  | 8.9–9.5 ms   |
| Reserve call alone (Valkey) | 0.20 ms |         | 0.64 ms      |

0 errors over 120,000 requests. **The p99 target (< 5 ms added) is not met on this machine yet.**
The proxy process runs at about 60% of one core at 2,000 rps; the median overhead is under
0.5 ms, and the tail comes from Node scheduling under that load rather than from Valkey.
