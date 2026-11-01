// One status run: check every service with curl, update status.json, and open or close incident
// issues. Run by .github/workflows/status.yml every ~5 minutes.
//
//   node scripts/status/run.mjs --in previous.json --out status.json [--dry-run]
//
// --in may name a missing file (first run). Without --dry-run and with GITHUB_TOKEN and
// GITHUB_REPOSITORY set, it opens/closes issues labeled `incident` and lists them in status.json;
// otherwise it only checks and writes the file (safe to run locally: it sends GET requests only).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  INCIDENT_LABEL,
  MAX_INCIDENTS,
  SERVICES,
  evaluate,
  planIncidents,
  toIncidents,
  updateStatus,
} from './lib.mjs';

const run = promisify(execFile);
const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!args.out) {
  console.error('usage: run.mjs --in previous.json --out status.json [--dry-run]');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'status-'));

/** One curl request: 10 s timeout, no redirects followed. */
async function attempt(service) {
  const bodyFile = join(work, `${service.id}.body`);
  const argv = [
    '-sS',
    '--max-time',
    '10',
    '-A',
    'spend-brake-status (+https://github.com/KIvanow/spend-brake)',
    '-o',
    bodyFile,
    '-w',
    '%{json}',
    service.url,
  ];
  // curl exits non-zero on timeouts and connection errors but still prints its report.
  const { stdout, stderr } = await run('curl', argv, { timeout: 15_000 }).catch((err) => ({
    stdout: err.stdout ?? '',
    stderr: err.stderr ?? String(err.message),
  }));
  let info = {};
  try {
    info = JSON.parse(stdout);
  } catch {
    // curl did not get as far as writing its report.
  }
  let body = '';
  try {
    body = readFileSync(bodyFile, 'utf8');
  } catch {
    // No body written.
  }
  return {
    code: Number(info.response_code ?? info.http_code) || 0,
    latencyMs: Math.round((Number(info.time_total) || 0) * 1000),
    body,
    error: info.errormsg || stderr.trim() || null,
  };
}

/** Check one service, retrying once after 5 s. */
async function check(service) {
  let result = await attempt(service);
  let verdict = evaluate(service, result);
  if (!verdict.up) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    result = await attempt(service);
    verdict = evaluate(service, result);
  }
  return {
    id: service.id,
    up: verdict.up,
    latencyMs: result.latencyMs,
    error: verdict.error,
    checkedAt: new Date().toISOString(),
  };
}

function readPrevious(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const useGitHub = Boolean(token && repo && !args['dry-run']);

async function github(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'spend-brake-status',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const results = await Promise.all(SERVICES.map(check));
rmSync(work, { recursive: true, force: true });
const now = new Date();
const status = updateStatus(readPrevious(args.in), results, now);

for (const s of status.services) {
  const state = s.up ? 'up  ' : 'DOWN';
  console.log(
    `${state} ${s.name.padEnd(10)} ${String(s.latencyMs).padStart(6)} ms  ${s.error ?? ''}`,
  );
}

if (useGitHub) {
  try {
    const open = await github('GET', `/issues?labels=${INCIDENT_LABEL}&state=open&per_page=100`);
    const openIssues = open
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, createdAt: i.created_at }));
    for (const step of planIncidents(status.services, openIssues, now)) {
      if (step.action === 'open') {
        const issue = await github('POST', '/issues', {
          title: step.title,
          body: step.body,
          labels: [INCIDENT_LABEL],
        });
        console.log(`opened #${issue.number}: ${step.title}`);
      } else {
        await github('POST', `/issues/${step.number}/comments`, { body: step.comment });
        await github('PATCH', `/issues/${step.number}`, {
          state: 'closed',
          state_reason: 'completed',
        });
        console.log(`closed #${step.number} (${step.id} recovered)`);
      }
    }
    const recent = await github(
      'GET',
      `/issues?labels=${INCIDENT_LABEL}&state=all&sort=created&direction=desc&per_page=${MAX_INCIDENTS}`,
    );
    status.incidents = toIncidents(recent);
  } catch (err) {
    // Keep publishing the checks even if the issue API misbehaves; the run is marked as failed.
    console.log(`::warning::incident issues not updated: ${err.message}`);
    process.exitCode = 1;
  }
}

writeFileSync(args.out, `${JSON.stringify(status)}\n`);
