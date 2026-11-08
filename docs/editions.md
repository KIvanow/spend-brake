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
the license ([buying one](#buying-a-license)):

```sh
brake license install acme.license   # owner token of the licensed org
brake license status --pretty
```

Licenses are Ed25519-signed files checked offline; nothing phones home. After a license expires,
its features keep working for 14 days, then turn read-only. The proxy and caps never stop. See
[ee/README.md](https://github.com/KIvanow/spend-brake/blob/main/ee/README.md) and
[pricing](https://spendbrake.dev/#pricing).

## Buying a license

Business is bought online ([pricing](https://spendbrake.dev/#pricing)):

1. Open [Buy Business](https://app.spendbrake.dev/#/signup?plan=business). Give your work email
   and the **org id of your install**: the `--org` you gave `brake init`. The license names that
   org, and an install takes it only into the org with the same id (otherwise
   `403 license_wrong_org`).
2. Pay through Stripe Checkout. The license file, `<org id>.license`, is emailed to you. Left the
   payment page? Sign in to app.spendbrake.dev by email and buy it under Billing.
3. Install it as [shown above](#business-and-enterprise), with an owner token of that org (the
   one `brake init` printed). Read it without echo, so it stays out of your shell history:

   ```sh
   # bash or zsh; in sh or dash: stty -echo; read -r BRAKE_ADMIN_TOKEN; stty echo; export BRAKE_ADMIN_TOKEN
   read -rs BRAKE_ADMIN_TOKEN && export BRAKE_ADMIN_TOKEN   # paste the owner token, then Enter
   brake license install acme.license
   ```

The account at app.spendbrake.dev is only the customer record (invoices, card, cancelling);
your install never contacts it. Its Billing page has **Download the latest license** and the
org id licenses are issued for: change it there after a typo or a move to another install, and
the next license names the new id. Each license runs to the end of the month paid for, and every
renewal emails a new one: install it within the 14 days of grace, or the ee features turn
read-only. Cancelling stops the renewals the same way.

Enterprise (invoiced yearly) is arranged with
[support@spendbrake.dev](mailto:support@spendbrake.dev).

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
