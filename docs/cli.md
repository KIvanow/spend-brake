---
title: CLI
nav_order: 12
description: brake, the Spend Brake command line - setup, agent sessions, capped calls and admin.
---

# CLI

`brake` sets up an install, runs agents inside a budget, makes capped calls and does the admin
work from the shell. Output is one JSON object per call; `--pretty` prints a summary line and
indented data instead.

## Install

Build it from source for now; a published package (`npx @spend-brake/cli`) is coming.

```sh
git clone https://github.com/KIvanow/spend-brake && cd spend-brake
pnpm install && pnpm --filter @spend-brake/cli build   # writes apps/cli/dist/brake.cjs
alias brake="node $PWD/apps/cli/dist/brake.cjs"
brake --help
```

Node 22 or newer. `pnpm --filter @spend-brake/cli build:sea` also builds a single executable,
`apps/cli/dist/brake`, that needs no Node install.

## Configuration

The CLI reads the environment first, then the config `brake init` saved, then local defaults:

| Variable            | What                                         | Default                 |
| ------------------- | -------------------------------------------- | ----------------------- |
| `BRAKE_URL`         | The proxy                                    | `http://localhost:8080` |
| `BRAKE_API_URL`     | The admin API                                | `http://localhost:8081` |
| `BRAKE_KEY`         | A virtual key, for capped calls and sessions |                         |
| `BRAKE_ADMIN_TOKEN` | An admin API token, for admin commands       | the saved token         |
| `BRAKE_SESSION`     | Set by `brake session` inside the session    |                         |

For the hosted service: `BRAKE_URL=https://proxy.spendbrake.dev` and
`BRAKE_API_URL=https://app.spendbrake.dev`.

`brake init` saves the API and proxy URLs and an admin token to
`$XDG_CONFIG_HOME/brake/config.json` (or `~/.config/brake/config.json`), readable only by you.

## brake init

Sets up a new self-hosted install: the org, the Google key, the first virtual key and caps.

```sh
export BRAKE_SETUP_TOKEN=…            # from infra/.env
read -rs GOOGLE_MAPS_KEY && export GOOGLE_MAPS_KEY
brake init --api-url http://localhost:8081 --proxy-url http://localhost:8080 \
  --org acme --day-cap 5 --month-cap 50
```

| Option                | What                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `--api-url <url>`     | Admin API URL                                                    |
| `--proxy-url <url>`   | Proxy URL your apps will call                                    |
| `--setup-token <t>`   | The API's `BRAKE_SETUP_TOKEN` (or env `BRAKE_SETUP_TOKEN`)       |
| `--org <id>`          | Org id, e.g. `acme`                                              |
| `--name <name>`       | Org display name                                                 |
| `--tz <zone>`         | Time zone for daily caps (default `UTC`)                         |
| `--google-key <key>`  | The real Google key, stored encrypted (or env `GOOGLE_MAPS_KEY`) |
| `--egress-ip <ip...>` | The proxy's public egress IPs, for the key restriction steps     |
| `--day-cap <usd>`     | Org hard cap per day                                             |
| `--month-cap <usd>`   | Org hard cap per month                                           |
| `--json`              | Print a JSON result instead of instructions                      |

The URLs, setup token, org id and Google key are asked for when left out. Pass secrets in the environment or at the prompt: flags land in
shell history. `init` prints the owner token and the virtual key once, checks whether the Google
key is restricted, and prints the Google Cloud steps (console and `gcloud`) to restrict it to
the proxy.

## brake session

```sh
brake session --budget 5 --day-budget 20 --agent claude -- claude
```

| Option               | What                                                           | Default                    |
| -------------------- | -------------------------------------------------------------- | -------------------------- |
| `--budget <usd>`     | Spend limit for this session                                   | `5`                        |
| `--day-budget <usd>` | Daily cap for the agent across all its sessions                | `20`                       |
| `--agent <name>`     | Agent id                                                       | the parent key's, or `cli` |
| `--ttl <duration>`   | Session key lifetime, e.g. `30m`, `12h`                        | `12h`                      |
| `--parent-key <id>`  | Parent key id, with `BRAKE_ADMIN_TOKEN` instead of `BRAKE_KEY` |                            |

See [Capping an AI agent](../agents/).

## Capped calls

```sh
brake maps search "pizza in Sofia"            # Text Search, IDs only (free tier)
brake maps nearby --lat 42.69 --lng 23.32     # Nearby Search, Pro fields
brake maps details ChIJ...                    # Place Details, Essentials fields
brake maps geocode "1 Main St, Springfield"
brake maps reverse 42.69 23.32
brake maps route "Sofia" "42.14,24.75" --mode drive
brake search tavily "valkey lua scripting"    # basic depth (1 credit)
brake search exa "agent budgets" --type lite --results 5
brake search brave "spend caps"
brake search serpapi "coffee" --engine bing
brake call google-places POST /v1/places:searchText -d '{"textQuery":"x"}' -H 'X-Goog-FieldMask: places.id'
```

- `brake maps` uses the cheapest field set by default; `--fields <mask>` opts into higher
  (pricier) tiers. `search` takes `--limit`, `nearby` takes `--radius` and `--type`, `route`
  takes `--mode drive|walk|bicycle|transit`.
- `brake search` defaults to each provider's cheapest search. Options: `--results`, `--depth`
  (Tavily), `--type` (Exa), `--engine` (SerpApi, default `google`).
- `brake call <provider> <method> <path>` makes any capped request: `-d` for a JSON body (`@file`
  reads a file), `-q k=v` for query parameters, `-H` for headers.

Each call prints `ok`, `status`, `costMicros`, `cost`, `remainingMicros`, `requestId` and
`data`.

## Admin commands

These use the admin token (`BRAKE_ADMIN_TOKEN` or the saved one).

| Command                                                                        | What                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `brake keys list`                                                              | Virtual keys                                                                                                        |
| `brake keys create --name <n> --credential <provider=credId...>`               | Create a key; also `--env`, `--agent`, `--skus`, `--session-cap`, `--can-mint-sessions`, `--expires`, `--countries` |
| `brake keys show <id>` / `brake keys revoke <id>`                              | Show or revoke a key                                                                                                |
| `brake caps list`                                                              | Caps                                                                                                                |
| `brake caps set <scope> --day 5 --month 50`                                    | Set caps; also `--soft-day`, `--soft-month`                                                                         |
| `brake caps rm <scope> [--kind d\|m]`                                          | Remove caps                                                                                                         |
| `brake kill <target> [--reason <text>]`                                        | Stop all spend for `org`, `key:<id>`, `prov:<name>` or `sess:<id>`                                                  |
| `brake unkill <target>`                                                        | Lift a kill                                                                                                         |
| `brake status [--scope <scope...>]`                                            | Remaining budget: your session and key with `BRAKE_KEY`, or every scope (admin)                                     |
| `brake spend --group-by key,sku --days 30`                                     | Spend from the ledger; also `--from`, `--to`                                                                        |
| `brake estimate [--days 30]`                                                   | What your Google usage would cost on Geoapify, Stadia Maps, Open Places API, Mapbox and HERE                        |
| `brake license install <file>` / `brake license status`                        | Business / Enterprise license (owner token of the licensed org)                                                     |
| `brake reconcile set --table <project.dataset.table> --service-account <file>` | Compare the ledger with Google's billing export daily (Business / Enterprise); also `--project`                     |
| `brake reconcile status` / `brake reconcile report`                            | Reconciliation settings and the daily report                                                                        |

Cap scopes are `org`, `key:<id>`, `sku:<provider>:<sku>`, `env:<name>`, `agent:<id>` and
`sess:<id>`.

## Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Success                                                                |
| 1    | Other failure (provider error, proxy unreachable, session not started) |
| 2    | Bad arguments                                                          |
| 3    | **Stop:** budget exceeded, spending killed, or the route has no price  |
| 4    | **Stop:** loop detected, the key is paused                             |
| 5    | Missing, unknown, revoked or expired virtual key                       |

On 3 and 4, stderr carries one line that tells the agent to stop and ask the user.
