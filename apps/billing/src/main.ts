import { connectValkey } from '@spend-brake/budget';
import { createDb, migrate } from '@spend-brake/db';
import { queueLoginMailer } from '@spend-brake/api';
import { redactingLoggerOptions } from '@spend-brake/shared';
import { loadEnv } from './config.js';
import { licenseMailer } from './mail.js';
import { buildServer } from './server.js';
import { stripeClient } from './stripe.js';

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
await migrate(db);
const valkey = connectValkey(env.VALKEY_URL, { maxRetriesPerRequest: null });
const mailer = licenseMailer(valkey);
// Sign-up emails the new owner a sign-in link (the notifier sends it).
const loginMailer = env.BRAKE_HOSTED_SIGNUP ? queueLoginMailer(valkey) : null;

const app = await buildServer({
  db,
  valkey,
  stripe: stripeClient(env.STRIPE_SECRET_KEY),
  webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  dashboardUrl: env.BRAKE_DASHBOARD_URL,
  licenseKey: env.licenseKey,
  sendLicense: mailer.send,
  signup: env.BRAKE_HOSTED_SIGNUP,
  ...(loginMailer
    ? { signIn: { dashboardUrl: env.BRAKE_DASHBOARD_URL, mailer: loginMailer } }
    : {}),
  logger: redactingLoggerOptions(env.LOG_LEVEL),
});
if (!env.licenseKey) app.log.warn('no license signing key: Business invoices issue no license');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => mailer.queue.close())
      .then(() => loginMailer?.queue.close())
      .then(() => Promise.all([valkey.quit(), pool.end()]))
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
