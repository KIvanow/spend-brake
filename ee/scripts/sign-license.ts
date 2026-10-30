// Issue a license file. The private key stays with the issuer, never in this repository.
//   pnpm --filter @spend-brake/ee sign-license -- --key ~/.config/spend-brake/license-ed25519.pem \
//     --org acme --edition business --months 12 --org-units 3 > acme.license
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { FEATURES, signLicense } from '../src/license/license.js';

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    org: { type: 'string' },
    edition: { type: 'string', default: 'business' },
    months: { type: 'string', default: '12' },
    'org-units': { type: 'string', default: '1' },
    feature: { type: 'string', multiple: true },
  },
});
if (!values.key || !values.org) throw new Error('--key and --org are required');
const issuedAt = new Date();
const expiresAt = new Date(issuedAt);
expiresAt.setUTCMonth(expiresAt.getUTCMonth() + Number(values.months));
process.stdout.write(
  signLicense(
    {
      id: `lic_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      org: values.org,
      edition: values.edition as 'business' | 'enterprise',
      features: (values.feature as (typeof FEATURES)[number][] | undefined) ?? [...FEATURES],
      orgUnits: Number(values['org-units']),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    readFileSync(values.key, 'utf8'),
  ),
);
