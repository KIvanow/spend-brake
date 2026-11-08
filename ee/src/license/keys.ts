// Public halves of the keys that sign licenses and catalog bundles. The private keys never
// enter this repository; whoever issues licenses or catalog updates holds them. The license key
// lives in shared, where the billing service checks its signing key against it.

export { LICENSE_PUBLIC_KEY } from '@spend-brake/shared';

export const CATALOG_FEED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5XMpyl8FUeWWLALFMIftm2lsi2K3EaD1y4gmnUFSWNs=
-----END PUBLIC KEY-----
`;
