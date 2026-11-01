import { z } from 'zod';
import type { AuditSink } from './audit/sinks.js';
import { fileSink, s3Sink, syslogSink } from './audit/sinks.js';

const envSchema = z.object({
  /** This API's public URL and the dashboard's: both needed for single sign-on. */
  BRAKE_PUBLIC_API_URL: z.url().optional(),
  BRAKE_DASHBOARD_URL: z.url().optional(),
  BRAKE_SSO_SESSION_HOURS: z.coerce.number().positive().max(24).default(8),
  /** Let an org's OIDC issuer be on a private address (an IdP inside your network). */
  ALLOW_PRIVATE_IDP: z.stringbool().default(false),
  /** Audit export sinks; any combination. */
  BRAKE_AUDIT_FILE: z.string().optional(),
  BRAKE_AUDIT_S3_BUCKET: z.string().optional(),
  BRAKE_AUDIT_S3_PREFIX: z.string().optional(),
  BRAKE_AUDIT_S3_REGION: z.string().optional(),
  BRAKE_AUDIT_S3_ENDPOINT: z.url().optional(),
  BRAKE_AUDIT_SYSLOG: z
    .string()
    .regex(/^(udp|tcp):\/\/[^/]+$/)
    .optional(),
  /** Verified catalog feed; applied into BRAKE_CATALOG_DIR (shared with the proxy). */
  BRAKE_CATALOG_FEED_URL: z.url().optional(),
  BRAKE_CATALOG_DIR: z.string().optional(),
});

export type EeEnv = z.output<typeof envSchema>;

/** Empty values count as unset: Compose passes `${VAR:-}` through as "". */
export const loadEeEnv = (env: NodeJS.ProcessEnv = process.env): EeEnv =>
  envSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));

export function auditSinksFrom(env: EeEnv): AuditSink[] {
  const sinks: AuditSink[] = [];
  if (env.BRAKE_AUDIT_FILE) sinks.push(fileSink(env.BRAKE_AUDIT_FILE));
  if (env.BRAKE_AUDIT_S3_BUCKET) {
    sinks.push(
      s3Sink({
        bucket: env.BRAKE_AUDIT_S3_BUCKET,
        ...(env.BRAKE_AUDIT_S3_PREFIX ? { prefix: env.BRAKE_AUDIT_S3_PREFIX } : {}),
        ...(env.BRAKE_AUDIT_S3_REGION ? { region: env.BRAKE_AUDIT_S3_REGION } : {}),
        ...(env.BRAKE_AUDIT_S3_ENDPOINT ? { endpoint: env.BRAKE_AUDIT_S3_ENDPOINT } : {}),
      }),
    );
  }
  if (env.BRAKE_AUDIT_SYSLOG) sinks.push(syslogSink(env.BRAKE_AUDIT_SYSLOG));
  return sinks;
}
