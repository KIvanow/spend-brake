// Load test: 2,000 rps through the proxy vs straight to the mock upstream.
// Added latency = p99(proxy) - p99(direct); target < 5 ms on one proxy instance.
//
//   BRAKE_KEY=$(pnpm --silent --filter @spend-brake/proxy seed -- --no-loop) \
//   k6 run -e BRAKE_KEY=$BRAKE_KEY infra/k6/proxy.js
// See apps/proxy/README.md for the full setup.
/* global __ENV */
import http from 'k6/http';
import { check } from 'k6';

const PROXY = __ENV.PROXY_URL || 'http://localhost:8080';
const DIRECT = __ENV.DIRECT_URL || 'http://localhost:9090';
const RATE = Number(__ENV.RATE || 2000);
const DURATION = __ENV.DURATION || '30s';

const scenario = (exec, startTime) => ({
  executor: 'constant-arrival-rate',
  exec,
  rate: RATE,
  timeUnit: '1s',
  duration: DURATION,
  preAllocatedVUs: 200,
  maxVUs: 1000,
  startTime,
});

export const options = {
  scenarios: {
    direct: scenario('direct', '0s'),
    proxy: scenario('proxy', DURATION),
  },
  thresholds: {
    'http_req_failed{scenario:proxy}': ['rate<0.001'],
    'http_req_duration{scenario:direct}': ['p(99)>=0'],
    'http_req_duration{scenario:proxy}': ['p(99)>=0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const path = () => `/maps/api/geocode/json?address=${Math.floor(Math.random() * 1e9)}`;

export function direct() {
  check(http.get(`${DIRECT}${path()}`), { 200: (r) => r.status === 200 });
}

export function proxy() {
  const res = http.get(`${PROXY}/google-maps${path()}`, {
    headers: { 'x-brake-key': __ENV.BRAKE_KEY },
  });
  check(res, { 200: (r) => r.status === 200 });
}
