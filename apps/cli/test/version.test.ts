import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// The built CLI, exactly what `npx @spend-brake/cli` runs.
const CLI = fileURLToPath(new URL('../dist/brake.cjs', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

it('brake --version is the package version', () => {
  expect(execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).trim()).toBe(
    pkg.version,
  );
});
