// scripts/restore.sh refuses a broken backup before it stops or drops anything. Docker is a stub
// that records each call and plays pg_restore: --list accepts a file with the custom-format
// header, a full restore also fails on a dump that ends early (here: ends in TRUNCATED).
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
  *"pg_restore "*) [ "$(tail -c 9)" != TRUNCATED ] ;;
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

test('a dump with a corrupt data section fails in a scratch database; brake is untouched', () => {
  const r = run({ dump: Buffer.concat([goodDump, Buffer.from('TRUNCATED')]), rdb: goodRdb });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nothing was changed/);
  const calls = r.calls.split('\n');
  const restore = calls.find((c) => /pg_restore .*-d brake_restore_\d+/.test(c));
  assert.ok(restore, 'restores into a scratch database');
  const scratch = restore.match(/brake_restore_\d+/)[0];
  assert.ok(
    calls.some((c) => c.includes('dropdb') && c.endsWith(` ${scratch}`)),
    'drops it',
  );
  assert.doesNotMatch(r.calls, /dropdb.* brake$|RENAME| stop /m);
});

test('a valid-looking backup is restored into a scratch database, then swapped in', () => {
  const r = run({ dump: goodDump, rdb: goodRdb });
  assert.equal(r.status, 0, r.stderr);
  const calls = r.calls.split('\n');
  const at = (re) => calls.findIndex((c) => re.test(c));
  const list = at(/pg_restore --list/);
  const restore = at(/pg_restore .*-d brake_restore_\d+/);
  const stop = at(/ stop api proxy/);
  const swap = at(/RENAME TO brake;/);
  assert.ok(list >= 0 && restore > list, 'validates the dump before restoring it');
  assert.ok(stop > restore, 'stops the services only once the restore worked');
  assert.ok(swap > stop, 'swaps the databases with the services stopped');
  assert.doesNotMatch(r.calls, /dropdb.* brake$/m, 'never drops brake before the swap');
  assert.ok(at(/dropdb .* brake_old_\d+$/) > swap, 'drops the previous database afterwards');
  assert.ok(at(/ start valkey$/) > at(/ stop valkey$/), 'NO_START=1 still leaves Valkey up');
});
