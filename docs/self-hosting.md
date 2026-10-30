# Self-hosting Spend Brake

A single Docker host runs everything: the proxy (what apps and agents call), the admin API, the
worker, the notifier, the dashboard, Postgres and Valkey. This guide covers going from the
5-minute quickstart to something you can depend on.

## 1. Install

Copy `infra/.env.example` to `infra/.env` and fill it in (the file says how to generate each
secret). Keep `BRAKE_MASTER_KEY` somewhere outside the host as well: provider keys and webhook
URLs are encrypted with it and cannot be recovered without it.

Build the images from source and start the stack:

```sh
F="-f infra/docker-compose.yml -f infra/docker-compose.tls.yml"
docker compose --env-file infra/.env $F build
docker compose --env-file infra/.env $F up -d --wait
```

Published images are coming; until then there is nothing to pull, and
`infra/docker-compose.release.yml` is for when they are. Business / Enterprise: add
`-f infra/docker-compose.ee.yml` right after the base file (see [ee/README.md](../ee/README.md)).

Then build the CLI (`pnpm install && pnpm --filter @spend-brake/cli build`, which writes
`apps/cli/dist/brake.cjs`; published packages are coming too), run
`node apps/cli/dist/brake.cjs init` once (it uses `BRAKE_SETUP_TOKEN`), and remove the setup
token from `infra/.env` afterwards.

People sign in to the dashboard with an API token by default. With email set up (section 2),
set `BRAKE_EMAIL_SIGN_IN=true` and invite your team under Team: each person gets a one-time
sign-in link by email instead of a token to keep.

## 2. HTTPS

`infra/docker-compose.tls.yml` puts [Caddy](https://caddyserver.com) in front with certificates
from Let's Encrypt, renewed automatically. Set in `infra/.env`:

| Variable             | Example                | What                                                       |
| -------------------- | ---------------------- | ---------------------------------------------------------- |
| `BRAKE_PROXY_DOMAIN` | `brake.example.com`    | The base URL apps and agents use instead of the provider's |
| `BRAKE_APP_DOMAIN`   | `app.example.com`      | Dashboard, admin API (`/v1`), alert links (`/a/`), SSO     |
| `ACME_EMAIL`         | `ops@example.com`      | Let's Encrypt notices                                      |
| `BRAKE_HTTP(S)_PORT` | `80` / `443` (default) | Published ports, if something else holds 80/443            |

Both names must resolve to the host and ports 80 and 443 must be reachable for the certificate
challenge. With this overlay only Caddy publishes ports; the services' own ports are closed,
and the proxy and API trust Caddy's `X-Forwarded-For` (Caddy drops one sent by a client).
Point the CLI at `https://app.example.com` (API) and `https://brake.example.com` (proxy).
SAML single sign-on needs HTTPS.

Email alerts and license emails go out through `SMTP_URL` (for example
`smtps://user:password@smtp.example.com:465`) from `BRAKE_EMAIL_FROM`, on a domain your mail
provider has verified. Some hosts block outgoing ports 25, 465 and 587 (DigitalOcean does on
new accounts); use the provider's alternative port, such as 2465 or 2587, if they offer one.

## 3. Make the proxy the only way to spend

Caps only hold if nothing reaches the provider without the proxy. Give the proxy a fixed
outbound IP address and restrict each provider key to it (`brake init` prints the Google Cloud
steps for Google keys):

- On a single VM, its public IP is usually fixed; check it from inside the proxy container:
  `docker compose exec proxy node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"`.
- Behind a cloud NAT (AWS NAT Gateway with an Elastic IP, GCP Cloud NAT with a static address,
  Azure NAT Gateway), use the NAT's address.
- Where a provider has no IP restriction (several search APIs), keep the key only in Spend
  Brake, rotate it if it was ever used elsewhere, and keep the provider's own spend limit on as
  a backstop.

## 4. Check prices against your real bills

Before relying on the caps, run one cheap call per provider through your install and compare:

```sh
BRAKE_API_URL=https://app.example.com BRAKE_PROXY_URL=https://brake.example.com \
BRAKE_ADMIN_TOKEN=sbt_... GOOGLE_MAPS_KEY=... MAPBOX_TOKEN=... EXA_API_KEY=... \
node scripts/check-providers.mjs
```

It creates a temporary key with a $0.50 daily cap per provider, makes the call, prints what the
proxy charged next to what the provider reported (Tavily, Exa), and removes everything it
created. A few cents in total. The next day, compare the charges with each provider's usage
page; a difference means a catalog price to correct. For Twilio, send one SMS to your own phone
through the proxy and compare the settled price (the `adjustment` event) with Twilio's console.
For Google, connect the billing export (Business / Enterprise) and reconciliation does this
daily.

## 5. Backups

Postgres holds configuration, the ledger and the audit log; Valkey holds live spend counters,
reservations and kill switches. Back up both, e.g. hourly from cron, and copy the result off
the host:

```sh
COMPOSE_FILES="-f infra/docker-compose.yml -f infra/docker-compose.tls.yml" scripts/backup.sh
```

Restore replaces the data of a running install (services stop for the swap, then restart):

```sh
COMPOSE_FILES="..." scripts/restore.sh backups/20261030T120000Z
```

Spend recorded after the backup was taken is not in it: after a restore, live counters stand
where they were at backup time, so caps can let that much through again. The backup contains
encrypted credentials; it is useless without `BRAKE_MASTER_KEY`, which is not in it.

## 6. Upgrades

1. Read the release notes in [CHANGELOG.md](../CHANGELOG.md).
2. Back up (section 5).
3. `git pull` the release, then `docker compose ... build && docker compose ... up -d --wait`.

The API and worker apply database migrations on start (one at a time, under a lock).
Migrations only move forward: to roll back, restore the backup and start the previous version.

## 7. Scaling and high availability

- **Proxy:** stateless; run several with `docker compose ... up -d --scale proxy=3`. Caddy
  spreads requests across them and skips one that fails its health check.
- **Worker:** run several; they share the ledger stream through a consumer group, and alerts
  are deduplicated, so a second worker takes over if one stops.
- **Valkey:** caps are only as available as Valkey. For high availability use a Valkey Cluster
  and set `VALKEY_URL=redis-cluster://:password@valkey-1:6379,valkey-2:6379,valkey-3:6379`
  (`rediss-cluster://` for TLS); every key of an org lives in one slot, so budget checks stay
  atomic. When Valkey is unreachable the proxy refuses requests (fail closed) unless a key has
  a fail-open allowance.
- **Postgres:** use a managed Postgres or a replicated setup for durability; the proxy keeps
  enforcing caps during a Postgres outage (config is cached in Valkey), while the API and the
  ledger wait for it.

## 8. Monitoring

| What                   | Where                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health                 | `GET /healthz` on the proxy, API and notifier                                                                                                                                     |
| Metrics (Prometheus)   | proxy `:9465/metrics`, worker `:9464/metrics` (inside the network)                                                                                                                |
| Traces (OpenTelemetry) | set `OTEL_EXPORTER_OTLP_ENDPOINT` on each service                                                                                                                                 |
| Alerts worth paging on | `brake_reservations_expired_total` rising, `brake_ledger_lag_events` growing, `brake_worker_last_loop_timestamp_seconds` stale, `upstream_key_error` and `reconcile_drift` alerts |

### Each org's own telemetry

Separate from the operator metrics above, every org gets telemetry for its own calls:

- **Prometheus:** `GET https://<app domain>/v1/metrics` with any of the org's tokens (create a
  read-only one under Telemetry). Requests, cost and refunds by provider, SKU, key, agent,
  environment and outcome (including refused calls), request and provider latency histograms,
  and what is left of each cap.
- **OpenTelemetry:** under Telemetry, an org sets an OTLP/HTTP endpoint and headers (stored
  encrypted); the worker sends every call as a span, inside the caller's trace when the request
  carried a `traceparent` header. A collector that is down delays spans (up to 10,000 wait per
  org); private addresses are refused (`ALLOW_PRIVATE_COLLECTORS=true` on the worker allows them,
  for development). On the hosted service this comes with the Team and Agents plans.

Neither ever includes query strings or request bodies: those hold addresses, phone numbers and
search terms.
