---
title: Telemetry
nav_order: 9
description: Each org's own Prometheus endpoint and OpenTelemetry export, plus the operator metrics of a self-hosted install.
---

# Telemetry

Every org gets telemetry for its own calls: a Prometheus endpoint and, optionally, every call as
an OpenTelemetry span sent to your collector. Neither ever includes query strings or request
bodies: those hold addresses, phone numbers and search terms.

## Prometheus

`GET /v1/metrics` returns the org's calls, cost, latency and budget in the Prometheus text
format. Any of the org's tokens can read it; create a read-only one under **Telemetry** in the
dashboard (an owner can). The page shows a ready scrape config:

```yaml
scrape_configs:
  - job_name: spend-brake
    scheme: https
    metrics_path: /v1/metrics
    authorization:
      credentials: sbt_…
    static_configs:
      - targets: ['app.spendbrake.dev']
```

On a self-hosted install, the target is your app domain (or `localhost:8081` for a local
install, with `scheme: http`).

| Metric                                  | Type      | Labels                                              |
| --------------------------------------- | --------- | --------------------------------------------------- |
| `spend_brake_requests_total`            | counter   | `provider`, `sku`, `key`, `agent`, `env`, `outcome` |
| `spend_brake_cost_usd_total`            | counter   | `provider`, `sku`, `key`, `agent`, `env`            |
| `spend_brake_refunds_usd_total`         | counter   | `provider`, `sku`, `key`, `agent`, `env`            |
| `spend_brake_request_duration_seconds`  | histogram | `provider`                                          |
| `spend_brake_upstream_duration_seconds` | histogram | `provider`                                          |
| `spend_brake_spent_usd`                 | gauge     | `scope`, `window`                                   |
| `spend_brake_cap_usd`                   | gauge     | `scope`, `window`                                   |
| `spend_brake_remaining_usd`             | gauge     | `scope`, `window`                                   |

- **Requests** count refused calls too. `outcome` is `ok`, `http_4xx` / `http_5xx`,
  `provider_error`, `upstream_key_error`, `upstream_error`, `credential_unavailable`, or why
  Spend Brake refused the call.
- **Refunds** count cost given back when a provider settled below the reserved price (Twilio).
- **Durations:** the whole call, and the time the provider took to answer; the difference is
  Spend Brake's. Buckets from 25 ms to 10 s.
- **Budget gauges** cover the org and each active key, with `window` `day` or `month`.
- Calls inside an agent session are labelled by agent, not by key: session keys come and go, and
  one series each would grow without bound.

## OpenTelemetry

Under **Telemetry**, set an OTLP/HTTP endpoint and any headers your collector needs (stored
encrypted; at most 10). The worker sends every call as a span. When the request to the proxy
carried a W3C `traceparent` header, the span joins the caller's trace as a child of their span;
otherwise it starts a trace of its own.

| Collector     | Endpoint                                       | Header                    |
| ------------- | ---------------------------------------------- | ------------------------- |
| Honeycomb     | `https://api.honeycomb.io`                     | `x-honeycomb-team`        |
| Grafana Cloud | `https://otlp-gateway-<zone>.grafana.net/otlp` | `Authorization` (Basic …) |
| Your own      | `https://otel.example.com:4318`                | as configured             |

Spans go to `<endpoint>/v1/traces` unless the endpoint already ends in `/v1/traces`. Endpoints
must be `https://` without credentials in the URL; put API keys in headers. **Send test span**
sends one span right away and shows the collector's answer.

A collector that is down delays spans: up to 10,000 wait per org, and older ones are dropped.
The page shows the last success, the last error and how many spans are waiting.

Each span is named `<provider> <route>`, with these attributes:

| Attribute                                                                              | What                                      |
| -------------------------------------------------------------------------------------- | ----------------------------------------- |
| `spend_brake.provider`, `spend_brake.route`                                            | Where the call went                       |
| `spend_brake.sku`, `spend_brake.skus`                                                  | What it was priced as                     |
| `spend_brake.cost_usd`                                                                 | What it cost                              |
| `spend_brake.reserved_usd`                                                             | The worst case reserved before forwarding |
| `spend_brake.outcome`                                                                  | As the `outcome` label above              |
| `spend_brake.blocked_scope`                                                            | The scope that refused it, if one did     |
| `spend_brake.key_id`, `spend_brake.session`, `spend_brake.agent_id`, `spend_brake.env` | Who made it                               |
| `spend_brake.request_id`                                                               | The `X-Brake-Request-Id` of the response  |
| `spend_brake.upstream_duration_ms`                                                     | Time the provider took                    |
| `http.response.status_code`, `http.request.body.size`, `http.response.body.size`       |                                           |

The resource carries `service.name=spend-brake` and `spend_brake.org_id`.

On the hosted service, OpenTelemetry export comes with the Team and Agents plans.

### The API

| Call                           | What                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `GET /v1/telemetry/otlp`       | Where spans go, with the last success and error                                           |
| `PUT /v1/telemetry/otlp`       | Set `endpoint`, `headers` (omit to keep the stored ones; `{}` removes them) and `enabled` |
| `DELETE /v1/telemetry/otlp`    | Stop sending spans, and drop the ones waiting                                             |
| `POST /v1/telemetry/otlp/test` | Send one test span now                                                                    |

### Collectors on private addresses

Private addresses are refused. For development, `ALLOW_PRIVATE_COLLECTORS=true` on the API and
the worker allows them, and a local `http://` collector (`localhost`, `127.0.0.1`, `[::1]`).
Leave it off on a server other people use.

## Operator metrics (self-hosted)

Separate from each org's telemetry, the services expose their own metrics inside the Docker
network:

| Where                   | Metrics                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy, `:9465/metrics`  | `brake_requests_total{provider,sku,outcome}`, `brake_cost_micros_total`, `brake_reserve_latency_ms`, `brake_upstream_latency_ms`, `brake_fail_open_replayed_total`                                                                                         |
| Worker, `:9464/metrics` | `brake_ledger_events_total`, `brake_cost_micros_total`, `brake_reservations_expired_total`, `brake_alerts_queued_total`, `brake_ledger_lag_events`, `brake_catalog_drift_total`, `brake_reconcile_drift_ratio`, `brake_worker_last_loop_timestamp_seconds` |

Worth paging on: `brake_reservations_expired_total` rising, `brake_ledger_lag_events` growing,
`brake_worker_last_loop_timestamp_seconds` going stale, and `upstream_key_error` and
`reconcile_drift` alerts.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on a service and it exports its own OpenTelemetry traces;
secrets are stripped from every span. Health checks are `GET /healthz` on the proxy, API and
notifier.
