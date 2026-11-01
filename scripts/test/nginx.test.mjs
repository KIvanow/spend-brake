// The dashboard's nginx resolves every upstream per request: a hostname in proxy_pass is looked
// up once at startup, so nginx would fail to start without the API and keep a stale address after
// the API container is recreated.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const conf = readFileSync(new URL('../../infra/nginx.conf', import.meta.url), 'utf8');

test('every proxy_pass goes through a variable, with a resolver', () => {
  const targets = [...conf.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map((m) => m[1]);
  assert.ok(targets.length > 0);
  for (const target of targets) assert.match(target, /^\$\w+$/, `proxy_pass ${target}`);
  assert.match(conf, /^\s*resolver\s+127\.0\.0\.11\b/m);
});

test('the variables carry no URI, so request paths reach the API unchanged', () => {
  for (const [, value] of conf.matchAll(/^\s*set\s+\$\w+\s+([^;]+);/gm)) {
    assert.match(value, /^http:\/\/[\w.-]+:\d+$/, `set ${value}`);
  }
});
