#!/usr/bin/env node
// `npx @spend-brake/mcp` is `brake mcp`: the server ships in the CLI, so the two never drift.
process.argv.splice(2, 0, 'mcp');
await import('@spend-brake/cli/dist/brake.cjs');
