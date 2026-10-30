// Email sign-in: a one-time link emailed to a person, exchanged for a token that acts as them.
import { randomBytes } from 'node:crypto';
import type { ValkeyClient } from '@spend-brake/budget';
import { type Db, and, apiTokens, eq, isNull, orgs, users } from '@spend-brake/db';
import { ALERT_QUEUE, QUEUE_PREFIX } from '@spend-brake/shared';
import { Queue } from 'bullmq';
import type { Role } from './auth.js';
import { newApiToken, newId, sha256 } from './ids.js';

/** How long an emailed link works (once). */
export const LOGIN_LINK_TTL_SEC = 15 * 60;
/** How long a token from an email sign-in lives. */
export const EMAIL_SESSION_MS = 7 * 24 * 3600_000;
/** At most this many links per address per hour, whoever asks. */
const LINKS_PER_EMAIL_PER_HOUR = 5;
/** One address may belong to several orgs; one email lists at most this many. */
const MAX_ORGS_PER_EMAIL = 10;

export type LoginPurpose = 'sign_in' | 'invite' | 'welcome';

export interface LoginMail {
  email: string;
  purpose: LoginPurpose;
  links: { orgId: string; orgName: string; url: string }[];
}

export interface LoginMailer {
  send(mail: LoginMail): Promise<void>;
}

/** Sign-in emails go through the notifier's queue (it holds the SMTP settings). */
export function queueLoginMailer(connection: ValkeyClient): LoginMailer & { queue: Queue } {
  const queue = new Queue(ALERT_QUEUE, { connection, prefix: QUEUE_PREFIX });
  return {
    queue,
    send: async (m) => {
      await queue.add(
        'login_link',
        { type: 'login_link', orgId: null, ...m },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          // The job holds working links: keep it no longer than it is needed.
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    },
  };
}

export interface EmailSignIn {
  /** Where a link opens; `#login=<code>` is appended. */
  dashboardUrl: string;
  mailer: LoginMailer;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const linkKey = (code: string) => `bk:login:${sha256(code)}`;
const CODE = /^[A-Za-z0-9_-]{43}$/;

/** A one-time link for a person of an org; only its hash is stored. */
export async function createLoginLink(
  valkey: ValkeyClient,
  dashboardUrl: string,
  user: { id: string; orgId: string },
): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await valkey.set(
    linkKey(code),
    JSON.stringify({ userId: user.id, orgId: user.orgId }),
    'EX',
    LOGIN_LINK_TTL_SEC,
  );
  // In the fragment: it never reaches a server log, and only the page's script can use it
  // (so mail scanners that open links do not spend it).
  return `${dashboardUrl.replace(/\/$/, '')}/#login=${code}`;
}

/** Counts a link sent to an address; false once it has had its hourly share. */
export async function allowLinkTo(valkey: ValkeyClient, email: string): Promise<boolean> {
  const key = `bk:login:rl:${sha256(normalizeEmail(email))}`;
  const n = await valkey.incr(key);
  if (n === 1) await valkey.expire(key, 3600);
  return n <= LINKS_PER_EMAIL_PER_HOUR;
}

/**
 * Email the address a sign-in link for each org it belongs to (and may sign in to by email).
 * Says nothing about whether the address is known: the caller answers the same either way.
 */
export async function sendSignInLinks(
  deps: { db: Db; valkey: ValkeyClient; allowed: (orgId: string) => Promise<boolean> },
  signIn: EmailSignIn,
  rawEmail: string,
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const rows = await deps.db
    .select({ id: users.id, orgId: users.orgId, orgName: orgs.name })
    .from(users)
    .innerJoin(orgs, eq(orgs.id, users.orgId))
    .where(and(eq(users.email, email), isNull(users.removedAt)))
    .limit(MAX_ORGS_PER_EMAIL);
  const open = [];
  for (const row of rows) if (await deps.allowed(row.orgId)) open.push(row);
  if (open.length === 0 || !(await allowLinkTo(deps.valkey, email))) return;
  const links = [];
  for (const row of open) {
    links.push({
      orgId: row.orgId,
      orgName: row.orgName,
      url: await createLoginLink(deps.valkey, signIn.dashboardUrl, row),
    });
  }
  await signIn.mailer.send({ email, purpose: 'sign_in', links });
}

export interface SignedIn {
  token: string;
  tokenId: string;
  userId: string;
  orgId: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

/**
 * Spend a link (it works once) and issue a token acting as its person. null when the link is
 * unknown, used, expired, or the person was removed or may no longer sign in by email.
 */
export async function redeemLoginLink(
  deps: {
    db: Db;
    valkey: ValkeyClient;
    now: () => Date;
    allowed: (orgId: string) => Promise<boolean>;
  },
  code: string,
): Promise<SignedIn | null> {
  if (!CODE.test(code)) return null;
  const raw = await deps.valkey.getdel(linkKey(code));
  if (!raw) return null;
  const { userId, orgId } = JSON.parse(raw) as { userId: string; orgId: string };
  const [user] = await deps.db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId), isNull(users.removedAt)))
    .limit(1);
  if (!user || !(await deps.allowed(orgId))) return null;
  const token = newApiToken();
  const tokenId = newId('tok');
  const expiresAt = new Date(deps.now().getTime() + EMAIL_SESSION_MS);
  await deps.db.insert(apiTokens).values({
    id: tokenId,
    orgId,
    userId,
    name: `email:${user.email}`,
    role: user.role,
    signIn: 'email',
    tokenHash: sha256(token),
    createdAt: deps.now(),
    expiresAt,
  });
  return { token, tokenId, userId, orgId, email: user.email, role: user.role, expiresAt };
}
