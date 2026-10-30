import { createHash } from 'node:crypto';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import {
  ApiError,
  type Auth,
  type Ctx,
  type Role,
  type Router,
  audit,
  errorSchema,
  newApiToken,
  newId,
  sha256,
} from '@spend-brake/api';
import { and, apiTokens, eq, users } from '@spend-brake/db';
import { type Envelope, decryptSecret, encryptSecret } from '@spend-brake/shared';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { createRoleToken, EE_ROLES, type EeRole } from '../api/roles.js';
import type { Entitlements } from '../entitlements.js';
import { eeSsoConfigs } from '../schema.js';

export interface SsoOptions {
  /** This API's URL as the browser and IdP reach it (redirect URI, SAML ACS). */
  publicUrl: string;
  /** Where to send the browser with its token after login. */
  dashboardUrl: string;
  /** How long an SSO token lives. */
  sessionMs?: number;
  /** Tests only: talk to an IdP over plain HTTP. */
  allowInsecureIdp?: boolean;
}

const STATE_TTL_SEC = 600;
const ASSERTION_TTL_SEC = 3600;
const SSO_ROLES = ['owner', 'admin', ...EE_ROLES, 'viewer'] as const;
type SsoRole = (typeof SSO_ROLES)[number];
// The first mapped group that names a role in this order wins.
const PRECEDENCE: readonly SsoRole[] = [
  'owner',
  'admin',
  'billing',
  'operator',
  'auditor',
  'viewer',
];

const secretContext = (orgId: string) => ({ purpose: 'sso-client-secret', orgId });

const common = {
  groupsClaim: z.string().min(1).max(200).default('groups'),
  roleMap: z.record(z.string().max(500), z.enum(SSO_ROLES)).default({}),
  defaultRole: z.enum(SSO_ROLES).nullable().default(null),
  allowedDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
};
const configBody = z.discriminatedUnion('protocol', [
  z.object({
    protocol: z.literal('oidc'),
    issuer: z.url(),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
    ...common,
  }),
  z.object({
    protocol: z.literal('saml'),
    entryPoint: z.url(),
    /** The IdP's signing certificate (PEM or base64). */
    idpCert: z.string().min(1).max(20_000),
    /** This service provider's entity id; defaults to the API URL. */
    spEntityId: z.string().min(1).max(500).optional(),
    ...common,
  }),
]);

const configView = z
  .object({
    protocol: z.enum(['oidc', 'saml']),
    issuer: z.string().optional(),
    clientId: z.string().optional(),
    entryPoint: z.string().optional(),
    spEntityId: z.string().optional(),
    groupsClaim: z.string(),
    roleMap: z.record(z.string(), z.string()),
    defaultRole: z.string().nullable(),
    allowedDomains: z.array(z.string()),
    loginUrl: z.string(),
  })
  .openapi('SsoConfig');

type ConfigRow = typeof eeSsoConfigs.$inferSelect;
interface OidcSettings {
  issuer: string;
  clientId: string;
  secret: Envelope;
}
interface SamlSettings {
  entryPoint: string;
  idpCert: string;
  spEntityId: string;
}
interface LoginState {
  orgId: string;
  protocol: 'oidc' | 'saml';
  nonce?: string;
  verifier?: string;
}

/** The role for a user from their groups; null when none maps and there is no default. */
export function roleFor(row: Pick<ConfigRow, 'roleMap' | 'defaultRole'>, groups: string[]) {
  const map = row.roleMap as Record<string, SsoRole>;
  const mapped = groups.map((g) => map[g]).filter((r): r is SsoRole => r !== undefined);
  for (const role of PRECEDENCE) if (mapped.includes(role)) return role;
  return (row.defaultRole as SsoRole | null) ?? null;
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];

export function ssoRoutes(
  app: FastifyInstance,
  r: Router,
  ctx: Ctx,
  ent: Entitlements,
  valkey: Redis,
  opts: SsoOptions,
): void {
  const publicUrl = opts.publicUrl.replace(/\/$/, '');
  const redirectUri = `${publicUrl}/v1/sso/oidc/callback`;
  const acsUrl = `${publicUrl}/v1/sso/saml/acs`;
  const sessionMs = opts.sessionMs ?? 8 * 3600_000;

  const loadConfig = async (orgId: string): Promise<ConfigRow | null> => {
    const [row] = await ctx.db
      .select()
      .from(eeSsoConfigs)
      .where(eq(eeSsoConfigs.orgId, orgId))
      .limit(1);
    return row ?? null;
  };

  const viewOf = (row: ConfigRow) => {
    const s = row.settings as Partial<OidcSettings & SamlSettings>;
    return {
      protocol: row.protocol,
      ...(s.issuer ? { issuer: s.issuer, clientId: s.clientId } : {}),
      ...(s.entryPoint ? { entryPoint: s.entryPoint, spEntityId: s.spEntityId } : {}),
      groupsClaim: row.groupsClaim,
      roleMap: row.roleMap as Record<string, string>,
      defaultRole: row.defaultRole,
      allowedDomains: row.allowedDomains as string[],
      loginUrl: `${publicUrl}/v1/sso/${row.orgId}/login`,
    };
  };

  const oidcConfig = async (orgId: string, s: OidcSettings) => {
    if (!ctx.wrapper) throw new ApiError(503, 'no_master_key', 'Set the master key first.');
    const secret = await decryptSecret(ctx.wrapper, s.secret, secretContext(orgId));
    return oidc.discovery(
      new URL(s.issuer),
      s.clientId,
      secret,
      undefined,
      opts.allowInsecureIdp ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
  };

  const saml = (s: SamlSettings) =>
    new SAML({
      entryPoint: s.entryPoint,
      idpCert: s.idpCert,
      issuer: s.spEntityId,
      callbackUrl: acsUrl,
      audience: s.spEntityId,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      // State is checked by RelayState, replay by the assertion hash.
      validateInResponseTo: ValidateInResponseTo.never,
      acceptedClockSkewMs: 60_000,
    });

  // --- configuration (owner) -------------------------------------------------------------------

  r.add({
    method: 'put',
    path: '/v1/sso',
    role: 'owner',
    tag: 'SSO',
    summary: "Configure single sign-on (OIDC or SAML) and map the IdP's groups to roles",
    body: configBody,
    response: configView,
    handler: async ({ auth, body }) => {
      await ent.require('sso', 'write');
      let settings: OidcSettings | SamlSettings;
      if (body.protocol === 'oidc') {
        if (!ctx.wrapper) throw new ApiError(503, 'no_master_key', 'Set the master key first.');
        settings = {
          issuer: body.issuer,
          clientId: body.clientId,
          secret: await encryptSecret(ctx.wrapper, body.clientSecret, secretContext(auth.orgId)),
        };
      } else {
        settings = {
          entryPoint: body.entryPoint,
          idpCert: body.idpCert,
          spEntityId: body.spEntityId ?? publicUrl,
        };
      }
      const row = {
        orgId: auth.orgId,
        protocol: body.protocol,
        settings,
        groupsClaim: body.groupsClaim,
        roleMap: body.roleMap,
        defaultRole: body.defaultRole,
        allowedDomains: body.allowedDomains,
        updatedAt: ctx.now(),
      };
      const [saved] = await ctx.db
        .insert(eeSsoConfigs)
        .values(row)
        .onConflictDoUpdate({ target: eeSsoConfigs.orgId, set: row })
        .returning();
      await audit(ctx, auth, 'sso.configure', body.protocol, {
        roleMap: body.roleMap,
        defaultRole: body.defaultRole,
      });
      return viewOf(saved!);
    },
  });

  r.add({
    method: 'get',
    path: '/v1/sso',
    role: 'owner',
    tag: 'SSO',
    summary: 'Single sign-on configuration (without the client secret)',
    response: configView,
    handler: async ({ auth }) => {
      await ent.require('sso', 'read');
      const row = await loadConfig(auth.orgId);
      if (!row) throw new ApiError(404, 'not_found', 'Single sign-on is not configured.');
      return viewOf(row);
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/sso',
    role: 'owner',
    tag: 'SSO',
    summary: 'Turn single sign-on off (tokens already issued run out on their own)',
    response: z.object({ deleted: z.boolean() }),
    handler: async ({ auth }) => {
      await ent.require('sso', 'write');
      const rows = await ctx.db
        .delete(eeSsoConfigs)
        .where(eq(eeSsoConfigs.orgId, auth.orgId))
        .returning();
      await audit(ctx, auth, 'sso.delete', null);
      return { deleted: rows.length > 0 };
    },
  });

  // --- login (public: the browser follows redirects) ---------------------------------------------

  for (const [method, path, summary] of [
    ['get', '/v1/sso/{orgId}/login', 'Start a single sign-on login (redirects to the IdP)'],
    ['get', '/v1/sso/oidc/callback', 'OIDC redirect URI'],
    ['post', '/v1/sso/saml/acs', 'SAML assertion consumer service'],
  ] as const) {
    r.registry.registerPath({
      method,
      path,
      summary,
      tags: ['SSO'],
      responses: {
        302: { description: 'Redirect' },
        403: { description: 'Refused', content: { 'application/json': { schema: errorSchema } } },
      },
    });
  }

  const rateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.get<{ Params: { orgId: string } }>(
    '/v1/sso/:orgId/login',
    { config: rateLimit },
    async (req, reply) => {
      await ent.require('sso', 'write');
      const orgId = req.params.orgId;
      const row = /^[A-Za-z0-9_-]{1,64}$/.test(orgId) ? await loadConfig(orgId) : null;
      if (!row) throw new ApiError(404, 'not_found', 'Single sign-on is not configured.');
      const state = oidc.randomState();
      if (row.protocol === 'oidc') {
        const config = await oidcConfig(orgId, row.settings as OidcSettings);
        const nonce = oidc.randomNonce();
        const verifier = oidc.randomPKCECodeVerifier();
        await saveState(state, { orgId, protocol: 'oidc', nonce, verifier });
        const url = oidc.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri,
          scope: 'openid email profile',
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: 'S256',
        });
        return reply.redirect(url.href);
      }
      await saveState(state, { orgId, protocol: 'saml' });
      const url = await saml(row.settings as SamlSettings).getAuthorizeUrlAsync(
        state,
        undefined,
        {},
      );
      return reply.redirect(url);
    },
  );

  app.get('/v1/sso/oidc/callback', { config: rateLimit }, async (req, reply) => {
    await ent.require('sso', 'write');
    const current = new URL(req.url, publicUrl);
    const state = await takeState(current.searchParams.get('state'), 'oidc');
    const row = await loadConfig(state.orgId);
    if (row?.protocol !== 'oidc') throw refused('Single sign-on changed during the login.');
    const config = await oidcConfig(state.orgId, row.settings as OidcSettings);
    let claims: Record<string, unknown>;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: state.verifier!,
        expectedState: current.searchParams.get('state')!,
        expectedNonce: state.nonce!,
        idTokenExpected: true,
      });
      claims = tokens.claims() ?? {};
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'oidc login failed');
      throw refused('The identity provider did not confirm the login.');
    }
    if (claims.email_verified === false) throw refused('The email address is not verified.');
    const email = typeof claims.email === 'string' ? claims.email : '';
    const token = await signIn(row, email, asList(claims[row.groupsClaim]));
    return reply.redirect(dashboardWith(token));
  });

  void app.register((scoped, _opts, done) => {
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 512 * 1024 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    scoped.post('/v1/sso/saml/acs', { config: rateLimit }, async (req, reply) => {
      await ent.require('sso', 'write');
      const form = (req.body ?? {}) as Record<string, string>;
      const state = await takeState(form.RelayState ?? null, 'saml');
      const row = await loadConfig(state.orgId);
      if (row?.protocol !== 'saml') throw refused('Single sign-on changed during the login.');
      let profile;
      try {
        ({ profile } = await saml(row.settings as SamlSettings).validatePostResponseAsync({
          SAMLResponse: form.SAMLResponse ?? '',
        }));
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'saml login failed');
        throw refused('The identity provider did not confirm the login.');
      }
      if (!profile) throw refused('The identity provider did not confirm the login.');
      // A signed assertion is accepted once.
      const assertion = profile.getAssertionXml?.() ?? JSON.stringify(profile);
      const seen = await valkey.set(
        `bk:sso:assertion:${createHash('sha256').update(assertion).digest('hex')}`,
        '1',
        'EX',
        ASSERTION_TTL_SEC,
        'NX',
      );
      if (seen !== 'OK') throw refused('This assertion was already used.');
      const email =
        profile.email ??
        profile.mail ??
        profile['urn:oid:0.9.2342.19200300.100.1.3'] ??
        (profile.nameID.includes('@') ? profile.nameID : '');
      const token = await signIn(row, String(email), asList(profile[row.groupsClaim]));
      return reply.redirect(dashboardWith(token));
    });
    done();
  });

  function refused(message: string) {
    return new ApiError(403, 'sso_refused', message);
  }

  function dashboardWith(token: string) {
    // In the fragment: never sent to a server or written to access logs.
    return `${opts.dashboardUrl.replace(/\/$/, '')}/#sso_token=${token}`;
  }

  async function saveState(state: string, value: LoginState) {
    await valkey.set(`bk:sso:state:${state}`, JSON.stringify(value), 'EX', STATE_TTL_SEC);
  }

  async function takeState(state: string | null, protocol: LoginState['protocol']) {
    if (!state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) throw refused('Missing login state.');
    const raw = await valkey.getdel(`bk:sso:state:${state}`);
    if (!raw) throw refused('This login expired or was already used; start again.');
    const value = JSON.parse(raw) as LoginState;
    if (value.protocol !== protocol) throw refused('Wrong login flow.');
    return value;
  }

  /** Find or create the user, then issue a short-lived token with the mapped role. */
  async function signIn(row: ConfigRow, rawEmail: string, groups: string[]): Promise<string> {
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw refused('The IdP sent no email address.');
    const domains = row.allowedDomains as string[];
    if (domains.length && !domains.includes(email.split('@')[1]!)) {
      throw refused('This email domain may not sign in to this org.');
    }
    const role = roleFor(row, groups);
    if (!role) throw refused('No role is mapped for this user.');
    const coreRole: Role = (EE_ROLES as readonly string[]).includes(role)
      ? 'viewer'
      : (role as Role);
    const [existing] = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.orgId, row.orgId), eq(users.email, email)))
      .limit(1);
    const userId = existing?.id ?? newId('usr');
    if (existing) {
      if (existing.role !== coreRole) {
        await ctx.db.update(users).set({ role: coreRole }).where(eq(users.id, userId));
      }
    } else {
      await ctx.db
        .insert(users)
        .values({ id: userId, orgId: row.orgId, email, role: coreRole, createdAt: ctx.now() });
    }
    const expiresAt = new Date(ctx.now().getTime() + sessionMs);
    let token: string;
    let tokenId: string;
    if (coreRole === 'viewer' && role !== 'viewer') {
      ({ token, id: tokenId } = await createRoleToken(ctx, row.orgId, role as EeRole, {
        name: `sso:${email}`,
        userId,
        expiresAt,
      }));
    } else {
      token = newApiToken();
      tokenId = newId('tok');
      await ctx.db.insert(apiTokens).values({
        id: tokenId,
        orgId: row.orgId,
        userId,
        name: `sso:${email}`,
        role: coreRole,
        tokenHash: sha256(token),
        createdAt: ctx.now(),
        expiresAt,
      });
    }
    const actor: Auth = { orgId: row.orgId, tokenId, role: coreRole, actor: `user:${userId}` };
    await audit(ctx, actor, 'sso.login', `user:${userId}`, { email, role, protocol: row.protocol });
    return token;
  }
}
