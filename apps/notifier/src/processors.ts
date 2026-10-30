import { type Db, and, eq, isNull, orgs, webhookDeliveries, webhooks } from '@spend-brake/db';
import { type AlertJob, type Envelope, type KeyWrapper, decryptSecret } from '@spend-brake/shared';
import type { Queue } from 'bullmq';
import type { ValkeyClient as Redis } from '@spend-brake/budget';
import type { Transporter } from 'nodemailer';
import { type WebhookClient, postWebhook } from './deliver.js';
import { type LinkOptions, type Message, buildMessage } from './message.js';
import { render } from './presets.js';

export interface DeliveryJob {
  webhookId: string;
  orgId: string;
  message: Message;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface ProcessorDeps {
  db: Db;
  valkey: Redis;
  wrapper: KeyWrapper;
  deliveries: Queue<DeliveryJob>;
  links: LinkOptions;
  dispatcher: WebhookClient;
  mail?: { transport: Transporter; from: string; operator?: string | undefined } | undefined;
  log: Logger;
}

/** Same context the API sealed the webhook URL and secret with. */
const webhookContext = (orgId: string, webhookId: string, field: 'url' | 'secret') => ({
  purpose: `webhook-${field}`,
  orgId,
  webhookId,
});

/** The scope an alert is about, for mutes. */
function alertScope(job: AlertJob): string | null {
  if (job.scope) return String(job.scope);
  if (job.type === 'loop' && job.keyId) return `key:${String(job.keyId)}`;
  return null;
}

export type AlertOutcome = 'muted' | 'webhooks' | 'email' | 'none';

/**
 * One alert job: drop it if its scope is muted, otherwise queue one delivery per subscribed
 * webhook; with no webhook, fall back to the org's alert email. Operator alerts (no org) go to
 * the operator email.
 */
export async function processAlert(
  deps: ProcessorDeps,
  alertId: string,
  job: AlertJob,
): Promise<AlertOutcome> {
  // Sign-in links go to that person only: never to webhooks, the operator, or the logs.
  if (job.type === 'login_link') {
    if (!deps.mail || typeof job.email !== 'string') {
      deps.log.warn({ alertId }, 'sign-in link not emailed: no SMTP or address');
      return 'none';
    }
    const message = buildMessage(alertId, job, deps.links);
    await sendMail(deps, job.email, message, [], LOGIN_FOOTER);
    return 'email';
  }
  if (!job.orgId) {
    const message = buildMessage(alertId, job, deps.links);
    if (deps.mail?.operator) {
      await sendMail(deps, deps.mail.operator, message);
      return 'email';
    }
    deps.log.warn(
      { alertId, type: job.type, title: message.title },
      'operator alert (no OPERATOR_EMAIL)',
    );
    return 'none';
  }
  // A license goes to the billing contact only, as an attachment; never to webhooks.
  if (job.type === 'license_issued') {
    const message = buildMessage(alertId, job, deps.links);
    if (!deps.mail || typeof job.email !== 'string') {
      deps.log.warn({ alertId, orgId: job.orgId }, 'license not emailed: no SMTP or address');
      return 'none';
    }
    await sendMail(deps, job.email, message, [
      { filename: `${String(job.orgId)}.license`, content: String(job.license) },
    ]);
    return 'email';
  }
  const scope = alertScope(job);
  if (scope && (await deps.valkey.exists(`bk:{o:${job.orgId}}:mute:${scope}`))) return 'muted';

  const message = buildMessage(alertId, job, deps.links);
  const hooks = (
    await deps.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.orgId, job.orgId), isNull(webhooks.deletedAt)))
  ).filter((w) => w.events.length === 0 || w.events.includes(job.type));
  if (hooks.length > 0) {
    await deps.deliveries.addBulk(
      hooks.map((w) => ({
        name: job.type,
        data: { webhookId: w.id, orgId: job.orgId!, message },
        opts: { jobId: `${alertId}|${w.id}` },
      })),
    );
    return 'webhooks';
  }
  const [org] = await deps.db.select().from(orgs).where(eq(orgs.id, job.orgId)).limit(1);
  const email = (org?.settings as { alertEmail?: string | null } | undefined)?.alertEmail;
  if (email && deps.mail) {
    await sendMail(deps, email, message);
    return 'email';
  }
  deps.log.warn(
    { alertId, orgId: job.orgId, type: job.type },
    'alert dropped: no webhook or email',
  );
  return 'none';
}

const LOGIN_FOOTER =
  "Each link works once, for 15 minutes. If you didn't ask for it, ignore this email: nobody can sign in without it.";

async function sendMail(
  deps: ProcessorDeps,
  to: string,
  m: Message,
  attachments: { filename: string; content: string }[] = [],
  footer = `Action links work once and expire after ${Math.round(deps.links.ttlSec / 60)} minutes.`,
): Promise<void> {
  const links = m.actions.map((a) => `${a.label}: ${a.url}`).join('\n');
  await deps.mail!.transport.sendMail({
    from: deps.mail!.from,
    to,
    subject: `[Spend Brake] ${m.title}`,
    text: `${m.text}\n\n${links}\n\n${footer}`,
    ...(attachments.length ? { attachments } : {}),
  });
}

/** One delivery attempt; throws on failure so BullMQ retries with backoff for about 24 h. */
export async function processDelivery(
  deps: ProcessorDeps,
  d: DeliveryJob,
  attempt: number,
): Promise<void> {
  const [hook] = await deps.db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, d.webhookId), eq(webhooks.orgId, d.orgId)))
    .limit(1);
  if (!hook || hook.deletedAt) return; // deleted since: nothing to do
  const url = await decryptSecret(
    deps.wrapper,
    hook.urlEnvelope as Envelope,
    webhookContext(d.orgId, hook.id, 'url'),
  );
  const secret = await decryptSecret(
    deps.wrapper,
    hook.secretEnvelope as Envelope,
    webhookContext(d.orgId, hook.id, 'secret'),
  );
  const result = await postWebhook(url, secret, render(hook.preset, d.message), {
    dispatcher: deps.dispatcher,
  });
  await deps.db.insert(webhookDeliveries).values({
    orgId: d.orgId,
    webhookId: hook.id,
    alertId: d.message.id,
    type: d.message.type,
    attempt,
    ok: result.ok,
    httpStatus: result.status,
    error: result.error,
  });
  if (!result.ok) throw new Error(`delivery failed: ${result.error ?? 'unknown'}`);
}
