# @spend-brake/mcp

Capped calls for AI agents, and a separate admin server, over MCP. The spend server offers
Tavily, Exa, Brave and SerpApi search, the Google Maps commands, `brake_call` for the other
priced APIs, and a read-only `brake_budget`. Every call goes through the
[Spend Brake](https://spendbrake.dev) proxy with a virtual key, so the provider key never
reaches the agent and a call that would cross a cap is refused before it is sent.

Preview. stdio only. `brake mcp --admin` is a second process for the dashboard API; it is not
combined with the spend tools.

## Use it

Replace a Tavily or Exa MCP server entry, or add one:

```json
{
  "mcpServers": {
    "spend-brake": {
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

and remove `TAVILY_API_KEY` / `EXA_API_KEY` from the agent's configuration: the provider keys
are stored in Spend Brake. `BRAKE_KEY`, `BRAKE_URL` and `BRAKE_API_URL` are required for the
spend server: without `BRAKE_API_URL` the budget tool would ask `http://localhost:8081`. On a
self-hosted install, point `BRAKE_URL` and `BRAKE_API_URL` at your proxy and admin API.
`--tools tavily,exa` is the previous search-only set. `--tools tavily` (or `exa`, `brave`,
`serpapi`, `maps`, `call`) offers one group.

Admin is its own entry, with `BRAKE_ADMIN_TOKEN` and no virtual key. Add `--owner` for tokens,
people, SSO, the license and orgs:

```json
{
  "mcpServers": {
    "spend-brake-admin": {
      "command": "npx",
      "args": ["-y", "@spend-brake/mcp", "--admin"],
      "env": {
        "BRAKE_ADMIN_TOKEN": "sbt_…",
        "BRAKE_API_URL": "https://app.spendbrake.dev"
      }
    }
  }
}
```

## What the agent sees

- Each result carries its `cost` and the `remaining` budget.
- When a cap, a kill switch or the loop breaker stops a call, the tool answers with an error
  that starts with `STOP.` and tells the model not to retry and not to switch tools.
- A call that gets no answer within 60 s also answers `STOP.`: the proxy may have forwarded
  and charged it, so the model is told to check `brake_budget` rather than retry.
- Any other failed call carries a short excerpt of the provider's error, so the model can fix
  its arguments.
- `brake_budget` lists the caps that apply to the key and what is left; it cannot change them.
- The named search and maps tools default to the cheap SKUs. `brake_call` can select an
  expensive one.
- The spend tools are annotated as not read-only and not idempotent: each call spends money.
- On the admin server, a result with `pending` is waiting for a second person and is not
  applied. A new key, session, token or webhook shows its secret once.
- Tools that loosen spend safety (raising a cap, resuming a paused key, org pricing policy,
  SSO, roles, licenses) and `brake_call` are annotated destructive, so a client that asks
  before such tools asks for these. So are `telemetry_set` and `custom_apis_update`: stored
  collector headers and provider keys go to their endpoint, so a new host needs the headers
  given again, or `moveOrigin: true` for a custom API.

This package runs `brake mcp` from [`@spend-brake/cli`](https://www.npmjs.com/package/@spend-brake/cli).
Docs: [MCP clients](https://docs.spendbrake.dev/agents/#mcp-clients-preview).

Apache-2.0.
