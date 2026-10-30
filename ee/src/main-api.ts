// The admin API with the commercial features. Core-only installs run apps/api instead.
import { runApi } from '@spend-brake/api';
import { eeApi } from './api/index.js';
import { loadEeEnv } from './config.js';
import { Entitlements } from './entitlements.js';
import { migrateEe } from './migrate.js';

const env = loadEeEnv();

await runApi({
  prepare: migrateEe,
  extensions: (db, valkey) => [
    eeApi({
      entitlements: new Entitlements(db),
      valkey,
      ...(env.BRAKE_PUBLIC_API_URL && env.BRAKE_DASHBOARD_URL
        ? {
            sso: {
              publicUrl: env.BRAKE_PUBLIC_API_URL,
              dashboardUrl: env.BRAKE_DASHBOARD_URL,
              sessionMs: env.BRAKE_SSO_SESSION_HOURS * 3600_000,
            },
          }
        : {}),
    }),
  ],
});
