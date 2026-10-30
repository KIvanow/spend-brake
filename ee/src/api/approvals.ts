import {
  ApiError,
  type Auth,
  type CapRaise,
  type Ctx,
  type Router,
  audit,
  id,
  n,
  newId,
  notFound,
  toScope,
  writeCap,
} from '@spend-brake/api';
import { and, caps, desc, eq, gt, ne } from '@spend-brake/db';
import { z } from 'zod';
import type { Entitlements } from '../entitlements.js';
import { eeApprovals, eeOrgPolicies, eeSsoConfigs } from '../schema.js';

const TTL_MS = 24 * 3600_000;

const approvalView = z
  .object({
    id: z.string(),
    subject: z.enum(['cap', 'policy']),
    scope: z.string(),
    kind: z.enum(['d', 'm']),
    fromHard: z.number().nullable(),
    toHard: z.number().nullable(),
    toSoft: z.number().nullable(),
    remove: z.boolean(),
    via: z.string(),
    status: z.enum(['pending', 'approved', 'rejected', 'expired']),
    requestedBy: z.string(),
    requestedAt: z.string(),
    expiresAt: z.string(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
  })
  .openapi('CapApproval');

type Row = typeof eeApprovals.$inferSelect;

function view(row: Row, now: Date) {
  const expired = row.status === 'pending' && row.expiresAt <= now;
  return {
    id: row.id,
    subject: row.subject,
    scope: row.scope,
    kind: row.kind,
    fromHard: n(row.fromHardMicros),
    toHard: n(row.toHardMicros),
    toSoft: n(row.toSoftMicros),
    remove: row.remove,
    via: row.via,
    status: expired ? ('expired' as const) : row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/**
 * The person behind a request: only single sign-on tokens name one (`user:<id>`). Plain API
 * tokens do not: any owner can mint more of them, so two tokens are never two people.
 */
/**
 * The person behind a token, when an identity provider vouches for them. Email sign-in links
 * do not count: an owner could invite a second address of their own and approve themselves.
 */
export const personOf = (auth: Auth): string | null =>
  auth.signIn === 'sso' && auth.actor.startsWith('user:') ? auth.actor : null;

const SSO_REQUIRED =
  'With two-person approval on, changes are requested and approved by people signed in with single sign-on.';

async function ssoConfigured(ctx: Ctx, orgId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ orgId: eeSsoConfigs.orgId })
    .from(eeSsoConfigs)
    .where(eq(eeSsoConfigs.orgId, orgId))
    .limit(1);
  return row !== undefined;
}

export async function approvalsOn(ctx: Ctx, orgId: string): Promise<boolean> {
  const [p] = await ctx.db
    .select({ on: eeOrgPolicies.capApprovals })
    .from(eeOrgPolicies)
    .where(eq(eeOrgPolicies.orgId, orgId))
    .limit(1);
  return p?.on === true;
}

/**
 * The holdCapRaise hook. With approvals on, a raise becomes a request a second person must
 * approve; requester and approver are people known to the IdP. Alert links name no person, so
 * they cannot raise. Once the license has turned read-only the hook steps aside: raising caps
 * is a core action and an expired license must never lock an org into its current caps.
 */
export function holdCapRaise(ctx: Ctx, ent: Entitlements) {
  return async (change: CapRaise): Promise<string | null> => {
    if (!(await ent.can('approvals', 'write'))) return null;
    if (!(await approvalsOn(ctx, change.orgId))) return null;
    if (change.via === 'action_link') {
      throw new ApiError(
        403,
        'approval_required',
        'Raising this cap needs a second person: request it in the dashboard.',
      );
    }
    const person = personOf(change.auth);
    if (!person) throw new ApiError(403, 'sso_required', SSO_REQUIRED);
    const approvalId = newId('apr');
    const now = ctx.now();
    await ctx.db.insert(eeApprovals).values({
      id: approvalId,
      orgId: change.orgId,
      scope: change.scope,
      kind: change.kind,
      fromHardMicros: change.from.hard,
      toHardMicros: change.to?.hard ?? null,
      toSoftMicros: change.to?.soft ?? null,
      remove: change.to === null,
      via: change.via,
      requestedBy: person,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    });
    await audit(ctx, { ...change.auth, orgId: change.orgId }, 'cap.raise.requested', approvalId, {
      scope: change.scope,
      kind: change.kind,
      from: n(change.from.hard),
      to: change.to ? n(change.to.hard) : null,
      via: change.via,
    });
    return approvalId;
  };
}

export function approvalRoutes(r: Router, ctx: Ctx, ent: Entitlements): void {
  r.add({
    method: 'get',
    path: '/v1/approvals/policy',
    role: 'viewer',
    tag: 'Approvals',
    summary: 'Whether raising or removing a hard cap needs a second person',
    response: z.object({ capApprovals: z.boolean() }),
    handler: async ({ auth }) => {
      await ent.require('approvals', 'read');
      return { capApprovals: await approvalsOn(ctx, auth.orgId) };
    },
  });

  r.add({
    method: 'put',
    path: '/v1/approvals/policy',
    role: 'owner',
    tag: 'Approvals',
    summary: 'Require (or stop requiring) a second person to raise or remove a hard cap',
    body: z.object({ capApprovals: z.boolean() }),
    response: z.object({ capApprovals: z.boolean(), pendingApproval: z.string().optional() }),
    handler: async ({ auth, body }) => {
      await ent.require('approvals', 'write');
      const on = await approvalsOn(ctx, auth.orgId);
      if (body.capApprovals === on) return { capApprovals: on };
      if (body.capApprovals && !(await ssoConfigured(ctx, auth.orgId))) {
        throw new ApiError(
          409,
          'sso_required',
          'Configure single sign-on first: approvals are between people the IdP knows.',
        );
      }
      if (!body.capApprovals) {
        // Switching the rule off is itself a change a second person approves.
        const person = personOf(auth);
        if (!person) throw new ApiError(403, 'sso_required', SSO_REQUIRED);
        const now = ctx.now();
        const approvalId = newId('apr');
        await ctx.db.insert(eeApprovals).values({
          id: approvalId,
          orgId: auth.orgId,
          subject: 'policy',
          scope: 'approvals',
          kind: 'd',
          remove: true,
          via: 'api',
          requestedBy: person,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + TTL_MS),
        });
        await audit(ctx, auth, 'approvals.policy.requested', approvalId, { capApprovals: false });
        return { capApprovals: true, pendingApproval: approvalId };
      }
      const row = { orgId: auth.orgId, capApprovals: body.capApprovals, updatedAt: ctx.now() };
      await ctx.db
        .insert(eeOrgPolicies)
        .values(row)
        .onConflictDoUpdate({ target: eeOrgPolicies.orgId, set: row });
      await audit(ctx, auth, 'approvals.policy', 'org', { capApprovals: body.capApprovals });
      return { capApprovals: body.capApprovals };
    },
  });

  r.add({
    method: 'get',
    path: '/v1/approvals',
    role: 'viewer',
    tag: 'Approvals',
    summary: 'Cap raises waiting for (or decided by) a second person',
    query: z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }),
    response: z.object({ items: z.array(approvalView) }),
    handler: async ({ auth, query }) => {
      await ent.require('approvals', 'read');
      const rows = await ctx.db
        .select()
        .from(eeApprovals)
        .where(
          and(
            eq(eeApprovals.orgId, auth.orgId),
            query.status ? eq(eeApprovals.status, query.status) : undefined,
          ),
        )
        .orderBy(desc(eeApprovals.requestedAt))
        .limit(200);
      return { items: rows.map((row) => view(row, ctx.now())) };
    },
  });

  const decide = (decision: 'approved' | 'rejected') =>
    r.add({
      method: 'post',
      path: `/v1/approvals/{id}/${decision === 'approved' ? 'approve' : 'reject'}`,
      role: 'admin',
      tag: 'Approvals',
      summary:
        decision === 'approved'
          ? 'Approve a cap raise (anyone but the person who asked) and apply it'
          : 'Reject a cap raise',
      params: z.object({ id }),
      body: z.object({ reason: z.string().max(500).optional() }).optional(),
      response: approvalView,
      handler: async ({ auth, params, body }) => {
        await ent.require('approvals', 'write');
        const person = personOf(auth);
        if (!person) throw new ApiError(403, 'sso_required', SSO_REQUIRED);
        const [target] = await ctx.db
          .select({ subject: eeApprovals.subject })
          .from(eeApprovals)
          .where(and(eq(eeApprovals.id, params.id), eq(eeApprovals.orgId, auth.orgId)))
          .limit(1);
        if (target?.subject === 'policy' && auth.role !== 'owner') {
          throw new ApiError(403, 'forbidden', 'Only an owner decides on switching approvals off.');
        }
        const now = ctx.now();
        // One statement decides: it only matches a pending, unexpired request someone else made,
        // so two approvers (or a double click) cannot both apply it.
        const [row] = await ctx.db
          .update(eeApprovals)
          .set({ status: decision, decidedBy: auth.actor, decidedAt: now, reason: body?.reason })
          .where(
            and(
              eq(eeApprovals.id, params.id),
              eq(eeApprovals.orgId, auth.orgId),
              eq(eeApprovals.status, 'pending'),
              gt(eeApprovals.expiresAt, now),
              ne(eeApprovals.requestedBy, person),
            ),
          )
          .returning();
        if (!row) {
          const [existing] = await ctx.db
            .select()
            .from(eeApprovals)
            .where(and(eq(eeApprovals.id, params.id), eq(eeApprovals.orgId, auth.orgId)))
            .limit(1);
          if (!existing) throw notFound('Approval');
          if (existing.status === 'pending' && existing.requestedBy === person) {
            throw new ApiError(
              403,
              'second_person_required',
              'A cap raise must be approved by someone other than the person who asked.',
            );
          }
          throw new ApiError(409, 'not_pending', 'This request was already decided or expired.');
        }
        if (decision === 'approved') await apply(ctx, row);
        await audit(ctx, auth, `cap.raise.${decision}`, row.id, {
          scope: row.scope,
          kind: row.kind,
          requestedBy: row.requestedBy,
          to: row.remove ? null : n(row.toHardMicros),
        });
        return view(row, now);
      },
    });
  decide('approved');
  decide('rejected');
}

async function apply(ctx: Ctx, row: Row): Promise<void> {
  if (row.subject === 'policy') {
    await ctx.db
      .update(eeOrgPolicies)
      .set({ capApprovals: false, updatedAt: ctx.now() })
      .where(eq(eeOrgPolicies.orgId, row.orgId));
    return;
  }
  if (row.remove) {
    await ctx.engine.deleteCap(row.orgId, toScope(row.scope), row.kind);
    await ctx.db
      .delete(caps)
      .where(and(eq(caps.orgId, row.orgId), eq(caps.scope, row.scope), eq(caps.kind, row.kind)));
    return;
  }
  await writeCap(ctx, row.orgId, row.scope, row.kind, {
    hard: row.toHardMicros,
    soft: row.toSoftMicros,
  });
}
