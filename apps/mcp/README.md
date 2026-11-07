# @spend-brake/mcp

Web search for AI agents with hard dollar caps. An MCP server with capped `tavily_search` and
`exa_search` tools and a read-only `brake_budget` tool: every search goes through the
[Spend Brake](https://spendbrake.dev) proxy with a virtual key, so the provider key never
reaches the agent and a search that would cross a cap is refused before it is sent.

Preview: two search providers, stdio transport.

## Use it

Replace your Tavily or Exa MCP server entry with:

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

and remove `TAVILY_API_KEY` / `EXA_API_KEY` from the agent's configuration: the provider keys
are stored in Spend Brake. All three variables are required: without `BRAKE_API_URL` the
budget tool would ask `http://localhost:8081`. On a self-hosted install, point `BRAKE_URL` and
`BRAKE_API_URL` at your proxy and admin API. `--tools tavily` (or `exa`) offers one provider only.

## What the agent sees

- Each result carries its `cost` and the `remaining` budget.
- When a cap, a kill switch or the loop breaker stops a search, the tool answers with an error
  that starts with `STOP.` and tells the model not to retry but to ask you.
- A search that gets no answer within 60 s also answers `STOP.`: the proxy may have forwarded
  and charged it, so the model is told to check `brake_budget` rather than retry.
- Any other failed search carries a short excerpt of the provider's error, so the model can fix
  its arguments.
- `brake_budget` lists the caps that apply to the key and what is left; it cannot change them.
- The search tools are annotated as not read-only and not idempotent: each call spends money.

This package runs `brake mcp` from [`@spend-brake/cli`](https://www.npmjs.com/package/@spend-brake/cli).
Docs: [MCP clients](https://docs.spendbrake.dev/agents/#mcp-clients-preview).

Apache-2.0.
