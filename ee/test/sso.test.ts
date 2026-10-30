import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleFor } from '../src/sso/sso.js';
import { type Env, type Org, bearer, newOrg, startEnv } from './harness.js';

const PUBLIC = 'http://brake.test';
const DASHBOARD = 'http://dash.test';
const CLIENT = 'brake-client';

// --- a minimal OpenID provider ---------------------------------------------------------------
let idp: FastifyInstance;
let issuer: string;
const codes = new Map<
  string,
  { nonce: string; challenge: string; email: string; groups: string[] }
>();
let signingKey: CryptoKey;

async function startIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  signingKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = Fastify();
  idp.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  idp.get('/.well-known/openid-configuration', () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  }));
  idp.get('/jwks', () => ({ keys: [jwk] }));
  idp.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>;
    // openid-client sends the secret in the body (client_secret_post).
    if (body.client_id !== CLIENT || body.client_secret !== 's3cret') {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    const c = codes.get(body.code ?? '');
    codes.delete(body.code ?? '');
    const challenge = createHash('sha256')
      .update(body.code_verifier ?? '')
      .digest('base64url');
    if (!c || challenge !== c.challenge) return reply.code(400).send({ error: 'invalid_grant' });
    const idToken = await new SignJWT({
      nonce: c.nonce,
      email: c.email,
      email_verified: true,
      groups: c.groups,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setSubject(c.email)
      .setAudience(CLIENT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey);
    return { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken };
  });
  issuer = (await idp.listen({ port: 0, host: '127.0.0.1' })).replace('localhost', '127.0.0.1');
}

let env: Env;
let org: Org;

beforeAll(async () => {
  await startIdp();
  env = await startEnv({
    sso: { publicUrl: PUBLIC, dashboardUrl: DASHBOARD, allowInsecureIdp: true },
  });
  org = await newOrg(env);
});

afterAll(async () => {
  await env.stop();
  await idp.close();
});

/** Log in through the IdP as `email` in `groups`; returns the proxy's final redirect. */
async function oidcLogin(orgId: string, email: string, groups: string[]) {
  const start = await env.app.inject(`/v1/sso/${orgId}/login`);
  expect(start.statusCode).toBe(302);
  const auth = new URL(start.headers.location!);
  expect(auth.origin + auth.pathname).toBe(`${issuer}/authorize`);
  expect(auth.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/v1/sso/oidc/callback`);
  const code = randomUUID();
  codes.set(code, {
    nonce: auth.searchParams.get('nonce')!,
    challenge: auth.searchParams.get('code_challenge')!,
    email,
    groups,
  });
  const state = auth.searchParams.get('state')!;
  return {
    res: await env.app.inject(`/v1/sso/oidc/callback?code=${code}&state=${state}`),
    state,
    code,
  };
}

const tokenFrom = (location: string | undefined) =>
  /#sso_token=(sbt_\w+)$/.exec(location ?? '')?.[1];

describe('single sign-on with OIDC', () => {
  it('maps IdP groups to roles and issues a short-lived token to the dashboard', async () => {
    const put = await env.app.inject({
      method: 'PUT',
      url: '/v1/sso',
      headers: bearer(org.owner),
      payload: {
        protocol: 'oidc',
        issuer,
        clientId: CLIENT,
        clientSecret: 's3cret',
        roleMap: { 'brake-admins': 'admin', 'brake-ops': 'operator' },
        allowedDomains: ['example.com'],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('s3cret');
    expect(put.json()).toMatchObject({ loginUrl: `${PUBLIC}/v1/sso/${org.id}/login` });

    const { res, state, code } = await oidcLogin(org.id, 'Ana@Example.com', [
      'staff',
      'brake-admins',
    ]);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`^${DASHBOARD}/#sso_token=sbt_`));
    const admin = tokenFrom(res.headers.location)!;
    const caps = await env.app.inject({
      method: 'PUT',
      url: '/v1/caps/org',
      headers: bearer(admin),
      payload: { day: { hard: 1000 } },
    });
    expect(caps.statusCode).toBe(200);
    // The login state works once.
    const replay = await env.app.inject(`/v1/sso/oidc/callback?code=${code}&state=${state}`);
    expect(replay.statusCode).toBe(403);
    // The token expires after the session length.
    env.clock.now = new Date(env.clock.now.getTime() + 9 * 3600_000);
    expect((await env.app.inject({ url: '/v1/caps', headers: bearer(admin) })).statusCode).toBe(
      401,
    );
    env.clock.now = new Date('2026-10-30T12:00:00Z');
    const audit = await env.app.inject({
      url: '/v1/events?source=audit',
      headers: bearer(org.viewer),
    });
    expect(audit.body).toContain('sso.login');
    expect(audit.body).toContain('ana@example.com');
  });

  it('gives ee roles through groups, and refuses unmapped users and other domains', async () => {
    const ops = tokenFrom(
      (await oidcLogin(org.id, 'ops@example.com', ['brake-ops'])).res.headers.location,
    )!;
    const kill = (t: string) =>
      env.app.inject({
        method: 'POST',
        url: '/v1/kill',
        headers: bearer(t),
        payload: { target: 'prov:x' },
      });
    expect((await kill(ops)).statusCode).toBe(200);
    expect(
      (
        await env.app.inject({
          method: 'PUT',
          url: '/v1/caps/org',
          headers: bearer(ops),
          payload: { day: { hard: 1 } },
        })
      ).statusCode,
    ).toBe(403);
    const unmapped = await oidcLogin(org.id, 'guest@example.com', ['staff']);
    expect(unmapped.res.statusCode).toBe(403);
    expect(unmapped.res.json()).toMatchObject({ error: 'sso_refused' });
    const outsider = await oidcLogin(org.id, 'eve@evil.test', ['brake-admins']);
    expect(outsider.res.json()).toMatchObject({ error: 'sso_refused' });
  });

  it('counts two SSO tokens of one person as one person for approvals', async () => {
    await env.app.inject({
      method: 'PUT',
      url: '/v1/approvals/policy',
      headers: bearer(org.owner),
      payload: { capApprovals: true },
    });
    const login = async () =>
      tokenFrom(
        (await oidcLogin(org.id, 'ana@example.com', ['brake-admins'])).res.headers.location,
      )!;
    const [first, second] = [await login(), await login()];
    const raise = await env.app.inject({
      method: 'PUT',
      url: '/v1/caps/org',
      headers: bearer(first),
      payload: { day: { hard: 5000 } },
    });
    const id = raise.json<{ pending: { approvalId: string }[] }>().pending[0]!.approvalId;
    const self = await env.app.inject({
      method: 'POST',
      url: `/v1/approvals/${id}/approve`,
      headers: bearer(second),
    });
    expect(self.json()).toMatchObject({ error: 'second_person_required' });
  });
});

// --- SAML -------------------------------------------------------------------------------------

function idpCert() {
  const dir = mkdtempSync(join(tmpdir(), 'saml-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=test-idp',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  return {
    key: readFileSync(join(dir, 'key.pem'), 'utf8'),
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
  };
}

function samlResponse(key: string, opts: { email: string; groups: string[]; audience: string }) {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000).toISOString();
  const id = `_${randomUUID()}`;
  const attrs = opts.groups.map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('');
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>https://idp.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${PUBLIC}/v1/sso/saml/acs"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups">${attrs}</saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
  const sig = new SignedXml({
    privateKey: key,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  sig.computeSignature(assertion, {
    location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
  });
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${PUBLIC}/v1/sso/saml/acs"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${sig.getSignedXml()}</samlp:Response>`;
  return Buffer.from(response).toString('base64');
}

describe('single sign-on with SAML', () => {
  it('accepts a signed assertion once and refuses forged ones', async () => {
    const samlOrg = await newOrg(env);
    const { key, cert } = idpCert();
    const put = await env.app.inject({
      method: 'PUT',
      url: '/v1/sso',
      headers: bearer(samlOrg.owner),
      payload: {
        protocol: 'saml',
        entryPoint: 'https://idp.test/sso',
        idpCert: cert,
        spEntityId: 'spend-brake',
        roleMap: { finance: 'billing' },
      },
    });
    expect(put.statusCode).toBe(200);
    const start = async () => {
      const res = await env.app.inject(`/v1/sso/${samlOrg.id}/login`);
      expect(res.headers.location).toMatch(/^https:\/\/idp\.test\/sso\?SAMLRequest=/);
      return new URL(res.headers.location!).searchParams.get('RelayState')!;
    };
    const post = (relay: string, saml: string) =>
      env.app.inject({
        method: 'POST',
        url: '/v1/sso/saml/acs',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ SAMLResponse: saml, RelayState: relay }).toString(),
      });

    const signed = samlResponse(key, {
      email: 'fin@corp.test',
      groups: ['finance'],
      audience: 'spend-brake',
    });
    const ok = await post(await start(), signed);
    expect(ok.statusCode).toBe(302);
    const billing = tokenFrom(ok.headers.location)!;
    expect(
      (
        await env.app.inject({
          method: 'PUT',
          url: '/v1/caps/org',
          headers: bearer(billing),
          payload: { day: { hard: 7 } },
        })
      ).statusCode,
    ).toBe(200);
    // The same assertion again (with a fresh state) is refused.
    expect((await post(await start(), signed)).statusCode).toBe(403);
    // Signed by someone else.
    const forged = samlResponse(idpCert().key, {
      email: 'fin@corp.test',
      groups: ['finance'],
      audience: 'spend-brake',
    });
    expect((await post(await start(), forged)).statusCode).toBe(403);
    // Edited after signing (group changed).
    const edited = Buffer.from(
      Buffer.from(
        samlResponse(key, { email: 'x@corp.test', groups: ['finance'], audience: 'spend-brake' }),
        'base64',
      )
        .toString()
        .replace(
          '<saml:AttributeValue>finance</saml:AttributeValue>',
          '<saml:AttributeValue>admins</saml:AttributeValue>',
        ),
    ).toString('base64');
    expect((await post(await start(), edited)).statusCode).toBe(403);
  });
});

describe('role mapping', () => {
  it('takes the strongest mapped role, then the default', () => {
    const row = { roleMap: { a: 'viewer', b: 'admin', c: 'operator' }, defaultRole: null };
    expect(roleFor(row, ['a', 'c'])).toBe('operator');
    expect(roleFor(row, ['c', 'b'])).toBe('admin');
    expect(roleFor(row, ['z'])).toBeNull();
    expect(roleFor({ ...row, defaultRole: 'viewer' }, ['z'])).toBe('viewer');
  });
});
