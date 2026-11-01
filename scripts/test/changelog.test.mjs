// The docs site's changelog page is a copy of CHANGELOG.md: GitHub Pages builds Jekyll in safe
// mode, which follows neither `include_relative ../` nor symlinks, so the copy is checked instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('docs/changelog.md carries CHANGELOG.md verbatim after its front matter', () => {
  const page = read('docs/changelog.md');
  const match = /^---\n([\s\S]*?)\n---\n\n/.exec(page);
  assert.ok(match, 'docs/changelog.md starts with front matter');
  assert.match(match[1], /^title: Changelog$/m);
  assert.match(match[1], /^permalink: \/changelog\/$/m);
  assert.equal(
    page.slice(match[0].length),
    read('CHANGELOG.md'),
    'docs/changelog.md differs from CHANGELOG.md; copy CHANGELOG.md below its front matter',
  );
});
