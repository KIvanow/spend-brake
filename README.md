# Spend Brake

Hard dollar caps, enforced in real time, for every paid API your apps, test suites and AI agents
call. Spend Brake is a self-hosted egress proxy: swap one base URL and one key, and every request
is priced before it leaves, checked against your caps in one atomic step, and refused with a
clear `402` once a cap would be crossed. Built in: Google Maps Platform (Places, Geocoding,
Routes), Twilio Messaging and Verify, Mapbox, HERE, and the agent search APIs Tavily, Exa, Brave
and SerpApi; any other API can be priced per request with the generic adapter.

You keep your provider account and your own key. The real key never leaves Spend Brake; clients
only ever hold revocable virtual keys.

## 5-minute quickstart

Requirements: Docker, Node 22+ (for the CLI), a Google Maps Platform key.

```sh
git clone https://github.com/KIvanow/spend-break && cd spend-break
cp infra/.env.example infra/.env
# fill in the secrets, e.g.:
sed -i "s|^BRAKE_MASTER_KEY=.*|BRAKE_MASTER_KEY=$(openssl rand -base64 32)|; \
        s|^BRAKE_ACTION_SECRET=.*|BRAKE_ACTION_SECRET=$(openssl rand -base64 32)|; \
        s|^BRAKE_SETUP_TOKEN=.*|BRAKE_SETUP_TOKEN=$(openssl rand -hex 24)|; \
        s|^VALKEY_PASSWORD=.*|VALKEY_PASSWORD=$(openssl rand -hex 24)|; \
        s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" infra/.env

docker compose -f infra/docker-compose.yml up -d --build --wait
```

That starts the proxy (`:8080`), admin API (`:8081`), notifier (`:8082`), dashboard (`:3000`),
worker, Valkey and Postgres. Then set up your org, store the Google key and get a virtual key:

```sh
pnpm install && pnpm --filter @spend-brake/cli build      # or: npx @spend-brake/cli
alias brake="node $PWD/apps/cli/dist/brake.cjs"

# Secrets from the environment (or omit them to be prompted): flags would land in shell history.
export BRAKE_SETUP_TOKEN="$(grep BRAKE_SETUP_TOKEN infra/.env | cut -d= -f2)"
read -rs GOOGLE_MAPS_KEY && export GOOGLE_MAPS_KEY
brake init --api-url http://localhost:8081 --proxy-url http://localhost:8080 \
  --org acme --day-cap 5 --month-cap 50
```

`init` prints the owner token once (keep it in a password manager) and saves an admin token for
the CLI. Valkey and Postgres are only reachable from the other containers.

`brake init` prints your virtual key once, checks whether the Google key is restricted, and
prints the exact Google Cloud steps (console and `gcloud`) to restrict the real key to the
proxy's egress IPs and the Maps APIs, so the proxy is the only path to spend. Then swap the base
URL and key in your app:

```diff
- https://maps.googleapis.com/maps/api/geocode/json?address=Sofia&key=AIza…
+ http://localhost:8080/google-maps/maps/api/geocode/json?address=Sofia&key=sb_live_…

- https://places.googleapis.com/v1/places:searchText     X-Goog-Api-Key: AIza…
+ http://localhost:8080/google-places/v1/places:searchText    X-Goog-Api-Key: sb_live_…
```

Every response carries `X-Brake-Cost-Micros` and `X-Brake-Remaining-Micros`. Past a cap:

```json
HTTP/1.1 402 Payment Required
{"error":"budget_exceeded","message":"Spend cap reached for org. Stop and ask the user to raise the cap.",
 "scope":"org","window":"d:20261029","cap":5000000,"spent":4990000,"resetsAt":"2026-10-30T00:00:00.000Z"}
```

Open the dashboard at http://localhost:3000 with the owner token, or the admin token `brake init`
saved in `~/.config/brake/config.json`.

## Capping an AI agent

Run any agent or script inside a session with its own budget:

```sh
export BRAKE_KEY=sb_live_…   BRAKE_URL=http://localhost:8080   BRAKE_API_URL=http://localhost:8081
brake session --budget 5 --day-budget 20 --agent claude -- claude
```

Claude Code (or anything else) runs with a session key in `BRAKE_KEY` that can spend at most $5,
counts against the agent's $20 per day and the parent key's caps, and is revoked when the agent
exits. Inside, the agent calls `brake maps geocode "…"`, `brake maps search "…"` or
`brake call <provider> <method> <path>`; each prints JSON with the cost. When a cap or the loop
breaker stops a call, `brake` exits 3 or 4 with one line telling the agent to stop and ask you.
See [apps/cli](apps/cli/README.md).

Run the agent as a different OS user than the one that ran `brake init` (or with
`XDG_CONFIG_HOME` pointing elsewhere): the agent must not be able to read the saved admin token,
or it could lift its own caps. `brake session` warns when it can.

## Google's controls vs Spend Brake

|                               | Google Cloud budgets      | Maps Platform quotas                       | Google spend caps                                         | Spend Brake                                                                    |
| ----------------------------- | ------------------------- | ------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Stops spend                   | No, alerts only           | Yes                                        | Yes                                                       | Yes, before the request leaves                                                 |
| Unit                          | Dollars                   | Requests per API per minute/day            | Dollars                                                   | Dollars (micro-dollar exact)                                                   |
| Covers Maps Platform          | Yes                       | Yes                                        | No, per Google's docs at the time of writing; check yours | Yes                                                                            |
| Knows SKU tiers (field masks) | After billing             | No: a $0.04 request counts like a free one | After billing                                             | Yes, priced per field mask                                                     |
| Delay                         | Hours (billing data)      | Real time                                  | Billing data                                              | Real time                                                                      |
| Granularity                   | Project / billing account | Project, per API                           | Billing account                                           | Org, key, SKU, environment, agent, session; day and month                      |
| Loop / runaway detection      | No                        | No                                         | No                                                        | Yes, trips a circuit                                                           |
| Kill switch                   | No                        | Set quota to 0 by hand                     | No                                                        | One call, link or button; immediate                                            |
| Alerts with actions           | Email, Pub/Sub            | No                                         | No                                                        | Webhooks (Slack, Discord, Teams, raw) and email with Kill / Raise / Mute links |

Keep Google's own budgets and quotas on as a backstop.

## Terms of service

Spend Brake is built to stay inside the Google Maps Platform Terms of Service:

- **Bring your own key, always.** Each org uses its own Google key and billing account; Spend
  Brake never resells access or shares a key.
- **No caching to cut billing.** Responses are streamed through, never stored to answer later
  requests. Only Place IDs may be stored indefinitely and geocode coordinates for at most 30 days;
  Spend Brake stores neither, only request metadata (SKU, units, cost, status, a hash).
- **Usage stays visible to Google.** Every request reaches Google with your key.
- **Client-side Maps is out of scope.** The Maps JavaScript API, tiles and client widgets are not
  proxied.

This is not legal advice: have someone read sections 3.2 and 3.3 of the Maps Platform Terms and
the Service Specific Terms before you offer Spend Brake to others as a hosted service.

## How it works

```
app / agent ──▶ proxy ──▶ Google
                 │  1 authenticate the virtual key (cached 5 s)
                 │  2 price: SKU from path + field mask, worst case in micro-dollars
                 │  3 one Lua call: kill switch, loop breaker, reserve against every cap
                 │  4 forward with the real key (decrypted locally, never logged)
                 │  5 settle the actual cost + usage event (one Lua call, background)
                 ▼
               Valkey ──▶ worker ──▶ Postgres ledger, alerts ──▶ notifier ──▶ webhooks / email
```

Overshoot is bounded by one request's worst case. Valkey down means fail closed (`503`) unless a
key opts into a small fail-open allowance.

| Part                                           | What it does                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [apps/proxy](apps/proxy/README.md)             | The request path                                                                                            |
| [apps/api](apps/api/README.md)                 | Admin API (keys, caps, kill, credentials, spend, events, webhooks, sessions); OpenAPI at `/v1/openapi.json` |
| [apps/worker](apps/worker/README.md)           | Ledger, sweeper, alert jobs, partitions, price drift check                                                  |
| [apps/notifier](apps/notifier/README.md)       | Signed webhooks, email, action-link pages                                                                   |
| [apps/cli](apps/cli/README.md)                 | `brake`: init, agent sessions, capped calls, admin                                                          |
| apps/web                                       | Dashboard                                                                                                   |
| [packages/budget](packages/budget/README.md)   | Atomic budgets on Valkey (Lua)                                                                              |
| [packages/catalog](packages/catalog/README.md) | Prices, SKU rules, provider adapters, migration estimator                                                   |
| [packages/db](packages/db/README.md)           | Postgres schema and migrations                                                                              |
| packages/shared                                | Envelope encryption, signing, redaction, telemetry                                                          |

**Migration estimate:** `brake estimate` (or the dashboard) prices your last 30 days of Google
usage on Geoapify, Stadia Maps, Open Places API, Mapbox and HERE side by side, and shows what
would stay on Google.

**Reconciliation:** connect the Google Cloud Billing export (`brake reconcile set --table
project.dataset.table --service-account reader.json`) and the worker compares the ledger with
Google's bill every day, per SKU family; drift above 5% raises an alert. Without it, the
dashboard says spend is measured by the proxy only.

**Tracing:** set `OTEL_EXPORTER_OTLP_ENDPOINT` and the services export OpenTelemetry traces;
secrets are stripped from every span. Prometheus metrics are on `:9465` (proxy) and `:9464`
(worker).

## Development

Requirements: Node 22+, pnpm 10, Docker.

```sh
pnpm install
pnpm dev          # Valkey + Postgres in Docker, then every app in watch mode
pnpm test         # integration tests start their own Valkey/Postgres containers
pnpm lint && pnpm typecheck
```

Valkey listens on `localhost:16379` and Postgres on `localhost:15432` (user/password/db `brake`).
Override with `BRAKE_VALKEY_PORT` / `BRAKE_POSTGRES_PORT`.

## License

Apache-2.0, except `ee/` (commercial license, added later). The spending cap itself is never
paywalled.
