import { describe, expect, it } from 'vitest';
import { auditSinksFrom, loadEeEnv } from '../src/config.js';

describe('ee settings', () => {
  it('treats empty values (as Compose passes unset ones) as unset', () => {
    const env = loadEeEnv({
      BRAKE_PUBLIC_API_URL: '',
      BRAKE_DASHBOARD_URL: '',
      BRAKE_CATALOG_FEED_URL: '',
      BRAKE_AUDIT_FILE: '',
      BRAKE_AUDIT_SYSLOG: '',
      BRAKE_AUDIT_S3_ENDPOINT: '',
    });
    expect(env.BRAKE_PUBLIC_API_URL).toBeUndefined();
    expect(auditSinksFrom(env)).toEqual([]);
    expect(() => loadEeEnv({ BRAKE_PUBLIC_API_URL: 'not a url' })).toThrow();
    expect(env.ALLOW_PRIVATE_IDP).toBe(false);
    expect(loadEeEnv({ ALLOW_PRIVATE_IDP: 'true' }).ALLOW_PRIVATE_IDP).toBe(true);
  });
});
