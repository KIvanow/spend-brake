# @spend-brake/ee

Business and Enterprise features. Licensed under [`LICENSE-EE`](../LICENSE-EE), not Apache-2.0.
Nothing outside this directory imports from it (CI checks): the core runs, and enforces caps,
with or without it.

## Running

Run the API and worker from here instead of `apps/api` and `apps/worker`; everything else (proxy,
notifier, dashboard) is the same.

```sh
pnpm --filter @spend-brake/ee start:api      # node ee/dist/main-api.js
pnpm --filter @spend-brake/ee start:worker   # node ee/dist/main-worker.js
# Docker: docker compose -f infra/docker-compose.yml -f infra/docker-compose.ee.yml up -d --build
```

Both run the core migrations, then their own (`ee/drizzle`, tracked in
`__drizzle_migrations_ee`). With no license installed they behave exactly like the core
services; the ee endpoints answer `403 license_required`.

## License

A license is a JSON file: an Ed25519 signature over its payload (`id`, `org`, `edition`,
`features`, `orgUnits`, `issuedAt`, `expiresAt`). It is verified offline against the public key
built into `src/license/keys.ts`, on install and on every load; there is no phone-home. Install
it with an owner token of the org it names:

```sh
brake license install acme.license
brake license status
```

| State   | When                       | ee features                                                 |
| ------- | -------------------------- | ----------------------------------------------------------- |
| active  | before `expiresAt`         | Everything the license lists                                |
| grace   | up to 14 days after expiry | Everything the license lists                                |
| expired | after the grace period     | Read-only: reads work, changes answer `403 license_expired` |
| missing | no valid license           | None (`403 license_required`); core features as always      |

Issuing licenses needs the private key, which never enters this repository:

```sh
pnpm --filter @spend-brake/ee sign-license -- --key /secure/license-ed25519.pem \
  --org acme --edition business --months 12 --org-units 3 > acme.license
```

## Features

| Feature (`features[]`) | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sso`                  | OIDC (authorization code + PKCE, nonce) or SAML 2.0 (signed assertions, each accepted once). `PUT /v1/sso` maps IdP groups to roles; users with no mapped group are refused unless a default role is set; `allowedDomains` limits email domains. Login: `GET /v1/sso/{orgId}/login`. The user gets an 8-hour API token in the dashboard URL fragment. Needs `BRAKE_PUBLIC_API_URL` and `BRAKE_DASHBOARD_URL`. Two tokens of one person count as one person (actor `user:<id>`). |
| `rbac`                 | Roles beyond owner/admin/viewer: `operator` (kill switch, keys), `billing` (caps, approvals, reconciliation settings), `auditor` (audit export, token list). `POST /v1/roles/tokens`, or through SSO groups. These tokens are viewer tokens to the core, so without a license they are exactly that.                                                                                                                                                                            |
| `approvals`            | `PUT /v1/approvals/policy {"capApprovals": true}`: raising or removing a hard cap (API, dashboard or alert link) creates a request (`pending` in the response) that someone other than the requester approves (`POST /v1/approvals/{id}/approve`) within 24 h. Lowering and new caps apply at once. Once the license is read-only, raises apply directly again: an expired license never locks an org into its caps.                                                            |
| `audit_export`         | `GET /v1/audit/export` (JSON Lines, paged by `X-Next-Cursor`). The worker ships every org's audit log to `BRAKE_AUDIT_FILE`, S3 (`BRAKE_AUDIT_S3_BUCKET`, `_PREFIX`, `_REGION`, `_ENDPOINT`) and/or syslog (`BRAKE_AUDIT_SYSLOG=udp://host:514` or `tcp://`, RFC 5424, facility log audit), each with its own cursor, at least once (dedupe on `id`).                                                                                                                           |
| `multi_org`            | Owners of the licensed org create more orgs (`POST /v1/orgs`, each with its own owner token) up to `orgUnits`.                                                                                                                                                                                                                                                                                                                                                                  |
| `catalog_feed`         | The worker fetches a signed catalog bundle daily from `BRAKE_CATALOG_FEED_URL`, verifies it against the feed key in `src/license/keys.ts`, checks every file parses, refuses older bundles, writes it as a new version under `BRAKE_CATALOG_DIR` and switches `current` with one rename. The proxy reloads within 30 s. Price changes raise a `catalog_price_change` operator alert.                                                                                            |
| `reconciliation`       | Billing-export reconciliation: Google Cloud Billing export (BigQuery) and Twilio Usage Records vs the ledger, `reconcile_drift` above 5% (see the worker README for the method).                                                                                                                                                                                                                                                                                                |

How it plugs in: `eeApi()` is an `ApiDeps.extensions` entry that adds routes and sets the core's
`authorize` and `holdCapRaise` hooks; `eeJobs()` adds worker loops through `WorkerDeps.jobs`.
