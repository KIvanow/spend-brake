#!/usr/bin/env node
// Check prices against real provider accounts: one cheap call per provider whose key is set,
// through a running install, each under a $0.50 daily cap. Prints what the proxy charged and,
// where the provider reports it, what the provider says it cost. Compare the rest with each
// provider's usage page the next day (they lag by hours).
//
//   BRAKE_API_URL=https://app.example.com BRAKE_PROXY_URL=https://brake.example.com \
//   BRAKE_ADMIN_TOKEN=sbt_... GOOGLE_MAPS_KEY=... EXA_API_KEY=... node scripts/check-providers.mjs
//
// Keys: GOOGLE_MAPS_KEY, MAPBOX_TOKEN, HERE_API_KEY, TAVILY_API_KEY, EXA_API_KEY, BRAVE_API_KEY,
// SERPAPI_API_KEY. Twilio is left out: a check would send a real SMS (see docs/self-hosting.md).
// Everything the script creates (credentials, keys) is revoked at the end. Total spend is a few
// cents.

const api = (process.env.BRAKE_API_URL ?? 'http://localhost:8081').replace(/\/$/, '');
const proxy = (process.env.BRAKE_PROXY_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const admin = process.env.BRAKE_ADMIN_TOKEN;
if (!admin) throw new Error('Set BRAKE_ADMIN_TOKEN (admin or owner token).');

const CHECKS = [
  {
    provider: 'google-maps',
    env: 'GOOGLE_MAPS_KEY',
    what: 'Geocoding API, one address',
    request: (key) => ({
      url: `${proxy}/google-maps/maps/api/geocode/json?address=Sofia&key=${key}`,
    }),
  },
  {
    provider: 'mapbox',
    env: 'MAPBOX_TOKEN',
    what: 'Geocoding v6 forward (temporary)',
    request: (key) => ({
      url: `${proxy}/mapbox/search/geocode/v6/forward?q=Sofia&access_token=${key}`,
    }),
  },
  {
    provider: 'here',
    env: 'HERE_API_KEY',
    what: 'Geocoding & Search, geocode',
    request: (key) => ({ url: `${proxy}/here-geocode/v1/geocode?q=Sofia&apiKey=${key}` }),
  },
  {
    provider: 'tavily',
    env: 'TAVILY_API_KEY',
    what: 'Search, basic depth, with usage',
    request: (key) => ({
      url: `${proxy}/tavily/search`,
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'spend caps',
        search_depth: 'basic',
        max_results: 1,
        include_usage: true,
      }),
    }),
    reported: (b) => (typeof b?.usage?.credits === 'number' ? b.usage.credits * 8_000 : null),
  },
  {
    provider: 'exa',
    env: 'EXA_API_KEY',
    what: 'Search, type lite, 1 result',
    request: (key) => ({
      url: `${proxy}/exa/search`,
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'spend caps', type: 'lite', numResults: 1 }),
    }),
    reported: (b) =>
      typeof b?.costDollars?.total === 'number' ? Math.round(b.costDollars.total * 1e6) : null,
  },
  {
    provider: 'brave',
    env: 'BRAVE_API_KEY',
    what: 'Web search',
    request: (key) => ({
      url: `${proxy}/brave/res/v1/web/search?q=spend+caps&count=1`,
      headers: { 'x-subscription-token': key },
    }),
  },
  {
    provider: 'serpapi',
    env: 'SERPAPI_API_KEY',
    what: 'Google search (uncached)',
    request: (key) => ({
      url: `${proxy}/serpapi/search.json?engine=google&q=spend+caps+${Date.now()}&no_cache=true&api_key=${key}`,
    }),
  },
];

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.message ?? ''}`);
  return data;
}

const usd = (micros) =>
  micros === null || micros === undefined ? '-' : `$${(Number(micros) / 1e6).toFixed(6)}`;
const rows = [];
const run = `check-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

for (const c of CHECKS) {
  const secret = process.env[c.env];
  if (!secret) continue;
  let cred;
  let key;
  try {
    cred = await call('POST', '/v1/providers/credentials', {
      provider: c.provider,
      name: run,
      secret,
    });
    key = await call('POST', '/v1/keys', { name: run, credentials: { [c.provider]: cred.id } });
    await call('PUT', `/v1/caps/${encodeURIComponent(`key:${key.id}`)}`, {
      day: { hard: 500_000 },
    });
    const r = c.request(key.token);
    const res = await fetch(r.url, {
      method: r.method ?? 'GET',
      headers: r.headers ?? {},
      body: r.body,
    });
    const body = await res.json().catch(() => null);
    const charged = res.headers.get('x-brake-cost-micros');
    const reported = c.reported?.(body) ?? null;
    const differs = reported !== null && charged !== null && Number(charged) !== reported;
    rows.push({
      provider: c.provider,
      call: c.what,
      status: res.status,
      charged: usd(charged),
      providerSays: usd(reported),
      note:
        res.status >= 400 || (typeof body?.status === 'string' && body.status !== 'OK')
          ? JSON.stringify(body).slice(0, 120)
          : differs
            ? 'DIFFERS: check the catalog'
            : '',
    });
  } catch (err) {
    rows.push({
      provider: c.provider,
      call: c.what,
      status: 'error',
      charged: '-',
      providerSays: '-',
      note: err.message,
    });
  } finally {
    if (key) await call('DELETE', `/v1/keys/${key.id}`).catch(() => {});
    if (cred) await call('DELETE', `/v1/providers/credentials/${cred.id}`).catch(() => {});
  }
}

if (rows.length === 0) {
  console.log('No provider keys set; nothing checked. See the comment at the top of this script.');
} else {
  console.table(rows);
  console.log(
    'Compare "charged" with each provider usage page tomorrow; a gap means a catalog price to fix.',
  );
}
