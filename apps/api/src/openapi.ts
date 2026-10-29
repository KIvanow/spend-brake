// Write the OpenAPI 3.1 spec to apps/api/openapi.json (pnpm --filter @spend-brake/api openapi).
import { writeFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { buildApi } from './server.js';

const valkey = new Redis({ lazyConnect: true });
const app = await buildApi({ db: {} as never, valkey, wrapper: null });
const res = await app.inject('/v1/openapi.json');
writeFileSync(
  new URL('../openapi.json', import.meta.url),
  `${JSON.stringify(res.json(), null, 2)}\n`,
);
await app.close();
valkey.disconnect();
