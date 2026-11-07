import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Exactly what `npx @spend-brake/mcp` runs.
const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const json = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;

it('serves MCP from the CLI without arguments', async () => {
  const child = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH ?? '' } });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stdin.end(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
  );
  await new Promise((resolve) => child.on('exit', resolve));
  const reply = JSON.parse(out) as { result: { serverInfo: { name: string; version: string } } };
  expect(reply.result.serverInfo).toMatchObject({
    name: 'spend-brake',
    version: json('../../cli/package.json').version,
  });
});

it('keeps its version, the registry entry and the CLI in step', () => {
  const pkg = json('../package.json') as { version: string; mcpName: string };
  const server = json('../server.json') as {
    name: string;
    version: string;
    description: string;
    packages: { identifier: string; version: string }[];
  };
  const cli = json('../../cli/package.json') as { version: string };
  expect(pkg.version).toBe(cli.version);
  expect(server.version).toBe(pkg.version);
  expect(server.packages[0]).toMatchObject({
    identifier: '@spend-brake/mcp',
    version: pkg.version,
  });
  expect(server.name).toBe(pkg.mcpName);
  // The registry's limit.
  expect(server.description.length).toBeLessThanOrEqual(100);
});
