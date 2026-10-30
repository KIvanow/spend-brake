import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { bootstrapOrg, buildApi, newApiToken, newId, sha256 } from '@spend-brake/api';
import { Registry } from '@spend-brake/budget';
import { type Db, apiTokens, createDb, eq, migrate, users } from '@spend-brake/db';
import { LocalKeyWrapper, redactingLoggerOptions } from '@spend-brake/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import { eeApi } from '../src/api/index.js';
import { Entitlements } from '../src/entitlements.js';
import { FEATURES, type License, signLicense } from '../src/license/license.js';
import { migrateEe } from '../src/migrate.js';
import { eeLicenses, eeSsoConfigs } from '../src/schema.js';
import type { SsoOptions } from '../src/sso/sso.js';

/** A key pair standing in for the issuer's (the real private key never enters the repo). */
export const issuer = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export function license(overrides: Partial<License> = {}): License {
  return {
    id: `lic_${randomBytes(4).toString('hex')}`,
    org: 'acme',
    edition: 'business',
    features: [...FEATURES],
    orgUnits: 3,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export const ACTION_SECRET = 'a'.repeat(32);

export class LogSink extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _e: string, done: () => void) {
    this.lines.push(chunk.toString());
    done();
  }
  text() {
    return this.lines.join('');
  }
}

export interface Env {
  db: Db;
  valkey: Redis;
  registry: Registry;
  wrapper: LocalKeyWrapper;
  app: FastifyInstance;
  ent: Entitlements;
  logs: LogSink;
  clock: { now: Date };
  pgUrl: string;
  stop(): Promise<void>;
}

export interface EnvOptions {
  /** Install a license with every feature for this org (none when false). */
  licensedOrg?: string | false;
  sso?: SsoOptions;
}

export async function startContainers() {
  return Promise.all([
    new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_PASSWORD: 'p', POSTGRES_USER: 'brake', POSTGRES_DB: 'brake' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
}

export async function startEnv(opts: EnvOptions = {}): Promise<Env> {
  const [pg, vk] = await startContainers();
  const pgUrl = `postgres://brake:p@${pg.getHost()}:${pg.getMappedPort(5432)}/brake`;
  const { db, pool } = createDb(pgUrl);
  await migrate(db);
  await migrateEe(db);
  const valkey = new Redis(`redis://${vk.getHost()}:${vk.getMappedPort(6379)}`);
  const wrapper = new LocalKeyWrapper(randomBytes(32).toString('base64'));
  const clock = { now: new Date('2026-10-30T12:00:00Z') };
  const ent = new Entitlements(db, () => clock.now, issuer.publicKey, 0);
  const logs = new LogSink();
  const app = await buildApi({
    db,
    valkey,
    wrapper,
    logger: { ...redactingLoggerOptions('info'), stream: logs },
    authCacheMs: 0,
    rateLimitPerMinute: 10_000,
    actionSecret: ACTION_SECRET,
    now: () => clock.now,
    extensions: [eeApi({ entitlements: ent, valkey, ...(opts.sso ? { sso: opts.sso } : {}) })],
  });
  await app.ready();
  const env: Env = {
    db,
    valkey,
    registry: new Registry(valkey),
    wrapper,
    app,
    ent,
    logs,
    clock,
    pgUrl,
    async stop() {
      await app.close();
      await valkey.quit();
      await pool.end();
      await Promise.all([pg.stop(), vk.stop()]);
    },
  };
  if (opts.licensedOrg !== false)
    await installLicense(env, license({ org: opts.licensedOrg ?? 'acme' }));
  return env;
}

let installs = 0;

/** Put a signed license in place the way POST /v1/license does, without an owner token. */
export async function installLicense(env: Env, l: License): Promise<string> {
  const raw = signLicense(l, issuer.privateKey);
  await env.db.insert(eeLicenses).values({
    id: l.id,
    orgId: l.org,
    raw,
    expiresAt: new Date(l.expiresAt),
    installedBy: 'test',
    // Later installs sort first, as they would in real time.
    installedAt: new Date(env.clock.now.getTime() + ++installs),
  });
  env.ent.forget();
  return raw;
}

export interface Org {
  id: string;
  owner: string;
  admin: string;
  viewer: string;
}

let n = 0;

export async function newOrg(
  env: Env,
  id = `org${++n}_${randomBytes(3).toString('hex')}`,
): Promise<Org> {
  const owner = await bootstrapOrg({ db: env.db, registry: env.registry }, { id, name: id });
  return {
    id,
    owner,
    admin: await token(env, id, 'admin'),
    viewer: await token(env, id, 'viewer'),
  };
}

export async function token(env: Env, orgId: string, role: 'owner' | 'admin' | 'viewer') {
  const t = newApiToken();
  await env.db
    .insert(apiTokens)
    .values({ id: newId('tok'), orgId, name: role, role, tokenHash: sha256(t) });
  return t;
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** A token as single sign-on issues it: tied to a person (users row). */
export async function ssoPerson(
  env: Env,
  orgId: string,
  email: string,
  role: 'owner' | 'admin' | 'viewer',
): Promise<string> {
  const userId = newId('usr');
  await env.db.insert(users).values({ id: userId, orgId, email, role });
  const t = newApiToken();
  await env.db.insert(apiTokens).values({
    id: newId('tok'),
    orgId,
    userId,
    name: `sso:${email}`,
    role,
    tokenHash: sha256(t),
  });
  return t;
}

/** Another token for a person who already has one (a second login). */
export async function anotherLogin(env: Env, token: string): Promise<string> {
  const [row] = await env.db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, sha256(token)));
  const t = newApiToken();
  await env.db.insert(apiTokens).values({
    id: newId('tok'),
    orgId: row!.orgId,
    userId: row!.userId,
    name: row!.name,
    role: row!.role,
    tokenHash: sha256(t),
  });
  return t;
}

/** Mark single sign-on as configured for an org (the IdP itself is not used). */
export async function ssoConfigured(env: Env, orgId: string): Promise<void> {
  await env.db.insert(eeSsoConfigs).values({
    orgId,
    protocol: 'saml',
    settings: { entryPoint: 'https://idp.test/sso', idpCert: 'x', spEntityId: 'sb' },
  });
}
