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

| Feature (`features[]`) | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sso`                  | OIDC (authorization code + PKCE, nonce; `email_verified` must be true unless `requireVerifiedEmail: false`) or SAML 2.0 (signed assertions answering this service's own request, each accepted once). The login is bound to the browser that started it by an HttpOnly cookie (SameSite=None; Secure over HTTPS, which the SAML POST needs). `PUT /v1/sso` checks the issuer and maps IdP groups to roles; users in no mapped group are refused unless a default role is set; `allowedDomains` limits email domains. Login: `GET /v1/sso/{orgId}/login`; the user gets an 8-hour API token in the dashboard URL fragment. A login with a different role ends the person's earlier tokens; changing or removing SSO ends every token it issued. Needs `BRAKE_PUBLIC_API_URL` and `BRAKE_DASHBOARD_URL`. Requests to the OIDC issuer (discovery, token endpoint, JWKS) refuse private addresses unless `ALLOW_PRIVATE_IDP=true` (an IdP inside your network). |
| `rbac`                 | Roles beyond owner/admin/viewer: `operator` (kill switch, revoking keys; not creating or editing keys, which carry budgets and credentials), `billing` (caps, reconciliation settings), `auditor` (audit export, token list). `POST /v1/roles/tokens`, or through SSO groups. These tokens are viewer tokens to the core, so without a license they are exactly that.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `approvals`            | Two-person rule between people the IdP knows, so it needs SSO: `PUT /v1/approvals/policy {"capApprovals": true}` (owner, SSO configured). Then raising or removing a hard cap is requested by a person signed in with SSO and creates a request (`pending` in the response, the dashboard's Approvals page) that a different person approves (`POST /v1/approvals/{id}/approve`) within 24 h. Plain API tokens name no person (any owner can mint more), so they can neither request nor approve; alert-link raises are refused. Lowering and new caps apply at once. Switching the rule off is itself a request another owner approves, and SSO cannot be changed or removed while it is on. Once the license is read-only, raises apply directly again: an expired license never locks an org into its caps.                                                                                                                                              |
| `audit_export`         | `GET /v1/audit/export` (JSON Lines, paged by `X-Next-Cursor`). The worker ships every org's audit log to `BRAKE_AUDIT_FILE`, S3 (`BRAKE_AUDIT_S3_BUCKET`, `_PREFIX`, `_REGION`, `_ENDPOINT`) and/or syslog (`BRAKE_AUDIT_SYSLOG=udp://host:514` or `tcp://`, RFC 5424, facility log audit; a record too large for a datagram keeps everything but `data`), each with its own cursor. Only rows of transactions older than every running one are read, so a late commit is never skipped. File and S3 delivery is at least once (dedupe on `id`); syslog has no acknowledgement, so a record counts as sent once the network stack takes it. Shipping keeps going while the license is read-only.                                                                                                                                                                                                                                                            |
| `multi_org`            | Owners of the licensed org create more orgs (`POST /v1/orgs`, each with its own owner token) up to `orgUnits`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `catalog_feed`         | The worker fetches a signed catalog bundle daily from `BRAKE_CATALOG_FEED_URL` (16 MB at most), verifies it against the feed key in `src/license/keys.ts`, refuses older bundles (by the database record and the live directory) and ones dated more than a day ahead, copies the version in use, lays the bundle's files over it (a bundle may carry only what changed), loads every catalog from the result with the services' own loaders, then switches `current` with one rename. One worker applies at a time. The proxy reloads within 30 s, and falls back to the bundled prices at boot if an installed version does not load. Every changed price (Twilio included) is listed in a `catalog_price_change` operator alert.                                                                                                                                                                                                                         |
| `reconciliation`       | Billing-export reconciliation: Google Cloud Billing export (BigQuery) and Twilio Usage Records vs the ledger, `reconcile_drift` above 5% (see the worker README for the method).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

How it plugs in: `eeApi()` is an `ApiDeps.extensions` entry that adds routes and sets the core's
`authorize` and `holdCapRaise` hooks; `eeJobs()` adds worker loops through `WorkerDeps.jobs`.
