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

`--agent` names the agent (default: the parent key's agent, or `cli`; a key that has an agent
mints sessions for that agent only, so its agent caps always apply). When the command exits,
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

| Code | Meaning                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                                                        |
| 1    | Other failure (provider error, proxy unreachable, session not started)                                                                         |
| 2    | Bad arguments                                                                                                                                  |
| 3    | **Stop:** budget exceeded, spending killed, the route has no price, or the provider timed out (it may have been charged: do not retry blindly) |
| 4    | **Stop:** loop detected, the key is paused                                                                                                     |
| 5    | Missing, unknown, revoked or expired virtual key                                                                                               |

Agents that call the proxy over HTTP get the same message in the `message` field of the `402`,
`403` or `429` body.

## Loops

A circuit trips when a key repeats identical requests past the org's loop rule. Inside a
session, a per-minute rule applies too. The caller gets `429 loop_detected` with a retry time,
and you get a `loop` alert with **Kill key** and **Reset circuit** links. The rule is part of
the org settings (`loop` in `PUT /v1/org`: `identical`, `windowSec`, `perMinute`,
`cooldownSec`).

## Keep the admin token away from the agent

Run the agent as a different OS user than the one that ran `brake init`. The agent must not be
able to read the saved admin token in `~/.config/brake/config.json`, or it could lift its own
caps. Pointing `XDG_CONFIG_HOME` elsewhere is not enough: it hides the file from `brake`, not from
an agent running as the same user. `brake session` warns when the agent can read the token.

## Check the workload with brake doctor

A cap only holds for the calls that go through the proxy with a capped key. `brake doctor`
looks for the usual ways around that, from the agent's own point of view, so run it as the
agent's user, in its working directory and environment:

```sh
brake session -- brake doctor --pretty     # what a session hands the agent
brake doctor --prove --pretty              # with a key that may mint sessions
```

It fails on a missing, revoked, killed or uncapped key (a budget per `X-Brake-Session` alone is
no cap: the client names the session, so it can start a fresh one; a key that may mint sessions
needs a cap on the key itself, since each session it mints brings its own budget), a
`BRAKE_SESSION` the proxy
would refuse, unpriced routes charged $0, an admin token the agent can read (in the environment
or the saved config), and raw provider keys (`TAVILY_API_KEY`, `GOOGLE_MAPS_KEY`, …) in the
environment or in `./.env*` files, which let the agent call the provider directly; placeholders
such as `your_key_here` are skipped. It warns on a generic Google API key (`GOOGLE_API_KEY`,
`AIza…`): it may be for Gemini, but one that can also call Maps goes around the proxy, so
restrict it in Google Cloud. It also warns on a second virtual key, plain HTTP to a remote host,
some of the key's providers killed, fail-open keys, keys that never expire, keys with many
providers, and providers whose unpriced routes are forwarded at a default price. Secrets are
named, never printed.

`--prove` mints a $0, 60-second session from the key and sends one priced request with it. The
proxy must refuse it with `402 budget_exceeded` before it contacts the provider; the session is
then ended, having spent nothing. The API marks a $0 session of up to five minutes as a probe:
its caps, lifetime and fail-open can never change, so it cannot spend, and it does not count
toward a plan's agent sessions. `--prove` can run on every deploy (it still needs a plan whose
payment has gone through and whose monthly requests are not used up). Killed providers are
skipped, and a provider the proxy refuses for another reason first (killed, unpriced) makes
doctor try the next. The repository runs the same probe against a counting mock provider and
checks it receives no request (`apps/cli/test/e2e.test.ts`).

Doctor exits 1 when a check fails, and also when it could not read the key's caps, its policy
or a `.env` file, when the
workload can read another virtual key (whose caps it did not check) or, with `--prove`, when it
could not complete the probe: it exits 0 only for what it actually saw. A session key, or a key
that may not mint sessions, cannot run the probe, so run `--prove` with the parent key. A clean
report is not a guarantee: it always lists what a client cannot see, such as HTTP clients that
skip the proxy, credentials kept elsewhere, the org-wide cap, and network egress. Blocking the
providers' own hosts at the firewall is what makes the proxy the only way out.

## MCP clients (preview)

Agents that search through an MCP server can use Spend Brake's,
[`@spend-brake/mcp`](https://www.npmjs.com/package/@spend-brake/mcp), instead of the Tavily or Exa
server. It offers `tavily_search`, `exa_search` and a read-only `brake_budget`, and sends every
search through the proxy with the virtual key, so the provider key never reaches the agent.
Replace the existing entry:

```json
{
  "mcpServers": {
    "search": {
      "command": "npx",
      "args": ["-y", "@spend-brake/mcp"],
      "env": {
        "BRAKE_KEY": "sb_live_…",
        "BRAKE_URL": "https://proxy.spendbrake.dev",
        "BRAKE_API_URL": "https://app.spendbrake.dev"
      }
    }
  }
}
```

and remove `TAVILY_API_KEY` / `EXA_API_KEY` from the agent's configuration. For a budget per
MCP connection, start it in a session: `"args": ["-y", "@spend-brake/cli", "session",
"--budget", "2", "--", "npx", "-y", "@spend-brake/mcp"]`. `--tools tavily` (or `exa`)
offers one provider only. With the CLI installed, `brake mcp` is the same server.

Each result carries its `cost` and the `remaining` budget. When a cap stops a search the tool
answers with an error that starts with `STOP.` and tells the model not to retry. So does a
search with no answer within 60 s, or one the provider did not answer in time behind the proxy
(`504 upstream_timeout`): it may have been forwarded and charged, so the model is told the
charge and to check `brake_budget` before searching again. Other failures carry a short excerpt
of the provider's error, and the charge when there was one. The search tools are annotated as neither read-only nor idempotent.
`BRAKE_API_URL` is required: without it `brake_budget` asks `http://localhost:8081`.
