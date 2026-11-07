---
title: Changelog
nav_order: 16
permalink: /changelog/
description: What changed in each Spend Brake release.
---

# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Each release publishes container
images for linux/amd64 and linux/arm64
(`ghcr.io/kivanow/spend-brake-<service>:<version>`, with build provenance) and the CLI
(`@spend-brake/cli`).

## [Unreleased]

### Added

- `brake doctor` checks, from where an agent runs, what could let it spend past its caps: a
  missing or uncapped key, a readable admin token, raw provider keys in the environment or in
  `./.env*` files, a second virtual key, plain HTTP, fail-open, keys that never expire, and
  providers whose unpriced routes are forwarded. `--prove` mints a $0 session and shows that
  the proxy refuses a priced call before forwarding it, spending nothing. Every report lists
  what doctor cannot verify; it never reports a workload as protected.
- `brake mcp`, a stdio MCP server with capped `tavily_search` and `exa_search` tools and a
  read-only `brake_budget` tool, to replace a Tavily or Exa MCP server entry without changing
  the agent (preview). Also published on its own as `@spend-brake/mcp`
  (`npx -y @spend-brake/mcp`).
- `GET /v1/me` reports the key's own policy: its providers, SKUs, whether it may mint
  sessions, its expiry, fail-open allowance, and the org's unpriced-route policy for each of
  its providers.

## [0.2.1] - 2026-11-02

### Fixed

- `brake --version` printed `0.1.0` in the 0.2.0 package; the bundle now takes the version from
  the package itself.

## [0.2.0] - 2026-11-02

### Changed

- `brake init` no longer needs a Google key: without one it sets up the org, its caps and the
  tokens, and explains how to add a provider key and a virtual key (for installs that only use
  other providers or custom APIs). Press Enter at the prompt to skip it.

### Fixed

- `brake init` printed no owner token when the API refused the Google key, after the one-time
  setup token was already spent. The org is now set up all the same, the owner token is printed,
  and `init` exits 1 with the reason.
- `brake call custom/<id> <method> <path>` reaches a custom API (it was refused as an invalid
  provider).
- `brake caps set --pretty` prints the caps table, and `brake caps rm --pretty` says what it
  removed, instead of JSON.

## [0.1.0] - 2026-11-02

First release: the open-source proxy, dashboard and CLI, and the hosted service at
[spendbrake.dev](https://spendbrake.dev).

### Install

- CLI: `npx @spend-brake/cli --help` (Node 22 or newer).
- Self-hosting from published images, for linux/amd64 and linux/arm64, each with a build
  provenance attestation:
  `BRAKE_VERSION=0.1.0 docker compose -f infra/docker-compose.yml -f infra/docker-compose.release.yml up -d --wait`.
  See the [self-hosting guide](https://docs.spendbrake.dev/self-hosting/).

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
- Custom APIs: put any HTTP API you call behind a cap at `/custom/<id>/…`, priced per request or
  from a cost the response reports (with a maximum per request); 1, 3, 10 or 25 per org by
  plan on the hosted service.
- Google Places Autocomplete sessions priced as Google bills them, closed by Place Details and
  switched to per-request pricing after 12 requests or 3 minutes.

### Hosted billing

- Stripe: Free, Indie, Team, Agents plans with limits enforced by the admin API; Business
  license by subscription and Enterprise by invoice, each paid invoice issuing or renewing a
  signed license; Checkout, Customer Portal, idempotent webhooks.
- Live mode behind `BILLING_LIVE_MODE`, with VAT through Stripe Tax (billing address and tax ID
  at Checkout, prices exclusive of tax), a seed and a webhook setup script that are safe to run
  against a live account, and an operator runbook.
- Paid checkout asks the buyer to accept the Terms and waive the withdrawal period; the
  acceptance is recorded in the audit log and on the Stripe session.

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
- CSV export of requests and the audit log (`GET /v1/events.csv`, Export CSV on Events), with
  key names and formula-safe cells; proxy errors name the key (`key "web app" (key_…)`).

### Telemetry for each org

- Calls record the caller's trace context (`traceparent`), user agent, request and response size
  and the provider's latency, never query strings or bodies.
- `GET /v1/metrics`: the org's own Prometheus metrics (requests by outcome, cost, refunds,
  latency histograms, live budget), counted once per call even when the ledger replays.
- OpenTelemetry export: every call as an OTLP span to the org's collector, joining the caller's
  trace; headers encrypted, private addresses refused, bounded retry queue. Team and Agents
  plans on the hosted service.

### Reliability and security

- Fail-open spend is journaled and recorded exactly once after an outage, across restarts,
  shutdowns and overlapping replays; `/readyz` on the proxy and API.
- Compressed responses (gzip, deflate, brotli, zstd) are decoded with a size bound; secondary
  SKUs (such as Places fields billed at a higher tier) count against their own caps.
- Outbound calls to identity providers, collectors and custom APIs refuse private addresses
  unless allowed; `X-Forwarded-For` is trusted only from private hops.
- Compose stack: resource limits on every service, third-party images pinned by digest, ports
  bound to localhost by default, services running as node with node as PID 1; `restore.sh`
  checks a backup in a scratch database before swapping it in.

### Hosted service

- Public [status page](https://spendbrake.dev/status) with incident history, privacy policy,
  terms, data processing agreement and security page; product analytics (PostHog EU,
  cookieless on the website, no personal data on the dashboard).

### Business / Enterprise (`ee/`, LICENSE-EE)

- Offline-verified licenses with a 14-day grace period; single sign-on (OIDC, SAML); operator,
  billing and auditor roles; two-person approval for raising caps; audit export to a file, S3
  or syslog; several orgs per install; signed catalog feed; billing reconciliation against the
  Google Cloud Billing export and Twilio Usage Records.
