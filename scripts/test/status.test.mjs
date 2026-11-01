// The status workflow's logic (scripts/status/lib.mjs): what counts as up, how status.json rolls
// forward, and when incident issues are opened and closed. Fake inputs only, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  KEEP_DAYS,
  SERVICES,
  evaluate,
  planIncidents,
  toIncidents,
  updateStatus,
} from '../status/lib.mjs';

const api = SERVICES.find((s) => s.id === 'api');
const proxy = SERVICES.find((s) => s.id === 'proxy');
const at = (iso) => new Date(iso);
const allUp = (checkedAt) =>
  SERVICES.map((s) => ({ id: s.id, up: true, latencyMs: 120, error: null, checkedAt }));
const withDown = (id, checkedAt, error = 'HTTP 502 (expected 200)') =>
  allUp(checkedAt).map((r) => (r.id === id ? { ...r, up: false, error } : r));

test('a service is up on a 200, and the API only with a JSON body', () => {
  assert.deepEqual(evaluate(proxy, { code: 200, body: 'ok' }), { up: true, error: null });
  assert.equal(evaluate(proxy, { code: 503, body: '' }).up, false);
  assert.match(evaluate(proxy, { code: 301, body: '' }).error, /HTTP 301/);
  assert.deepEqual(evaluate(proxy, { code: 0, body: '', error: 'Operation timed out' }), {
    up: false,
    error: 'Operation timed out',
  });
  assert.equal(evaluate(api, { code: 200, body: '{"signup":true}' }).up, true);
  assert.match(evaluate(api, { code: 200, body: '<html>' }).error, /not JSON/);
});

test('the first run starts a fresh file', () => {
  const s = updateStatus(null, allUp('2026-11-01T10:00:00Z'), at('2026-11-01T10:00:05Z'));
  assert.equal(s.updatedAt, '2026-11-01T10:00:05.000Z');
  assert.deepEqual(
    s.services.map((x) => x.id),
    SERVICES.map((x) => x.id),
  );
  assert.deepEqual(s.days['2026-11-01'].proxy, { checks: 1, up: 1 });
  assert.deepEqual(s.incidents, []);
  // A garbled previous file is treated as missing.
  assert.deepEqual(
    updateStatus('nonsense', allUp('x'), at('2026-11-01T10:00:00Z')).days['2026-11-01'].api,
    { checks: 1, up: 1 },
  );
});

test('runs add to the day, count consecutive failures and reset them on recovery', () => {
  let s = updateStatus(null, allUp('t1'), at('2026-11-01T10:00:00Z'));
  s = updateStatus(s, withDown('proxy', 't2'), at('2026-11-01T10:05:00Z'));
  s = updateStatus(s, withDown('proxy', 't3'), at('2026-11-01T10:10:00Z'));
  const proxyNow = s.services.find((x) => x.id === 'proxy');
  assert.equal(proxyNow.consecutiveFailures, 2);
  assert.equal(proxyNow.error, 'HTTP 502 (expected 200)');
  assert.deepEqual(s.days['2026-11-01'].proxy, { checks: 3, up: 1 });
  assert.deepEqual(s.days['2026-11-01'].api, { checks: 3, up: 3 });

  s = updateStatus(s, allUp('t4'), at('2026-11-01T10:15:00Z'));
  const recovered = s.services.find((x) => x.id === 'proxy');
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal('error' in recovered, false);
});

test(`history keeps the last ${KEEP_DAYS} days`, () => {
  const days = {};
  for (let i = 0; i < 120; i++) {
    const key = new Date(Date.UTC(2026, 10, 1) - i * 86_400_000).toISOString().slice(0, 10);
    days[key] = { api: { checks: 288, up: 288 } };
  }
  const s = updateStatus(
    { services: [], days, incidents: [{ title: 'kept' }] },
    allUp('t'),
    at('2026-11-01T23:59:00Z'),
  );
  const keys = Object.keys(s.days);
  assert.equal(keys.length, KEEP_DAYS);
  assert.equal(keys[0], '2026-08-04');
  assert.equal(keys.at(-1), '2026-11-01');
  assert.deepEqual(s.days['2026-11-01'].api, { checks: 289, up: 289 });
  assert.deepEqual(s.incidents, [{ title: 'kept' }]);
});

test('an issue opens after two failed runs in a row, once', () => {
  const now = at('2026-11-01T10:10:00Z');
  let s = updateStatus(null, withDown('proxy', '2026-11-01T10:05:00Z'), now);
  assert.deepEqual(planIncidents(s.services, [], now), [], 'one failure is not an incident');

  s = updateStatus(s, withDown('proxy', '2026-11-01T10:10:00Z', 'Operation timed out'), now);
  const [open, ...rest] = planIncidents(s.services, [], now);
  assert.deepEqual(rest, []);
  assert.equal(open.action, 'open');
  assert.equal(open.id, 'proxy');
  assert.equal(open.title, 'Proxy is down');
  assert.match(open.body, /Operation timed out/);
  assert.match(open.body, /2026-11-01T10:10:00Z/);
  assert.match(open.body, /failed 2 checks in a row/);

  // Already open (by an earlier run or by hand): nothing more.
  const openIssues = [{ number: 7, title: 'Proxy is down', createdAt: '2026-11-01T10:10:00Z' }];
  s = updateStatus(s, withDown('proxy', 't'), now);
  assert.deepEqual(planIncidents(s.services, openIssues, now), []);
});

test('a recovered service gets its issue commented on and closed', () => {
  const now = at('2026-11-01T11:25:00Z');
  const s = updateStatus(null, allUp('2026-11-01T11:25:00Z'), now);
  const openIssues = [
    { number: 7, title: 'Proxy is down', createdAt: '2026-11-01T10:10:00Z' },
    { number: 8, title: 'Scheduled maintenance', createdAt: '2026-11-01T09:00:00Z' },
  ];
  const actions = planIncidents(s.services, openIssues, now);
  assert.equal(actions.length, 1, 'issues not named after a service are left alone');
  assert.equal(actions[0].action, 'close');
  assert.equal(actions[0].number, 7);
  assert.match(actions[0].comment, /Proxy is answering again/);
  assert.match(actions[0].comment, /after 1 h 15 min/);
});

test('incidents come from issues, without pull requests', () => {
  const incidents = toIncidents([
    {
      number: 7,
      title: 'Proxy is down',
      html_url: 'https://github.com/o/r/issues/7',
      state: 'closed',
      created_at: '2026-11-01T10:10:00Z',
      closed_at: '2026-11-01T11:25:00Z',
    },
    { number: 9, title: 'A PR', pull_request: {}, state: 'open', created_at: 'x' },
  ]);
  assert.deepEqual(incidents, [
    {
      number: 7,
      title: 'Proxy is down',
      url: 'https://github.com/o/r/issues/7',
      state: 'closed',
      createdAt: '2026-11-01T10:10:00Z',
      closedAt: '2026-11-01T11:25:00Z',
    },
  ]);
});

test('the workflow runs every 5 minutes with minimal permissions, and CI ignores its branch', () => {
  const load = (name) =>
    parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
  const status = load('status.yml');
  assert.equal(status.on.schedule[0].cron, '*/5 * * * *');
  assert.ok('workflow_dispatch' in status.on);
  assert.deepEqual(status.permissions, { contents: 'write', issues: 'write' });
  assert.equal(status.concurrency.group, 'status');
  const ci = load('ci.yml');
  assert.deepEqual(ci.on.push.branches, ['main'], 'pushes to status-data do not run CI');
});
