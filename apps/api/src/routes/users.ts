import { type Db, and, apiTokens, eq, gt, isNull, ne, or, orgs, users } from '@spend-brake/db';
import { z } from 'zod';
import { ROLES } from '../auth.js';
import { type Ctx, audit, id } from '../common.js';
import { newId } from '../ids.js';
import { type EmailSignIn, allowLinkTo, createLoginLink, normalizeEmail } from '../login.js';
import { ApiError, type Router, notFound } from '../route.js';

const userView = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  createdAt: z.string(),
});

const view = (u: typeof users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt.toISOString(),
});

/** Revoke every live token issued to the person (their sessions end within seconds). */
async function endSessions(db: Db, orgId: string, userId: string, now: Date): Promise<void> {
  await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(
      and(eq(apiTokens.orgId, orgId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)),
    );
}

/**
 * Whether the org keeps an owner without this person: another owner who is a person, or a live
 * owner token not tied to anyone (`brake init`'s).
 */
async function ownerRemains(db: Db, orgId: string, userId: string, now: Date): Promise<boolean> {
  const [person] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgId, orgId),
        eq(users.role, 'owner'),
        isNull(users.removedAt),
        ne(users.id, userId),
      ),
    )
    .limit(1);
  if (person) return true;
  const [token] = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.orgId, orgId),
        eq(apiTokens.role, 'owner'),
        isNull(apiTokens.userId),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
      ),
    )
    .limit(1);
  return token !== undefined;
}

/** The people of an org: who they are, their role, inviting more and removing them. */
export function userRoutes(r: Router, ctx: Ctx, signIn: EmailSignIn | undefined): void {
  const emailAllowed = (orgId: string) =>
    ctx.hooks.emailSignInAllowed?.(orgId) ?? Promise.resolve(true);

  const load = async (orgId: string, userId: string) => {
    const [row] = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId), isNull(users.removedAt)))
      .limit(1);
    if (!row) throw notFound('Person');
    return row;
  };

  const keepAnOwner = async (orgId: string, userId: string) => {
    if (!(await ownerRemains(ctx.db, orgId, userId, ctx.now()))) {
      throw new ApiError(409, 'last_owner', 'The org needs another owner first.');
    }
  };

  r.add({
    method: 'get',
    path: '/v1/users',
    role: 'admin',
    tag: 'Team',
    summary: 'People in the org',
    response: z.object({ items: z.array(userView) }),
    handler: async ({ auth }) => {
      const rows = await ctx.db
        .select()
        .from(users)
        .where(and(eq(users.orgId, auth.orgId), isNull(users.removedAt)))
        .orderBy(users.createdAt);
      return { items: rows.map(view) };
    },
  });

  r.add({
    method: 'post',
    path: '/v1/users',
    role: 'owner',
    tag: 'Team',
    summary: 'Invite a person (emails them a sign-in link when email sign-in is on)',
    status: 201,
    body: z.object({ email: z.string().trim().pipe(z.email().max(320)), role: z.enum(ROLES) }),
    response: userView.extend({ invited: z.boolean() }),
    handler: async ({ auth, body }) => {
      const email = normalizeEmail(body.email);
      const [existing] = await ctx.db
        .select()
        .from(users)
        .where(and(eq(users.orgId, auth.orgId), eq(users.email, email)))
        .limit(1);
      if (existing && !existing.removedAt) {
        throw new ApiError(409, 'conflict', 'That person is already in the org.');
      }
      // Someone removed earlier comes back as the same person (their audit history stays theirs).
      const [user] = existing
        ? await ctx.db
            .update(users)
            .set({ role: body.role, removedAt: null })
            .where(eq(users.id, existing.id))
            .returning()
        : await ctx.db
            .insert(users)
            .values({
              id: newId('usr'),
              orgId: auth.orgId,
              email,
              role: body.role,
              createdAt: ctx.now(),
            })
            .returning();
      let invited = false;
      if (signIn && (await emailAllowed(auth.orgId)) && (await allowLinkTo(ctx.valkey, email))) {
        const [org] = await ctx.db.select().from(orgs).where(eq(orgs.id, auth.orgId)).limit(1);
        await signIn.mailer.send({
          email,
          purpose: 'invite',
          links: [
            {
              orgId: auth.orgId,
              orgName: org!.name,
              url: await createLoginLink(ctx.valkey, signIn.dashboardUrl, user!),
            },
          ],
        });
        invited = true;
      }
      await audit(ctx, auth, 'user.invite', user!.id, { email, role: body.role, invited });
      return { ...view(user!), invited };
    },
  });

  r.add({
    method: 'patch',
    path: '/v1/users/{id}',
    role: 'owner',
    tag: 'Team',
    summary: "Change a person's role (their current sessions end)",
    params: z.object({ id }),
    body: z.object({ role: z.enum(ROLES) }),
    response: userView,
    handler: async ({ auth, params, body }) => {
      const user = await load(auth.orgId, params.id);
      if (user.role === body.role) return view(user);
      if (user.role === 'owner') await keepAnOwner(auth.orgId, user.id);
      const [row] = await ctx.db
        .update(users)
        .set({ role: body.role })
        .where(eq(users.id, user.id))
        .returning();
      // Tokens carry the role they were issued with: end them so the new role applies.
      await endSessions(ctx.db, auth.orgId, user.id, ctx.now());
      await audit(ctx, auth, 'user.role', user.id, { from: user.role, to: body.role });
      return view(row!);
    },
  });

  r.add({
    method: 'delete',
    path: '/v1/users/{id}',
    role: 'owner',
    tag: 'Team',
    summary: 'Remove a person from the org (their sessions end)',
    params: z.object({ id }),
    response: userView,
    handler: async ({ auth, params }) => {
      const user = await load(auth.orgId, params.id);
      if (user.role === 'owner') await keepAnOwner(auth.orgId, user.id);
      await ctx.db.update(users).set({ removedAt: ctx.now() }).where(eq(users.id, user.id));
      await endSessions(ctx.db, auth.orgId, user.id, ctx.now());
      await audit(ctx, auth, 'user.remove', user.id, { email: user.email });
      return view(user);
    },
  });
}
