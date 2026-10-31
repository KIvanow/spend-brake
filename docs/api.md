---
title: API reference
nav_order: 11
description: The admin API for keys, caps, the kill switch, provider keys, spend, events, alerts, sessions and telemetry.
---

# API reference

Everything the dashboard does goes through the admin API, so anything you can click you can
script.

- **Hosted:** `https://app.spendbrake.dev/v1/…`
- **Self-hosted:** `https://<app domain>/v1/…` with the HTTPS overlay, or
  `http://localhost:8081/v1/…` for a local install.

The full OpenAPI 3.1 spec is served at `/v1/openapi.json` and committed as
[apps/api/openapi.json](https://github.com/KIvanow/spend-brake/blob/main/apps/api/openapi.json)
([raw](https://raw.githubusercontent.com/KIvanow/spend-brake/main/apps/api/openapi.json)). It is
generated from the same schemas the server validates with, so it cannot drift from what the
server accepts. This page is a summary.

## Authentication

```sh
curl -H "Authorization: Bearer sbt_…" https://app.spendbrake.dev/v1/caps
```

Admin API tokens start with `sbt_`. Every request is scoped to the token's org; another org's
ids answer `404`. An owner creates tokens with `POST /v1/tokens` (pick the role); the dashboard's
**Telemetry** page also creates a read-only one for Prometheus. On a self-hosted install,
`brake init` prints the owner token and saves an admin token for the CLI.

| Role     | Can                                                                                     |
| -------- | --------------------------------------------------------------------------------------- |
| `viewer` | Read keys, caps, provider keys (no secrets), spend, events, status, org                 |
| `admin`  | + create, update and revoke keys and provider keys, set caps, kill and unkill, webhooks |
| `owner`  | + admin tokens, people and org settings (time zone, provider policy, loop rule)         |

A few calls take a virtual key instead, in `X-Brake-Key`: `GET /v1/me` and minting or ending a
session with a key that has `canMintSessions`.

## Conventions

- **Money** is in micro-dollars: 1 USD = 1,000,000. Amounts are accepted as integers or digit
  strings (`"5000000"`).
- **Errors** are JSON: `{"error": "<code>", "message": "<one line>"}`, plus `issues` when the
  request did not validate.
- **Rate limits:** 600 requests per minute per token by default, and 4x that per client IP before
  authentication.
- **Writes apply at once.** Every change that affects enforcement (keys, caps, kills, provider
  keys, org settings) reaches the proxy on the next request, and is written to the audit log
  with its actor.

## Endpoints

The role after each call is the least it needs.

### Provider keys

| Call                                    | What                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/providers/credentials`        | Add an encrypted provider key (admin)                                    |
| `GET /v1/providers/credentials`         | List provider keys, no secrets (viewer)                                  |
| `DELETE /v1/providers/credentials/{id}` | Delete one; keys that use it move to another key of the provider (admin) |

### Virtual keys

| Call                        | What                                                  |
| --------------------------- | ----------------------------------------------------- |
| `POST /v1/keys`             | Create a virtual key; the token is shown once (admin) |
| `GET /v1/keys`              | List virtual keys (viewer)                            |
| `GET /v1/keys/{id}`         | Get one (viewer)                                      |
| `PATCH /v1/keys/{id}`       | Update one (admin)                                    |
| `DELETE /v1/keys/{id}`      | Revoke one (admin)                                    |
| `POST /v1/keys/{id}/resume` | Resume a key paused by the loop breaker (admin)       |

### Caps and the kill switch

| Call                      | What                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `PUT /v1/caps/{scope}`    | Set hard and soft caps for a scope, per day and/or month; `null` removes a limit (admin) |
| `DELETE /v1/caps/{scope}` | Remove a scope's caps; `?kind=d` or `m` for one window (admin)                           |
| `GET /v1/caps`            | List caps (viewer)                                                                       |
| `POST /v1/kill`           | Stop all spend for `org`, `key:<id>`, `prov:<name>` or `sess:<id>`, immediately (admin)  |
| `POST /v1/unkill`         | Lift a kill (admin)                                                                      |

```sh
curl -X PUT https://app.spendbrake.dev/v1/caps/org \
  -H "Authorization: Bearer sbt_…" -H "Content-Type: application/json" \
  -d '{"day":{"hard":"5000000"},"month":{"hard":"50000000","soft":"40000000"}}'
```

### Spend and events

| Call                           | What                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`               | Live remaining budget per scope (viewer)                                                                       |
| `GET /v1/spend`                | Spend from the ledger, grouped by key, SKU, day, provider, session, env or agent (viewer)                      |
| `GET /v1/events`               | Usage events, newest first, or the audit log with `source=audit` (viewer)                                      |
| `GET /v1/events.csv`           | The same as a CSV download; see [CSV export](../csv-export/) (viewer)                                          |
| `POST /v1/estimates/migration` | Price the last N days of Google Maps usage on Geoapify, Stadia Maps, Open Places API, Mapbox and HERE (viewer) |

### Alerts

| Call                               | What                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| `POST /v1/webhooks`                | Add an alert webhook; the signing secret is shown once (admin) |
| `GET /v1/webhooks`                 | List webhooks (viewer)                                         |
| `DELETE /v1/webhooks/{id}`         | Delete one (admin)                                             |
| `GET /v1/webhooks/{id}/deliveries` | Delivery log, newest first (viewer)                            |
| `POST /v1/actions/execute`         | Run an alert action link; the link's token is the credential   |

See [Alerts and webhooks](../alerts/).

### Agent sessions

| Call                          | What                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /v1/sessions`           | Mint a session key (admin token, or `X-Brake-Key` of a parent key with `canMintSessions`) |
| `DELETE /v1/sessions/{keyId}` | End a session: revoke its key and report its spend                                        |
| `GET /v1/me`                  | Remaining budget of the calling virtual key (`X-Brake-Key`)                               |

See [Capping an AI agent](../agents/).

### Telemetry

| Call                           | What                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `GET /v1/metrics`              | The org's metrics in the Prometheus text format (viewer)    |
| `GET /v1/telemetry/otlp`       | Where calls go as OpenTelemetry spans (viewer)              |
| `PUT /v1/telemetry/otlp`       | Send every call as a span to an OTLP/HTTP collector (admin) |
| `DELETE /v1/telemetry/otlp`    | Stop sending spans (admin)                                  |
| `POST /v1/telemetry/otlp/test` | Send one test span now (admin)                              |

See [Telemetry](../telemetry/).

### Org, tokens and people

| Call                     | What                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| `GET /v1/org`            | Org settings (viewer)                                                           |
| `PUT /v1/org`            | Update name, time zone, provider pricing policy, alert email, loop rule (owner) |
| `POST /v1/tokens`        | Create an admin API token, shown once (owner)                                   |
| `GET /v1/tokens`         | List tokens (owner)                                                             |
| `DELETE /v1/tokens/{id}` | Revoke a token (owner)                                                          |
| `GET /v1/users`          | People in the org (admin)                                                       |
| `POST /v1/users`         | Invite a person; emails a sign-in link when email sign-in is on (owner)         |
| `PATCH /v1/users/{id}`   | Change a person's role; their sessions end (owner)                              |
| `DELETE /v1/users/{id}`  | Remove a person; their sessions end (owner)                                     |

### Sign-in and setup

| Call                         | What                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /v1/auth/options`       | How to sign in here (public)                                                                       |
| `POST /v1/auth/email`        | Email a sign-in link, valid once for 15 minutes (public)                                           |
| `POST /v1/auth/email/verify` | Spend an emailed link for a token (public)                                                         |
| `GET /v1/auth/session`       | The calling token's org and role (viewer)                                                          |
| `DELETE /v1/auth/session`    | Sign out: end the calling session (viewer)                                                         |
| `POST /v1/setup`             | First run of a self-hosted install: create the org and its owner token (needs `BRAKE_SETUP_TOKEN`) |

Business and Enterprise endpoints (license, single sign-on, approvals, audit export,
reconciliation) are not in this spec; see
[ee/README.md](https://github.com/KIvanow/spend-brake/blob/main/ee/README.md).
