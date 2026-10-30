import {
  type Db,
  and,
  eq,
  inArray,
  isNull,
  orgs,
  providerCredentials,
  virtualKeys,
  webhookDeliveries,
  webhooks,
} from '@spend-brake/db';
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

/**
 * Names for what an alert is about, so messages say key "web app" and the provider key …a1b2
 * rather than ids: `keyName` (for keyId), `scopeName` (for a key: scope) and, when a provider
 * rejected a key, `credentialHint`. A key deleted since keeps its id.
 */
async function withNames(db: Db, job: AlertJob): Promise<AlertJob> {
  const scopeKey =
    typeof job.scope === 'string' && job.scope.startsWith('key:') ? job.scope.slice(4) : null;
  const ids = [job.keyId, scopeKey].filter((x): x is string => typeof x === 'string' && x !== '');
  if (!job.orgId || ids.length === 0) return job;
  const rows = await db
    .select({ id: virtualKeys.id, name: virtualKeys.name, config: virtualKeys.config })
    .from(virtualKeys)
    .where(and(eq(virtualKeys.orgId, job.orgId), inArray(virtualKeys.id, [...new Set(ids)])));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const key = job.keyId ? byId.get(job.keyId) : undefined;
  const out: AlertJob = { ...job };
  if (key) out.keyName = key.name;
  const scoped = scopeKey ? byId.get(scopeKey) : undefined;
  if (scoped) out.scopeName = scoped.name;
  // The provider key the Spend Brake key calls with (deleted ones still have their hint).
  const credId =
    job.type === 'upstream_key_error' && job.provider
      ? (key?.config as { credentials?: Record<string, string> } | undefined)?.credentials?.[
          job.provider
        ]
      : undefined;
  if (credId) {
    const [cred] = await db
      .select({ hint: providerCredentials.hint })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.id, credId), eq(providerCredentials.orgId, job.orgId)))
      .limit(1);
    if (cred) out.credentialHint = cred.hint;
  }
  return out;
}

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
    await sendMail(
      deps,
      job.email,
      message,
      [],
      job.purpose === 'invite' ? INVITE_FOOTER : LOGIN_FOOTER,
    );
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

  const message = buildMessage(alertId, await withNames(deps.db, job), deps.links);
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
    await sendMail(deps, email, message, [], [actionFooter(deps, message), ALERT_EMAIL_FOOTER]);
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
const INVITE_FOOTER =
  'The link works once, for 15 minutes. If it has expired, enter this email address on the Spend Brake sign-in page to get a new one.';

const ALERT_EMAIL_FOOTER =
  "You get these alerts because this address is your org's alert email. Change it in the Spend Brake dashboard under Webhooks → Alert email.";

/** Only signed action links (kill, raise, mute, reset) expire; a plain View link does not. */
function actionFooter(deps: ProcessorDeps, m: Message): string | null {
  const signed = `${deps.links.publicUrl.replace(/\/$/, '')}/a/`;
  return m.actions.some((a) => a.url.startsWith(signed))
    ? `Action links work once and expire after ${Math.round(deps.links.ttlSec / 60)} minutes.`
    : null;
}

async function sendMail(
  deps: ProcessorDeps,
  to: string,
  m: Message,
  attachments: { filename: string; content: string }[] = [],
  footer: string | (string | null)[] = [actionFooter(deps, m)],
): Promise<void> {
  const links = m.actions.map((a) => `${a.label}: ${a.url}`).join('\n');
  const notes = (Array.isArray(footer) ? footer : [footer]).filter((f) => f !== null);
  await deps.mail!.transport.sendMail({
    from: deps.mail!.from,
    to,
    subject: `[Spend Brake] ${m.title}`,
    text: [m.text, links, ...notes].filter((part) => part !== '').join('\n\n'),
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
