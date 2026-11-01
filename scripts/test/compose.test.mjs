// Production properties of the Compose stack: bounded resources, pinned images, local-only ports
// and a Valkey that never evicts spend.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const load = (name) =>
  parse(read(`infra/${name}`), { customTags: [{ tag: '!reset', resolve: (v) => v }] });
const base = load('docker-compose.yml');
const tls = load('docker-compose.tls.yml');
const hosted = load('docker-compose.hosted.yml');

// Each service the files define (not the ones an overlay only adjusts).
const services = [
  ...Object.entries(base.services),
  ['caddy', tls.services.caddy],
  ['billing', hosted.services.billing],
];

const defaultOf = (value, name) => {
  const m = String(value).match(/^\$\{(BRAKE_\w+):-([^}]+)\}$/);
  assert.ok(m, `${name}: ${value} is an overridable default`);
  return m[2];
};
const bytes = (size) => {
  const m = size.match(/^(\d+)([MG])$/);
  assert.ok(m, `size ${size}`);
  return Number(m[1]) * (m[2] === 'G' ? 1024 : 1);
};

test('every service has memory and CPU limits that fit a 4 GB host', () => {
  let totalMb = 0;
  for (const [name, service] of services) {
    const limits = service.deploy?.resources?.limits;
    assert.ok(limits?.memory && limits?.cpus, `${name} has memory and CPU limits`);
    totalMb += bytes(defaultOf(limits.memory, name));
    const cpus = Number(defaultOf(limits.cpus, name));
    // Docker refuses a CPU limit above the host's CPU count: stay within one CPU.
    assert.ok(cpus > 0 && cpus <= 1, `${name} cpus ${cpus}`);
  }
  assert.ok(totalMb <= 3072, `default limits add up to ${totalMb} MB`);
});

test('Valkey has a memory ceiling and never evicts', () => {
  const command = base.services.valkey.command.join(' ');
  assert.match(command, /--maxmemory \$\{VALKEY_MAXMEMORY:-\d+mb\}/);
  assert.match(command, /--maxmemory-policy noeviction/);
});

test('published ports listen on 127.0.0.1 by default', () => {
  for (const [name, service] of Object.entries(base.services)) {
    for (const port of service.ports ?? []) {
      assert.match(port, /^\$\{BRAKE_BIND_ADDRESS:-127\.0\.0\.1\}:\d+:\d+$/, `${name} ${port}`);
    }
  }
});

test('base images are pinned by digest', () => {
  const pinned = /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/;
  for (const file of ['docker-compose.yml', 'docker-compose.tls.yml', 'docker-compose.dev.yml']) {
    for (const [name, service] of Object.entries(load(file).services)) {
      if (service.image) assert.match(service.image, pinned, `${file} ${name}`);
    }
  }
  for (const file of ['infra/Dockerfile', 'infra/web.Dockerfile']) {
    const froms = [...read(file).matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    assert.ok(froms.length > 0);
    for (const image of froms) assert.match(image, pinned, `${file} FROM ${image}`);
  }
  const restoreImages = [...read('scripts/restore.sh').matchAll(/valkey\/valkey:\S+/g)];
  for (const [image] of restoreImages) assert.match(image, pinned, `restore.sh ${image}`);
});

test('the billing service is configured for test or live keys, and documented', () => {
  const env = hosted.services.billing.environment;
  assert.match(env.STRIPE_SECRET_KEY, /sk_test_.*sk_live_.*BILLING_LIVE_MODE/);
  assert.match(env.BILLING_LIVE_MODE, /^\$\{BILLING_LIVE_MODE:-false\}$/);
  const docs = read('docs/configuration.md');
  const vars = [...read('apps/billing/src/config.ts').matchAll(/^ {2}([A-Z_]+): z\./gm)];
  assert.ok(vars.length > 5);
  for (const [, name] of vars) assert.ok(docs.includes(`\`${name}\``), `${name} documented`);
  assert.match(docs, /## Hosted billing[\s\S]*`BILLING_LIVE_MODE`/);
});
