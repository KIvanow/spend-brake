// The service image runs node as PID 1 (no npm or shell in between), so SIGTERM reaches the
// graceful shutdown. scripts/smoke-stack.sh checks the running containers too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const dockerfile = readFileSync(new URL('../../infra/Dockerfile', import.meta.url), 'utf8');

test('the service image starts node directly', () => {
  const cmds = [...dockerfile.matchAll(/^CMD\s+(.+)$/gm)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(cmds, [['/start']]);
  assert.match(dockerfile, /printf '#!\/bin\/sh\\nexec env %s\\n'/);
  assert.doesNotMatch(dockerfile, /npm run/);
});
