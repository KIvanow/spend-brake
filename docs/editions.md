---
title: Editions and license
nav_order: 14
description: The Apache-2.0 core, the Business and Enterprise features, and the hosted plans.
---

# Editions and license

## The core: Apache-2.0

Everything outside `ee/` is Apache-2.0: the proxy, budget engine, caps, kill switch, loop
detection, CLI, catalog data, dashboard and signed webhooks. It never needs a license key.

## Business and Enterprise

`ee/` (under `LICENSE-EE`) adds, with a Business or Enterprise license:

- single sign-on (OIDC, SAML);
- roles beyond owner, admin and viewer;
- two-person approval for raising caps;
- audit export (JSON Lines to a file, S3 or syslog);
- more than one org per install;
- the signed catalog feed;
- billing reconciliation with Google's billing export and Twilio's usage records.

Run it with the `infra/docker-compose.ee.yml` overlay right after the base file, then install
the license:

```sh
brake license install acme.license   # owner token of the licensed org
brake license status --pretty
```

Licenses are Ed25519-signed files checked offline; nothing phones home. After a license expires,
its features keep working for 14 days, then turn read-only. The proxy and caps never stop. See
[ee/README.md](https://github.com/KIvanow/spend-brake/blob/main/ee/README.md) and
[pricing](https://spendbrake.dev/#pricing).

## Hosted plans

The hosted service at [app.spendbrake.dev](https://app.spendbrake.dev) has Free, Indie, Team and
Agents plans, billed monthly. Every plan enforces caps the same way; plans differ in how many
keys, providers and agent sessions you run, how long call history is kept, and whether
OpenTelemetry export and session analytics are included. See
[pricing](https://spendbrake.dev/#pricing).

Downgrades and failed payments only block creating new keys, providers and sessions: existing
keys and caps keep enforcing.

## Contributing

Contributions use DCO sign-off (`git commit -s`); see
[CONTRIBUTING.md](https://github.com/KIvanow/spend-brake/blob/main/CONTRIBUTING.md).
