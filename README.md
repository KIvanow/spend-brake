# Spend Brake

Self-hostable egress proxy that enforces hard dollar caps, in real time, on paid third-party APIs
called by apps, test suites and AI agents. v1 covers Google Maps Platform.

> Status: early development. Nothing here is usable yet.

## Development

Requirements: Node 22+, pnpm 10, Docker.

```sh
pnpm install
pnpm dev          # starts Valkey + Postgres via Docker, then every app in watch mode
pnpm test
pnpm lint && pnpm typecheck
```

| App             | Port |
| --------------- | ---- |
| `apps/proxy`    | 8080 |
| `apps/api`      | 8081 |
| `apps/notifier` | 8082 |
| `apps/billing`  | 8083 |
| `apps/web`      | 5173 |

Valkey listens on `localhost:16379` and Postgres on `localhost:15432` (user/password/db `brake`).
Override with `BRAKE_VALKEY_PORT` / `BRAKE_POSTGRES_PORT`.

## License

Apache-2.0, except `ee/` (commercial license, added later).
