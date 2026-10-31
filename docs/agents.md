---
title: Capping an AI agent
nav_order: 3
description: Run any agent or script inside a session with its own budget, with the brake CLI.
---

# Capping an AI agent

Coding agents already run shell commands, so a capped command needs no extra protocol. Run the
agent inside a `brake session` and give it a budget it cannot talk its way out of.

## Run an agent in a session

Install the [CLI](../cli/) first. Then, with a key that may mint sessions:

```sh
export BRAKE_KEY=sb_live_…   BRAKE_URL=https://proxy.spendbrake.dev   BRAKE_API_URL=https://app.spendbrake.dev
brake session --budget 5 --day-budget 20 --agent claude -- claude
```

On a self-hosted install, point `BRAKE_URL` at your proxy and `BRAKE_API_URL` at your admin API
(for a local install, `http://localhost:8080` and `http://localhost:8081`).

Claude Code (or anything else after `--`) runs with a session key in `BRAKE_KEY` that:

- can spend at most $5 (`--budget`, default $5). This is the session key's own cap, so it holds
  even for clients that swap only the base URL and key;
- counts against the agent's $20 per day (`--day-budget`, default $20) across all its sessions.
  That cap is created the first time the agent spends, and an admin can change it later;
- also counts against the parent key's caps, and stops when the parent key is killed;
- is revoked when the command exits, and expires after `--ttl` (default `12h`) even if `brake`
  itself is killed.

`--agent` names the agent (default: the parent key's agent, or `cli`). When the command exits,
`brake` prints a JSON summary on stderr (`{"brakeSession":{"spent":"$0.0120",...}}`) and exits
with the command's exit code.

Minting a session needs `BRAKE_KEY` set to a key created with `canMintSessions`
(`brake keys create … --can-mint-sessions`), or `BRAKE_ADMIN_TOKEN` plus `--parent-key <id>`.

## Capped calls from inside the agent

Inside the session the agent can call providers through the CLI. Each call prints one JSON
object with the cost:

```sh
brake maps geocode "Vitosha Blvd 1, Sofia"
brake maps search "pizza in Sofia"
brake search tavily "valkey lua scripting"
brake call google-places POST /v1/places:searchText -d '{"textQuery":"x"}' -H 'X-Goog-FieldMask: places.id'
```

Every provider spends from the one session budget. The agent's own HTTP clients work too: they
use the proxy with the session key in `BRAKE_KEY`.

## When the money runs out

When a cap or the loop breaker stops a call, `brake` exits with a code the agent can act on and
prints one line on stderr telling it to stop and ask you:

```
brake: STOP. Spend cap reached for sess:sess_ab12 (cap $5.00). Do not retry; ask the user to raise the cap.
```

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Success                                                                |
| 1    | Other failure (provider error, proxy unreachable, session not started) |
| 2    | Bad arguments                                                          |
| 3    | **Stop:** budget exceeded, spending killed, or the route has no price  |
| 4    | **Stop:** loop detected, the key is paused                             |
| 5    | Missing, unknown, revoked or expired virtual key                       |

Agents that call the proxy over HTTP get the same message in the `message` field of the `402`,
`403` or `429` body.

## Loops

A circuit trips when a key repeats identical requests past the org's loop rule. Inside a
session, a per-minute rule applies too. The caller gets `429 loop_detected` with a retry time,
and you get a `loop` alert with **Kill key** and **Reset circuit** links. The rule is part of
the org settings (`loop` in `PUT /v1/org`: `identical`, `windowSec`, `perMinute`,
`cooldownSec`).

## Keep the admin token away from the agent

Run the agent as a different OS user than the one that ran `brake init` (or with
`XDG_CONFIG_HOME` pointing elsewhere). The agent must not be able to read the saved admin token
in `~/.config/brake/config.json`, or it could lift its own caps. `brake session` warns when it
can.
