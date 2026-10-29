# @spend-brake/api

Admin REST API: provider credentials, virtual keys, caps, kill switch, spend, events, live status,
admin tokens and org settings. The OpenAPI 3.1 spec is generated from the same Zod schemas the
server validates with: `GET /v1/openapi.json`, committed as [`openapi.json`](openapi.json)
(`pnpm --filter @spend-brake/api openapi` regenerates it; a test fails if it drifts).

## Auth and roles

`Authorization: Bearer sbt_…` (org API tokens, stored as SHA-256). Every query is scoped to the
token's org; another org's ids answer 404.

| Role     | Can                                                                   |
| -------- | --------------------------------------------------------------------- |
| `viewer` | Read keys, caps, credentials (no secrets), spend, events, status, org |
| `admin`  | + create/update/revoke keys and credentials, set caps, kill/unkill    |
| `owner`  | + admin tokens and org settings (time zone, provider policy, loop)    |

Bootstrap the first owner token (shown once):

```sh
pnpm --filter @spend-brake/api bootstrap -- --org acme --name "Acme" --tz Europe/Sofia
```

## Writes go to Valkey first

The proxy reads only Valkey. Every change that affects enforcement (keys, caps, kills,
credentials, org settings) is written to Valkey first and then to Postgres, so it applies on the
next request; every change is also written to the audit log with its actor.

On start the API rewrites every proxy record in Valkey from Postgres (orgs, keys, caps,
credentials), so a lost or half-written Valkey heals itself.

Rate limits: per client IP before authentication (4x the token limit), then per token.

Provider secrets are envelope-encrypted (AES-256-GCM data key per credential, wrapped by
`BRAKE_MASTER_KEY` or AWS KMS via `BRAKE_KMS_KEY_ID`), bound to their org and credential id, and
never returned, logged or echoed in errors. Only the last 4 characters are kept for display.

## Configuration (env)

| Variable                | Default                                        |
| ----------------------- | ---------------------------------------------- |
| `PORT`                  | `8081`                                         |
| `DATABASE_URL`          | `postgres://brake:brake@localhost:15432/brake` |
| `VALKEY_URL`            | `redis://localhost:16379`                      |
| `BRAKE_MASTER_KEY`      | 32 bytes, base64 (`openssl rand -base64 32`)   |
| `BRAKE_KMS_KEY_ID`      | KMS key id/alias; takes precedence             |
| `RATE_LIMIT_PER_MINUTE` | `600` per token (or IP)                        |

Migrations run on start.
