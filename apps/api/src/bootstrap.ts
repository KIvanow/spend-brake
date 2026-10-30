// Create an org with an owner API token, printed once. `brake init` (Phase 7) wraps this.
//   pnpm --filter @spend-brake/api bootstrap -- --org acme --name "Acme" [--tz Europe/Sofia]
import { parseArgs } from 'node:util';
import { DEFAULT_LOOP_POLICY, Registry, connectValkey } from '@spend-brake/budget';
import { apiTokens, createDb, migrate, orgs } from '@spend-brake/db';
import { loadEnv } from './config.js';
import { newApiToken, newId, sha256 } from './ids.js';

export async function bootstrapOrg(
  deps: { db: ReturnType<typeof createDb>['db']; registry: Registry },
  org: { id: string; name: string; timeZone?: string },
): Promise<string> {
  const timeZone = org.timeZone ?? 'UTC';
  await deps.db.insert(orgs).values({ id: org.id, name: org.name, timeZone, settings: {} });
  await deps.registry.putOrg({ id: org.id, timeZone, providers: {}, loop: DEFAULT_LOOP_POLICY });
  const token = newApiToken();
  await deps.db.insert(apiTokens).values({
    id: newId('tok'),
    orgId: org.id,
    name: 'bootstrap owner',
    role: 'owner',
    tokenHash: sha256(token),
  });
  return token;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      org: { type: 'string' },
      name: { type: 'string' },
      tz: { type: 'string', default: 'UTC' },
    },
  });
  if (!values.org) throw new Error('--org is required');
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  await migrate(db);
  const valkey = connectValkey(env.VALKEY_URL);
  const token = await bootstrapOrg(
    { db, registry: new Registry(valkey) },
    { id: values.org, name: values.name ?? values.org, timeZone: values.tz },
  );
  process.stdout.write(`${token}\n`);
  await valkey.quit();
  await pool.end();
}
