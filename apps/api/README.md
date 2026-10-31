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

## CSV export

`GET /v1/events.csv` (viewer) downloads the same events as `/v1/events`, newest first, with the
same filters: `source` (`usage`, the default, or `audit`), `type`, `keyId`, and the time bounds
`from` (inclusive) and `to` (exclusive). Both endpoints take `from`/`to`.

- **Times:** ISO 8601 with `Z` or an offset (`2026-10-31T09:00:00Z`,
  `2026-10-31T11:00:00+02:00`; write `+` as `%2B` in a URL), or a plain date. A plain `from` date
  starts at 00:00 UTC; a plain `to` date takes in that whole day, up to 00:00 UTC the next day.
  So `from=2026-10-01&to=2026-10-31` is all of October (UTC). A time without `Z` or an offset is
  refused. The dashboard's From / To are the browser's local days: it sends From's local
  midnight and the midnight after To, with their offsets.
- **File name:** `spend-brake-requests-<from>_<to>.csv` (or `-audit-`) for a range, by the days
  as written; a `to` at midnight is exclusive, so the name shows the day before. `start` or
  `now` stands in for a bound left out, and an export without bounds is named by today's date.

- **Row cap:** one export holds at most 100,000 rows (the newest). The `X-Brake-Truncated: true`
  header says more rows matched; export earlier ranges with `to` to get them.
- **Columns:** request rows carry `key_name` (the key's current name) next to `key_id`, the
  outcome, and the cost both in dollars (`cost_usd`, exact) and in micros. Times are UTC.
- **Encoding:** UTF-8 with a byte order mark, so Excel shows names in any script. Excel in
  locales that use `;` as the list separator (de-DE, bg-BG, ...) puts each row in one column
  when you double-click the file; use Data > From Text/CSV and pick comma instead.
- **Spreadsheet safety:** RFC 4180 quoting, CRLF line ends. Text cells starting with `=`, `+`,
  `-`, `@`, a tab or a carriage return get a leading `'`, so they never run as formulas.

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
