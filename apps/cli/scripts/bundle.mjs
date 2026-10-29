// One self-contained CommonJS file with every dependency inlined: what `npx @spend-brake/cli`
// runs, and the input of the single-executable build.
import { build } from 'esbuild';

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
});
