# @spend-brake/db

Drizzle schema and migrations for Postgres 16: `orgs`, `users`, `api_tokens`,
`provider_credentials`, `virtual_keys`, `caps`, `audit_log`, `catalog_checks`, and the
`usage_events` ledger, partitioned by month on `ts` (hand-written migration, since drizzle-kit
cannot generate partitioned tables; `ensure_usage_partition()` creates months ahead of time and a
default partition catches the rest).

```sh
pnpm --filter @spend-brake/db db:generate   # after editing src/schema.ts
```

`migrate(db)` applies migrations; the API and worker run it on start. Apps import query helpers
(`eq`, `and`, `sql`, …) from this package so there is a single drizzle-orm instance.
