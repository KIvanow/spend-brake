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
  // Platform images are pushed by digest only; merge tags the version, latest moves last.
  assert.equal(build.with.tags, undefined);
  assert.match(build.with.outputs, /push-by-digest=true/);
  assert.ok(needs(release.jobs.merge).includes('images'));
  assert.ok(needs(release.jobs.latest).includes('merge'));
  const loop = runs(release.jobs.latest)
    .join('\n')
    .match(/for name in ([^;]+);/);
  assert.ok(loop, 'latest job loops over the image names');
  const tagged = loop[1].trim().split(/\s+/).sort();
  const built = release.jobs.images.strategy.matrix.image.map((m) => m.name).sort();
  assert.deepEqual(tagged, built);
  assert.deepEqual([...release.jobs.merge.strategy.matrix.name].sort(), built);
  assert.ok(needs(release.jobs.release).includes('latest'));
});

test('every image is built for amd64 and arm64 and attested', () => {
  const arches = release.jobs.images.strategy.matrix.platform.map((p) => p.arch).sort();
  assert.deepEqual(arches, ['amd64', 'arm64']);
  assert.ok(
    release.jobs.merge.steps.some((s) => s.uses?.startsWith('actions/attest-build-provenance')),
  );
  assert.equal(release.jobs.merge.permissions?.attestations, 'write');
});

test('CI starts the whole stack', () => {
  assert.ok(runs(ci.jobs.stack).includes('scripts/smoke-stack.sh'));
});
