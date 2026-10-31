---
title: Custom APIs
nav_order: 8
description: Put a hard cap on any paid API without a built-in adapter, priced per request or at the cost it reports.
---

# Custom APIs

Spend Brake has built-in prices for the providers it knows. For any other paid API, add it as a
custom API: you say where it is, how its key is sent and what each route costs, and the proxy
budgets it like a built-in provider. Calls are reserved against your caps before they leave,
refused with `402` once a cap would be crossed, and show up in spend, events, alerts and
telemetry under the custom API's id.

**The prices are the ones you enter.** Spend Brake cannot check them against the API's real
bill, so a cap is only as accurate as the prices behind it. Use the API's published price list,
and round up when unsure.

Custom APIs belong to one org. On the hosted service each plan allows a number of them (Free 1,
Indie 3, Team 10, Agents 25); a self-hosted install has no limit. Moving to a smaller plan keeps
the ones you have and stops new ones.

## Add one

In the dashboard, open **Custom APIs** and click **Add**. Or send the definition to the API
(`POST /v1/custom-apis`, admin) or the CLI (`brake custom-apis add acme.json`):

```json
{
  "id": "acme",
  "name": "Acme Search",
  "origin": "https://api.acme.example",
  "auth": { "type": "header", "name": "Authorization", "valuePrefix": "Bearer " },
  "routes": [
    {
      "method": "POST",
      "path": "/v1/search",
      "sku": "search",
      "pricing": { "model": "perRequest", "usd": "0.005" }
    },
    {
      "method": "POST",
      "path": "/v1/agents/*/run",
      "sku": "agent_run",
      "pricing": {
        "model": "reported",
        "header": "X-Credits-Used",
        "usdPerUnit": "0.001",
        "maxPerRequest": "0.50"
      }
    }
  ],
  "billed": "2xx",
  "timeoutBilled": true
}
```

| Field           | What                                                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | Letters, digits, `.`, `_`, `-`. Unique in your org, never changes, and is the provider id everywhere else (provider keys, caps like `sku:acme:search`, `prov:acme` kills, events). Built-in provider ids are taken.  |
| `name`          | What the dashboard calls it.                                                                                                                                                                                         |
| `origin`        | `https://` and a host (and port), nothing else: no path, no user name or password.                                                                                                                                   |
| `auth`          | Where the proxy puts the API's key: `{ "type": "header", "name": "X-Api-Key", "valuePrefix": "" }` or `{ "type": "query", "name": "api_key" }`.                                                                      |
| `routes`        | Up to 100. `method` (or `*` for any), `path` (a glob: `*` is one segment, `**` any number), `sku` (a name for the endpoint) and `pricing`. The first match wins. Routes that share a SKU must price it the same way. |
| `billed`        | `2xx` (default): only successful answers cost money. `all`: every answer does.                                                                                                                                       |
| `timeoutBilled` | Whether a call that timed out is charged (default `true`, at the route's worst case): the API may have done the work.                                                                                                |

A request that matches no route is refused (`402 unpriced_route`) unless your org allows
unpriced routes at a default price.

Then add the API's key under **Keys → Provider keys** (pick the custom API as the provider; it
is stored encrypted, and not checked against the API, since Spend Brake does not know a free
endpoint to try it on), and create a Spend Brake key that can call it.

## Call it

Send requests to the proxy at `/custom/<id>/` plus the API's own path, with your Spend Brake key
in `X-Brake-Key`:

```sh
curl https://proxy.spendbrake.dev/custom/acme/v1/search \
  -H "X-Brake-Key: sb_live_…" \
  -H "Content-Type: application/json" \
  -d '{"q": "brakes"}'
```

The proxy adds the real key where `auth` says and forwards the request to
`https://api.acme.example/v1/search`. On a self-hosted install, use your own proxy URL. The id is
looked up in your org, so another org's `acme` is a different API.

## Pricing

Each route uses one of two models.

### `perRequest`

A flat price per call, in USD with up to 6 decimals: `{ "model": "perRequest", "usd": "0.005" }`.
The proxy reserves it before the call and charges it when the answer is billed.

### `reported`

For APIs that tell you what a call cost, in a response header or in the JSON body:

```text
{ "model": "reported", "header": "X-Credits-Used", "usdPerUnit": "0.001", "maxPerRequest": "0.50" }
{ "model": "reported", "jsonPath": "usage.cost_usd", "usdPerUnit": "1", "maxPerRequest": "0.25" }
```

- `header` or `jsonPath` (one of them): where the cost is. `jsonPath` is a dot path into the
  top-level JSON object of the response (`usage.cost_usd`); it is read only when the response is
  JSON and no bigger than the proxy buffers.
- `usdPerUnit`: what one reported unit costs in USD, up to 12 decimals. `"1"` when the API
  reports dollars; `"0.001"` when it reports credits worth a tenth of a cent.
- `maxPerRequest`: the most one call may cost. It is reserved against your caps before the call,
  so a cap with less than this left refuses the call.

After the answer, the call settles like this:

| The response                     | Charged                    | Flag on the event           |
| -------------------------------- | -------------------------- | --------------------------- |
| Reports a cost up to the maximum | The reported cost          | none                        |
| Reports a cost above the maximum | The reported cost, in full | `costNote: over_max`        |
| Reports no readable cost         | `maxPerRequest`            | `costNote: cost_unreported` |
| Is not billed (see `billed`)     | Nothing                    | none                        |

A cost above the maximum is charged in full because it was spent; it can take a cap past its
limit by the difference, once. The flag (also logged by the proxy) tells you to raise
`maxPerRequest`. A missing or unreadable cost (no header, no field, not a number, a non-JSON
answer) is charged at the maximum, so a cap never undercounts. Reported costs are rounded up to
the micro-dollar.

## Limits

- Origins must be `https://`. The proxy refuses to connect to private, loopback and link-local
  addresses (also when a hostname resolves to one), and the API refuses origins on Spend Brake's
  own domains.
- Responses are passed on up to 10 MB. A longer one is cut, and the call is recorded with the
  error `response_too_large` (it is still charged: the API answered).
- Per-key loop detection, caps, kill switches and session budgets apply as for built-in
  providers.

On a self-hosted install, `ALLOW_PRIVATE_CUSTOM_APIS=true` (on the API and the proxy) lets custom
APIs reach private addresses, and `BRAKE_CUSTOM_API_MAX_RESPONSE_BYTES` on the proxy changes the
size limit; see [Configuration](../configuration/). An operator can also define APIs for every org
with `BRAKE_GENERIC_PROVIDERS`, which takes the same routes and pricing
([Generic providers](../configuration/#generic-providers)).

## Change or delete one

Edit it in the dashboard, `PUT /v1/custom-apis/<id>` or `brake custom-apis update acme acme.json`.
The proxy picks up a change within a few seconds. Deleting one also deletes its provider keys,
and is refused (`409 custom_api_in_use`) while a Spend Brake key can call it: remove it from
those keys first, or revoke them.
