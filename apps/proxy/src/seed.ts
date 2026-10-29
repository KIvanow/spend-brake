// Dev helper: create an org and a virtual key in Valkey and print the key once.
//   pnpm --filter @spend-brake/proxy seed -- --org dev --credential cred-google [--no-loop]
import { parseArgs } from 'node:util';
import { Registry } from '@spend-brake/budget';
import { Redis } from 'ioredis';
import { loadEnv } from './config.js';

const { values } = parseArgs({
  options: {
    org: { type: 'string', default: 'dev' },
    key: { type: 'string', default: 'dev-key' },
    credential: { type: 'string', default: 'cred-google' },
    'no-loop': { type: 'boolean', default: false },
  },
});

const env = loadEnv();
const valkey = new Redis(env.VALKEY_URL);
const registry = new Registry(valkey);
await registry.putOrg({ id: values.org });
const { token } = await registry.createKey({
  id: values.key,
  orgId: values.org,
  credentials: { 'google-maps': values.credential },
  // Load tests repeat requests on purpose.
  ...(values['no-loop']
    ? { loop: { identical: 1e9, windowSec: 60, perMinute: 1e9, cooldownSec: 1 } }
    : {}),
});
process.stdout.write(`${token}\n`);
await valkey.quit();
