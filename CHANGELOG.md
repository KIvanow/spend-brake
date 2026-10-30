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

### Business / Enterprise (`ee/`, LICENSE-EE)

- Offline-verified licenses with a 14-day grace period; single sign-on (OIDC, SAML); operator,
  billing and auditor roles; two-person approval for raising caps; audit export to a file, S3
  or syslog; several orgs per install; signed catalog feed; billing reconciliation against the
  Google Cloud Billing export and Twilio Usage Records.
