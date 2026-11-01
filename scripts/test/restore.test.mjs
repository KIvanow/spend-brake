// scripts/restore.sh refuses a broken backup before it stops or drops anything. Docker is a stub
// that records each call and plays pg_restore: it accepts a file with the custom-format header.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const restore = fileURLToPath(new URL('../restore.sh', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'restore-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

const bin = join(work, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'docker'),
  `#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$*" in
  *"config --services"*) printf 'valkey\\npostgres\\napi\\nproxy\\n' ;;
  *"pg_restore --list"*) [ "$(head -c 5)" = PGDMP ] ;;
  *) exit 0 ;;
esac
`,
);
chmodSync(join(bin, 'docker'), 0o755);

let n = 0;
function run({ dump, rdb }) {
  const dir = join(work, `backup-${++n}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'postgres.dump'), dump);
  writeFileSync(join(dir, 'valkey.rdb'), rdb);
  const log = join(dir, 'docker.log');
  writeFileSync(log, '');
  const result = spawnSync('bash', [restore, dir], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log, NO_START: '1' },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr, calls: readFileSync(log, 'utf8') };
}

const goodDump = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 1)]);
const goodRdb = Buffer.concat([Buffer.from('REDIS0011'), Buffer.alloc(64, 1)]);

test('a garbage dump is refused before anything stops or is dropped', () => {
  const r = run({ dump: 'not a dump at all', rdb: goodRdb });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /postgres\.dump/);
  assert.doesNotMatch(r.calls, /dropdb|createdb| stop /);
});

test('an empty or garbage Valkey snapshot is refused before anything stops', () => {
  for (const rdb of ['', 'garbage snapshot']) {
    const r = run({ dump: goodDump, rdb });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.calls, /dropdb|createdb| stop /);
  }
});

test('a valid-looking backup is restored', () => {
  const r = run({ dump: goodDump, rdb: goodRdb });
  assert.equal(r.status, 0, r.stderr);
  const calls = r.calls.split('\n');
  const list = calls.findIndex((c) => c.includes('pg_restore --list'));
  const drop = calls.findIndex((c) => c.includes('dropdb'));
  assert.ok(list >= 0 && drop > list, 'validates the dump before dropping the database');
});
