# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Each release publishes container
images (`ghcr.io/kivanow/spend-brake-<service>:<version>`) and the CLI (`@spend-brake/cli`).

## [0.1.0] - unreleased

First release.

### Core (Apache-2.0)

- Egress proxy that prices every request before it leaves and enforces hard dollar caps per
  org, key, SKU, environment, agent and session, per day and month, in one atomic Valkey step;
  `402` with the scope once a cap would be crossed.
- Providers: Google Maps Platform (Places, Geocoding, Routes, legacy APIs), Twilio Messaging
  and Verify (settled at Twilio's final price), Mapbox, HERE, Tavily, Exa, Brave, SerpApi, and a
  generic per-request adapter. Prices are data files citing their source and verification date.
- Loop detection, kill switch, signed webhooks with Slack/Discord/Teams presets and action
  links, email fallback, dashboard, admin API with OpenAPI spec, `brake` CLI with agent
  sessions, migration estimate to OSM providers, Mapbox and HERE.
- Self-hosting: Docker Compose stack, HTTPS overlay with automatic certificates (Caddy),
  proxy replicas, Valkey Cluster (`redis-cluster://` URLs), backup and restore scripts.

### Hosted billing

- Stripe (test mode): Free, Indie, Team, Agents plans with limits enforced by the admin API;
  Business license by subscription and Enterprise by invoice, each paid invoice issuing or
  renewing a signed license; Checkout, Customer Portal, idempotent webhooks.

### Accounts

- Sign in to the dashboard with an emailed one-time link (`BRAKE_EMAIL_SIGN_IN`), alongside API
  tokens and single sign-on. Links work once for 15 minutes; sessions last 7 days. Orgs with
  single sign-on configured refuse email sign-in, and email sign-ins never count as an
  approver for two-person approval.
- Team page: invite people by email as viewer, admin or owner, change roles, remove people
  (their sessions end at once); an org always keeps an owner.
- Hosted sign-up page with plan choice (paid plans continue to Stripe Checkout), and a Get
  started page: add a provider key, create a Spend Brake key with the exact change to make in
  the app, set caps, see the first call. Provider keys and Spend Brake keys can now be managed
  in the dashboard.

### Telemetry for each org

- Calls record the caller's trace context (`traceparent`), user agent, request and response size
  and the provider's latency, never query strings or bodies.
- `GET /v1/metrics`: the org's own Prometheus metrics (requests by outcome, cost, refunds,
  latency histograms, live budget), counted once per call even when the ledger replays.
- OpenTelemetry export: every call as an OTLP span to the org's collector, joining the caller's
  trace; headers encrypted, private addresses refused, bounded retry queue. Team and Agents
  plans on the hosted service.

### Business / Enterprise (`ee/`, LICENSE-EE)

- Offline-verified licenses with a 14-day grace period; single sign-on (OIDC, SAML); operator,
  billing and auditor roles; two-person approval for raising caps; audit export to a file, S3
  or syslog; several orgs per install; signed catalog feed; billing reconciliation against the
  Google Cloud Billing export and Twilio Usage Records.
