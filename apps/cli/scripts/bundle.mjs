// One self-contained CommonJS file with every dependency inlined: what `npx @spend-brake/cli`
// runs, and the input of the single-executable build.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/brake.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  // `brake --version` is the published version, never a constant to keep in step.
  define: { __BRAKE_VERSION__: JSON.stringify(version) },
});
