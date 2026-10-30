// Nothing outside ee/ may depend on ee/: the Apache-2.0 core must build and run without it.
// Fails on any import or require of @spend-brake/ee or of a path inside ee/, and on any
// package.json outside ee/ that lists @spend-brake/ee.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const ee = join(root, 'ee') + sep;
const SKIP = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage']);
const SOURCE = /\.(c|m)?(t|j)sx?$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const problems = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || (dir === root && name === 'ee')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (SOURCE.test(name)) checkSource(path);
    else if (name === 'package.json') checkPackage(path);
  }
}
function checkSource(path) {
  const text = readFileSync(path, 'utf8');
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[1];
    const intoEe =
      spec === '@spend-brake/ee' ||
      spec.startsWith('@spend-brake/ee/') ||
      (spec.startsWith('.') && resolve(dirname(path), spec).startsWith(ee));
    if (intoEe) problems.push(`${relative(root, path)} imports ${spec}`);
  }
}
function checkPackage(path) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    if (pkg[field]?.['@spend-brake/ee'])
      problems.push(`${relative(root, path)} depends on @spend-brake/ee`);
  }
}

walk(root);
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error('Code outside ee/ must not depend on ee/ (see CONTRIBUTING.md).');
  process.exit(1);
}
console.log('No imports from ee/ outside ee/.');
