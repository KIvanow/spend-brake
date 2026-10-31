---
title: CSV export
nav_order: 10
description: Download requests or the audit log as a CSV file, from the dashboard or GET /v1/events.csv.
---

# CSV export

Download every request, or the audit log, as a CSV file: from **Events** in the dashboard, or
with `GET /v1/events.csv` (any role).

```sh
curl -OJ -H "Authorization: Bearer sbt_…" \
  "https://app.spendbrake.dev/v1/events.csv?from=2026-10-01&to=2026-10-31"
```

## Filters

The export takes the same filters as `GET /v1/events` and returns the same events, newest first:

| Parameter | What                                       |
| --------- | ------------------------------------------ |
| `source`  | `usage` (requests, the default) or `audit` |
| `type`    | One event type                             |
| `keyId`   | One virtual key                            |
| `from`    | Start, inclusive                           |
| `to`      | End, exclusive                             |

## Times

- ISO 8601 with `Z` or an offset (`2026-10-31T09:00:00Z`, `2026-10-31T11:00:00+02:00`; write `+`
  as `%2B` in a URL), or a plain date. A time without `Z` or an offset is refused.
- A plain `from` date starts at 00:00 UTC. A plain `to` date takes in that whole day, up to
  00:00 UTC the next day. So `from=2026-10-01&to=2026-10-31` is all of October (UTC).
- The dashboard's From and To are your browser's local days: it sends From's local midnight and
  the midnight after To, with their offsets.

## The file

- **Name:** `spend-brake-requests-<from>_<to>.csv` (or `spend-brake-audit-…`), by the days as
  written. A `to` at midnight is exclusive, so the name shows the day before. `start` or `now`
  stands in for a bound left out; an export without bounds is named by today's date.
- **Row cap:** at most 100,000 rows, the newest. The `X-Brake-Truncated: true` header says more
  rows matched; export earlier ranges with `to` to get them.
- **Columns:** request rows carry `key_name` (the key's current name) next to `key_id`, the
  outcome, and the cost both in dollars (`cost_usd`, exact) and in micros. Times are UTC.
- **Encoding:** UTF-8 with a byte order mark, so Excel shows names in any script. Excel in
  locales that use `;` as the list separator (de-DE, bg-BG, ...) puts each row in one column when
  you double-click the file; use Data > From Text/CSV and pick comma instead.
- **Spreadsheet safety:** RFC 4180 quoting, CRLF line ends. Text cells starting with `=`, `+`,
  `-`, `@`, a tab or a carriage return get a leading `'`, so they never run as formulas.

How far back you can export depends on how long call history is kept: on the hosted service,
that depends on the plan (see [pricing](https://spendbrake.dev/#pricing)).
