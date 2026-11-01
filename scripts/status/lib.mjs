// Pure logic behind the status page: what counts as up, how status.json is updated, and which
// incident issues to open or close. No network or file access here, so it can be unit tested
// (scripts/test/status.test.mjs); scripts/status/run.mjs does the I/O.

export const SERVICES = [
  { id: 'dashboard', name: 'Dashboard', url: 'https://app.spendbrake.dev/' },
  { id: 'api', name: 'API', url: 'https://app.spendbrake.dev/v1/auth/options', json: true },
  { id: 'proxy', name: 'Proxy', url: 'https://proxy.spendbrake.dev/healthz' },
  { id: 'website', name: 'Website', url: 'https://spendbrake.dev/' },
  { id: 'docs', name: 'Docs', url: 'https://docs.spendbrake.dev/' },
];

/** Days of history kept in status.json (today included). */
export const KEEP_DAYS = 90;
/** Consecutive failed runs before an incident issue is opened. */
export const FAILS_TO_OPEN = 2;
export const INCIDENT_LABEL = 'incident';
/** Incident issues listed on the page. */
export const MAX_INCIDENTS = 20;

export const incidentTitle = (service) => `${service.name} is down`;

/**
 * Whether one attempt passed. `attempt` is what curl reported: `{ code, body, error }` where
 * `code` is the HTTP status (0 when no response) and `error` is curl's message, if any.
 */
export function evaluate(service, attempt) {
  if (attempt.error && !attempt.code) return { up: false, error: attempt.error };
  if (attempt.code !== 200) return { up: false, error: `HTTP ${attempt.code} (expected 200)` };
  if (service.json) {
    try {
      JSON.parse(attempt.body ?? '');
    } catch {
      return { up: false, error: 'HTTP 200 but the body is not JSON' };
    }
  }
  return { up: true, error: null };
}

const dayKey = (date) => date.toISOString().slice(0, 10);

function validPrevious(prev) {
  if (!prev || typeof prev !== 'object') return { services: [], days: {}, incidents: [] };
  return {
    services: Array.isArray(prev.services) ? prev.services : [],
    days: prev.days && typeof prev.days === 'object' ? prev.days : {},
    incidents: Array.isArray(prev.incidents) ? prev.incidents : [],
  };
}

/**
 * The next status.json from the previous one (or nothing) and this run's results:
 * `results` is `[{ id, up, latencyMs, error, checkedAt }]` in SERVICES order.
 */
export function updateStatus(previous, results, now) {
  const prev = validPrevious(previous);
  const today = dayKey(now);
  const oldest = dayKey(new Date(now.getTime() - (KEEP_DAYS - 1) * 86_400_000));

  const services = results.map((r) => {
    const service = SERVICES.find((s) => s.id === r.id) ?? { id: r.id, name: r.id, url: '' };
    const before = prev.services.find((s) => s.id === r.id);
    const fails = r.up ? 0 : (Number(before?.consecutiveFailures) || 0) + 1;
    return {
      id: service.id,
      name: service.name,
      url: service.url,
      up: r.up,
      latencyMs: r.latencyMs,
      checkedAt: r.checkedAt,
      consecutiveFailures: fails,
      ...(r.up ? {} : { error: r.error }),
    };
  });

  const days = {};
  for (const [key, value] of Object.entries(prev.days)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && key >= oldest && key <= today) days[key] = value;
  }
  const day = { ...(days[today] ?? {}) };
  for (const r of results) {
    const counts = day[r.id] ?? { checks: 0, up: 0 };
    day[r.id] = { checks: counts.checks + 1, up: counts.up + (r.up ? 1 : 0) };
  }
  days[today] = day;

  const sortedDays = Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    updatedAt: now.toISOString(),
    services,
    days: sortedDays,
    incidents: prev.incidents,
  };
}

function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/**
 * What to do with incident issues after a run. `services` are the entries of the new
 * status.json; `openIssues` are the open issues labeled `incident` (`{ number, title, createdAt }`).
 * Returns `[{ action: 'open', id, title, body }]` and `[{ action: 'close', id, number, comment }]`.
 */
export function planIncidents(services, openIssues, now) {
  const actions = [];
  for (const s of services) {
    const title = incidentTitle(s);
    const issue = openIssues.find((i) => i.title === title);
    if (!s.up && s.consecutiveFailures >= FAILS_TO_OPEN && !issue) {
      actions.push({
        action: 'open',
        id: s.id,
        title,
        body: [
          `${s.name} (${s.url}) failed ${s.consecutiveFailures} checks in a row.`,
          '',
          `- Error: ${s.error ?? 'unknown'}`,
          `- Last checked: ${s.checkedAt}`,
          '',
          'Opened by the status workflow (`.github/workflows/status.yml`). It is closed with a comment',
          'when the service passes its check again. Status page: https://status.spendbrake.dev',
        ].join('\n'),
      });
    } else if (s.up && issue) {
      const since = issue.createdAt ? Date.parse(issue.createdAt) : NaN;
      const down = Number.isFinite(since) ? ` after ${duration(now.getTime() - since)}` : '';
      actions.push({
        action: 'close',
        id: s.id,
        number: issue.number,
        comment: `${s.name} is answering again (checked ${s.checkedAt}, ${s.latencyMs} ms). Closing${down}.`,
      });
    }
  }
  return actions;
}

/** The page's incident list from GitHub's issue objects (pull requests dropped). */
export function toIncidents(issues) {
  return issues
    .filter((i) => !i.pull_request)
    .slice(0, MAX_INCIDENTS)
    .map((i) => ({
      number: i.number,
      title: i.title,
      url: i.html_url,
      state: i.state,
      createdAt: i.created_at,
      closedAt: i.closed_at ?? null,
    }));
}
