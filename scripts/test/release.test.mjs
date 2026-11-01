// The release workflow publishes nothing the CI checks have not passed on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const load = (name) =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
const ci = load('ci.yml');
const release = load('release.yml');
const needs = (job) => [job.needs ?? []].flat();
const runs = (job) => job.steps.filter((s) => s.run).map((s) => s.run.trim());

test('release runs the same checks as CI', () => {
  assert.deepEqual(runs(release.jobs.check), runs(ci.jobs.check));
  assert.deepEqual(runs(release.jobs.stack), ['scripts/smoke-stack.sh']);
});

test('images and the npm package need the checks', () => {
  for (const job of ['images', 'npm']) {
    for (const check of ['check', 'stack', 'licensing']) {
      assert.ok(needs(release.jobs[job]).includes(check), `${job} needs ${check}`);
    }
  }
});

test('release runs the licensing checks before anything is published', () => {
  const steps = runs(release.jobs.licensing);
  assert.match(steps.join('\n'), /scripts\/check-signoff\.sh "\$previous\.\.\$GITHUB_SHA"/);
  assert.ok(steps.includes('node scripts/check-ee-imports.mjs'));
  assert.ok(runs(ci.jobs.licensing).includes('node scripts/check-ee-imports.mjs'));
  assert.equal(release.jobs.licensing.steps[0].with?.['fetch-depth'], 0, 'needs the tag history');
  for (const job of ['images', 'npm', 'latest', 'release']) {
    assert.ok(needs(release.jobs[job]).includes('licensing'), `${job} needs licensing`);
  }
});

test('latest is tagged only after every image is pushed', () => {
  const build = release.jobs.images.steps.find((s) => s.uses?.startsWith('docker/build-push'));
  assert.doesNotMatch(build.with.tags, /:latest/);
  assert.ok(needs(release.jobs.latest).includes('images'));
  const loop = runs(release.jobs.latest)
    .join('\n')
    .match(/for name in ([^;]+);/);
  assert.ok(loop, 'latest job loops over the image names');
  const tagged = loop[1].trim().split(/\s+/).sort();
  const built = release.jobs.images.strategy.matrix.include.map((m) => m.name).sort();
  assert.deepEqual(tagged, built);
  assert.ok(needs(release.jobs.release).includes('latest'));
});

test('CI starts the whole stack', () => {
  assert.ok(runs(ci.jobs.stack).includes('scripts/smoke-stack.sh'));
});
