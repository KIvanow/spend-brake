---
title: Configuration
nav_order: 7
description: Every environment variable a self-hosted install reads, from infra/.env and the compose files.
---

# Configuration

A self-hosted install is configured in `infra/.env`, which the compose files read. Copy
[`infra/.env.example`](https://github.com/KIvanow/spend-brake/blob/main/infra/.env.example) and
fill it in. Each service gets only the secrets it uses.

Generate secrets with:

```sh
openssl rand -base64 32   # master key, action secret
openssl rand -hex 24      # passwords and the setup token: they go into URLs, keep them hex
```

## Secrets

| Variable              | Required | Used by                      | What                                                                                                                                                     |
| --------------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAKE_MASTER_KEY`    | Yes      | API, proxy, worker, notifier | 32 bytes, base64. Encrypts provider keys and webhook URLs. Keep a copy off the host: without it they cannot be decrypted, and backups do not contain it. |
| `BRAKE_ACTION_SECRET` | Yes      | API, notifier                | Signs alert action links (Kill, Raise, Mute).                                                                                                            |
| `BRAKE_SETUP_TOKEN`   | Once     | API                          | One-time token for `brake init`. Remove it after setup.                                                                                                  |
| `VALKEY_PASSWORD`     | Yes      | Valkey and every service     | Valkey's password.                                                                                                                                       |
| `POSTGRES_PASSWORD`   | Yes      | Postgres and every service   | Postgres's password (user and database are `brake`).                                                                                                     |

## URLs and sign-in

| Variable                 | Default                 | What                                                                                                                                                                 |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAKE_PUBLIC_URL`       | `http://localhost:8082` | Where browsers reach the notifier: alert action links point here.                                                                                                    |
| `BRAKE_DASHBOARD_URL`    | `http://localhost:3000` | Where the dashboard is: View links in alerts and the links in sign-in emails.                                                                                        |
| `BRAKE_PUBLIC_PROXY_URL` | `http://localhost:8080` | The proxy URL the dashboard shows in its setup steps.                                                                                                                |
| `BRAKE_EMAIL_SIGN_IN`    | `false`                 | Sign in to the dashboard with emailed one-time links instead of API tokens. Needs `SMTP_URL`.                                                                        |
| `BRAKE_PROXY_EGRESS_IPS` |                         | The proxy's outbound IP addresses, comma-separated (`curl https://api64.ipify.org` on the host). The dashboard tells people to restrict their provider keys to them. |

With the HTTPS overlay, `BRAKE_PUBLIC_URL`, `BRAKE_DASHBOARD_URL` and `BRAKE_PUBLIC_PROXY_URL`
are set from the two domain names below; you don't set them yourself.

## Dashboard analytics

Off unless you set a key: then the dashboard loads nothing from PostHog and sends nothing.

| Variable             | Default                    | What                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAKE_POSTHOG_KEY`  |                            | A PostHog project key (`phc_...`). The API hands it to the dashboard, which then counts page views (the page name only) and a few product events, with people known by their internal user id. Nothing is stored in the browser; no autocapture or recordings. |
| `BRAKE_POSTHOG_HOST` | `https://eu.i.posthog.com` | Where the dashboard sends them. Another host also needs adding to `connect-src` in `infra/nginx.conf`, the dashboard's Content Security Policy.                                                                                                                |

## HTTPS (`docker-compose.tls.yml`)

| Variable             | Example             | What                                                       |
| -------------------- | ------------------- | ---------------------------------------------------------- |
| `BRAKE_PROXY_DOMAIN` | `brake.example.com` | The base URL apps and agents use instead of the provider's |
| `BRAKE_APP_DOMAIN`   | `app.example.com`   | Dashboard, admin API (`/v1`), alert links (`/a/`), SSO     |
| `ACME_EMAIL`         | `ops@example.com`   | Let's Encrypt notices                                      |
| `BRAKE_HTTP_PORT`    | `80` (default)      | Published HTTP port, if something else holds 80            |
| `BRAKE_HTTPS_PORT`   | `443` (default)     | Published HTTPS port, if something else holds 443          |

See [Self-hosting: HTTPS](../self-hosting/#2-https).

## Ports and resources

| Variable                                         | Default     | What                                                                                                                                                                                      |
| ------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAKE_BIND_ADDRESS`                             | `127.0.0.1` | Where the proxy, API, notifier and dashboard ports listen without the HTTPS overlay. `0.0.0.0` publishes them on every interface (plain HTTP: only on a network you trust).               |
| `VALKEY_MAXMEMORY`                               | `256mb`     | Valkey's memory ceiling. It never evicts (counters and reservations must survive), so at the ceiling writes fail and the proxy refuses requests: size it for your keys and keep headroom. |
| `BRAKE_<SERVICE>_MEMORY`, `BRAKE_<SERVICE>_CPUS` | see below   | Each container's memory and CPU limit. `<SERVICE>` is `VALKEY`, `POSTGRES`, `API`, `PROXY`, `WORKER`, `NOTIFIER`, `WEB`, `CADDY` (HTTPS overlay) or `BILLING` (hosted).                   |

The default limits fit a 4 GB host with room to spare: Valkey 512M / 1 CPU, Postgres 512M / 1,
API 384M / 1, proxy 512M / 1, worker 256M / 0.5, notifier 192M / 0.5, dashboard 64M / 0.5,
Caddy 128M / 0.5, billing 192M / 0.5. Keep Valkey's limit at about twice `VALKEY_MAXMEMORY`: an
append-only-file rewrite forks the process. A CPU limit above the host's CPU count is refused,
so on a 1-CPU host keep every `_CPUS` at 1 or below.

## Email, telemetry and price drift

| Variable                      | Default                          | What                                                                                                                                                                                            |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_URL`                    |                                  | Outgoing mail, e.g. `smtps://user:password@smtp.example.com:465`. Email alerts and sign-in links.                                                                                               |
| `BRAKE_EMAIL_FROM`            | `Spend Brake <alerts@localhost>` | The sender, on a domain your mail provider has verified.                                                                                                                                        |
| `OPERATOR_EMAIL`              |                                  | Where operator alerts (catalog price drift) go.                                                                                                                                                 |
| `ALLOW_PRIVATE_COLLECTORS`    | `false`                          | Let orgs send OpenTelemetry spans to private addresses and a local `http://` collector. Set on the API and the worker. Leave off on a server other people use.                                  |
| `ALLOW_PRIVATE_CUSTOM_APIS`   | `false`                          | Let orgs' [custom APIs](../custom-apis/) point at private and loopback addresses (an API on the same machine or network). Set on the API and the proxy. Leave off on a server other people use. |
| `GITHUB_TOKEN`, `GITHUB_REPO` |                                  | Optional: the worker opens a GitHub issue when a provider's price page changes.                                                                                                                 |

## Published images (`docker-compose.release.yml`)

Published images are coming; until then, build from source.

| Variable             | What                                                  |
| -------------------- | ----------------------------------------------------- |
| `BRAKE_VERSION`      | The image tag to run. Pin it; upgrade by changing it. |
| `BRAKE_API_IMAGE`    | `ee-api` with the Business / Enterprise overlay       |
| `BRAKE_WORKER_IMAGE` | `ee-worker` with the Business / Enterprise overlay    |

## Business / Enterprise (`docker-compose.ee.yml`)

| Variable                                                                  | What                                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAKE_PUBLIC_API_URL`                                                    | Where browsers reach the API (single sign-on)                                                                                                  |
| `BRAKE_CATALOG_FEED_URL`                                                  | The signed catalog feed the worker fetches daily                                                                                               |
| `BRAKE_AUDIT_FILE`                                                        | Ship the audit log to a file (JSON Lines)                                                                                                      |
| `BRAKE_AUDIT_S3_BUCKET`, `BRAKE_AUDIT_S3_PREFIX`, `BRAKE_AUDIT_S3_REGION` | Ship the audit log to S3                                                                                                                       |
| `BRAKE_AUDIT_SYSLOG`                                                      | Ship the audit log to syslog (`udp://host:514` or `tcp://…`)                                                                                   |
| `ALLOW_PRIVATE_IDP`                                                       | `true` lets an org's OIDC issuer be on a private address (an IdP inside your network); off by default. Leave off on a server other people use. |

See [ee/README.md](https://github.com/KIvanow/spend-brake/blob/main/ee/README.md).

## Per-service settings

These are not in `infra/.env`; set them on a service with a compose override file if you need
them.

| Variable                              | Service               | Default        | What                                                                                                                    |
| ------------------------------------- | --------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `VALKEY_URL`                          | all                   | set by compose | `redis-cluster://:password@host1:6379,host2:6379,…` for a Valkey Cluster (`rediss-cluster://` for TLS)                  |
| `DATABASE_URL`                        | API, worker, notifier | set by compose | Postgres connection string                                                                                              |
| `LOG_LEVEL`                           | all                   | `info`         |                                                                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | all                   |                | Export the services' own OpenTelemetry traces (standard `OTEL_*` variables apply; secrets are stripped from every span) |
| `BRAKE_OTEL_CLIENT_URLS`              | all                   |                | `origin` reduces outgoing request URLs in traces to scheme and host                                                     |
| `RATE_LIMIT_PER_MINUTE`               | API                   | `600`          | Requests per token per minute (4x that per IP before authentication)                                                    |
| `GOOGLE_KEY_CHECK`                    | API                   | `true`         | Check a new Google key's restrictions with a free call to Google                                                        |
| `TRUST_PROXY`                         | proxy, API            | `false`        | Use `X-Forwarded-For` for client IPs (the HTTPS overlay sets it)                                                        |
| `UPSTREAM_TIMEOUT_MS`                 | proxy                 | `30000`        | How long the proxy waits for a provider                                                                                 |
| `BRAKE_SERPAPI_PLAN`                  | proxy                 | `starter`      | The SerpApi plan whose per-search price applies                                                                         |
| `BRAKE_SERPAPI_SPEED`                 | proxy                 | `normal`       | SerpApi speed mode: `ludicrous` bills 2x, `ludicrous_max` 4x                                                            |
| `BRAKE_GENERIC_PROVIDERS`             | proxy                 |                | JSON array of generic adapter configs: price any other API for every org (see below)                                    |
| `BRAKE_CUSTOM_API_MAX_RESPONSE_BYTES` | proxy                 | `10485760`     | Largest custom API response passed on; a longer one is cut and recorded as an error                                     |
| `BRAKE_CATALOG_DIR`                   | proxy                 |                | Updated catalog data (`current/`), checked every 30 s                                                                   |
| `BRAKE_FAIL_OPEN_DIR`                 | proxy                 | set by compose | Where fail-open spend Valkey could not take by shutdown is kept and replayed after the next start (keep it on a volume) |
| `METRICS_PORT`                        | proxy, worker         | `9465`, `9464` | Prometheus metrics port                                                                                                 |
| `BRAKE_ACTION_TTL_SEC`                | notifier              | `900`          | How long alert action links work                                                                                        |
| `BRAKE_MAX_CUSTOM_RAISE_USD`          | notifier              | `500`          | The largest custom raise an alert link offers                                                                           |
| `ALLOW_PRIVATE_WEBHOOKS`              | notifier              | `false`        | Allow webhook hosts that resolve to private addresses                                                                   |

The service READMEs list the rest:
[proxy](https://github.com/KIvanow/spend-brake/tree/main/apps/proxy#configuration-env),
[API](https://github.com/KIvanow/spend-brake/tree/main/apps/api#configuration-env),
[worker](https://github.com/KIvanow/spend-brake/tree/main/apps/worker),
[notifier](https://github.com/KIvanow/spend-brake/tree/main/apps/notifier#configuration-env).

## Generic providers

Orgs can add APIs without a built-in adapter themselves, from the dashboard, the API or the CLI:
see [Custom APIs](../custom-apis/). Those belong to one org and are served at
`<proxy>/custom/<id>/...`.

`BRAKE_GENERIC_PROVIDERS` on the proxy does the same for every org on the install, with a path
prefix of your choice. It is the operator's list: it can use `http://` origins and private
addresses, which custom APIs cannot. Each entry is a custom API definition plus a `prefix`:

```json
[
  {
    "id": "acme",
    "prefix": "/acme",
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
        "path": "/v1/agents/**",
        "sku": "agent_run",
        "pricing": {
          "model": "reported",
          "header": "X-Credits-Used",
          "usdPerUnit": "0.001",
          "maxPerRequest": "0.50"
        }
      }
    ]
  }
]
```

Routes are priced the same two ways as custom APIs: `perRequest` (a flat price) or `reported`
(the cost the API reports in a response header or JSON field, with a maximum reserved up front);
[Custom APIs: pricing](../custom-apis/#pricing) explains both. The older spelling
`"pricePerRequest": "0.005"` still works and means `perRequest`.

Store the API's key as a provider credential for `acme` (`POST /v1/providers/credentials` with
`"provider": "acme"`), create a virtual key that uses it
(`brake keys create --name app --credential acme=<credential id>`), and call
`<proxy>/acme/v1/search` with the virtual key in `X-Brake-Key`. Route paths are globs: `*`
matches one segment, `**` any number. Only 2xx responses are billed unless `"billed": "all"`.
The prefix `/custom` is reserved for custom APIs. Give operator providers ids no org will use for
a custom API: a key binds one credential per provider id.
