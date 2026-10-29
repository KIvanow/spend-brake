import type { Command } from 'commander';
import { apiCall } from '../admin.js';
import { CliError, EXIT, type Io, config, saveConfig, usdToMicros } from '../io.js';

/** Google services the proxy calls. Legacy ones only matter if your app uses them. */
export const GOOGLE_SERVICES = [
  { api: 'Places API (New)', service: 'places.googleapis.com' },
  { api: 'Geocoding API', service: 'geocoding-backend.googleapis.com' },
  { api: 'Routes API', service: 'routes.googleapis.com' },
];
export const LEGACY_SERVICES = [
  { api: 'Places API (Legacy)', service: 'places-backend.googleapis.com' },
  { api: 'Directions API (Legacy)', service: 'directions-backend.googleapis.com' },
  { api: 'Distance Matrix API (Legacy)', service: 'distance-matrix-backend.googleapis.com' },
];

/** The exact steps that make the proxy the only path to spend on the real key. */
export function restrictionSteps(egressIps: string[]): string {
  const ips = egressIps.length ? egressIps.join(',') : '<PROXY_EGRESS_IP>';
  return [
    'Restrict the real Google key so the proxy is the only way to spend on it:',
    '',
    '  1. Application restriction: IP addresses, allow only the proxy egress IPs:',
    `       ${ips}`,
    '  2. API restriction: only the APIs the proxy calls:',
    ...GOOGLE_SERVICES.map((s) => `       ${s.api} (${s.service})`),
    '     plus, only if your app uses them:',
    ...LEGACY_SERVICES.map((s) => `       ${s.api} (${s.service})`),
    '',
    '  With gcloud (find KEY_ID with `gcloud services api-keys list`):',
    '',
    '    gcloud services api-keys update KEY_ID \\',
    ...GOOGLE_SERVICES.map((s) => `      --api-target=service=${s.service} \\`),
    `      --allowed-ips=${ips}`,
    '',
    '  Or in the console: https://console.cloud.google.com/apis/credentials, open the key,',
    '  set "Application restrictions" to IP addresses and "API restrictions" to the list above.',
    ...(egressIps.length
      ? []
      : ['', '  Find the egress IP by running `curl https://api.ipify.org` on the proxy host.']),
  ].join('\n');
}

interface InitOptions {
  apiUrl?: string;
  proxyUrl?: string;
  setupToken?: string;
  org?: string;
  name?: string;
  tz: string;
  googleKey?: string;
  egressIp?: string[];
  dayCap?: string;
  monthCap?: string;
  json?: boolean;
}

/**
 * First-run wizard: create the org (with the API's BRAKE_SETUP_TOKEN), store the Google key
 * encrypted, create a virtual key, optionally cap the org, save the admin token locally (0600)
 * and print the Google Cloud steps that restrict the real key to the proxy.
 */
export function initCommand(program: Command, io: Io, done: (code: number) => void): void {
  program
    .command('init')
    .description('Set up a new install: org, Google key, first virtual key, caps')
    .option('--api-url <url>', 'admin API URL')
    .option('--proxy-url <url>', 'proxy URL your apps will call')
    .option('--setup-token <token>', "the API's BRAKE_SETUP_TOKEN (or env BRAKE_SETUP_TOKEN)")
    .option('--org <id>', 'org id, e.g. acme')
    .option('--name <name>', 'org display name')
    .option('--tz <zone>', 'time zone for daily caps', 'UTC')
    .option('--google-key <key>', 'the real Google key, stored encrypted (or env GOOGLE_MAPS_KEY)')
    .option('--egress-ip <ip...>', "the proxy's public egress IP(s), for the key restriction")
    .option('--day-cap <usd>', 'org hard cap per day')
    .option('--month-cap <usd>', 'org hard cap per month')
    .option('--json', 'print a JSON result instead of instructions')
    .action(async (o: InitOptions) => {
      const ask = async (
        value: string | undefined,
        question: string,
        secret = false,
        def?: string,
      ) => {
        if (value) return value;
        if (!io.prompt) throw new CliError(`Missing ${question} (pass it as a flag).`, EXIT.usage);
        const answer = (
          await io.prompt(question, { secret, ...(def ? { default: def } : {}) })
        ).trim();
        if (!answer && def) return def;
        if (!answer) throw new CliError(`${question} is required.`, EXIT.usage);
        return answer;
      };
      const current = config(io);
      const apiUrl = (await ask(o.apiUrl, 'Admin API URL', false, current.apiUrl)).replace(
        /\/$/,
        '',
      );
      const proxyUrl = (await ask(o.proxyUrl, 'Proxy URL', false, current.proxyUrl)).replace(
        /\/$/,
        '',
      );
      // Secrets come from the environment or a prompt; flags work but land in shell history.
      const setupToken = await ask(
        o.setupToken ?? io.env.BRAKE_SETUP_TOKEN,
        'Setup token (BRAKE_SETUP_TOKEN)',
        true,
      );
      const orgId = await ask(o.org, 'Org id');
      const googleKey = await ask(
        o.googleKey ?? io.env.GOOGLE_MAPS_KEY,
        'Google Maps Platform API key (GOOGLE_MAPS_KEY)',
        true,
      );
      const caps = {
        ...(o.dayCap ? { day: { hard: usdToMicros(o.dayCap).toString() } } : {}),
        ...(o.monthCap ? { month: { hard: usdToMicros(o.monthCap).toString() } } : {}),
      };
      const scoped: Io = { ...io, env: { ...io.env, BRAKE_API_URL: apiUrl } };

      const setup = await apiCall<{ orgId: string; ownerToken: string }>(
        scoped,
        'POST',
        '/v1/setup',
        { setupToken, orgId, name: o.name ?? orgId, timeZone: o.tz },
        {},
      );
      const owner: Io = { ...scoped, env: { ...scoped.env, BRAKE_ADMIN_TOKEN: setup.ownerToken } };
      // Only an admin token is saved on this machine. The owner token (tokens, org settings) is
      // printed once for a password manager: an agent running as this user can read the saved
      // file, and must not be able to mint tokens or change the org.
      const adminToken = await apiCall<{ token: string }>(owner, 'POST', '/v1/tokens', {
        name: 'brake cli',
        role: 'admin',
      });
      const path = saveConfig(io, {
        apiUrl,
        proxyUrl,
        adminToken: adminToken.token,
        orgId: setup.orgId,
      });
      const admin: Io = { ...scoped, env: { ...scoped.env, BRAKE_ADMIN_TOKEN: adminToken.token } };

      const cred = await apiCall<{
        id: string;
        check?: { warnings: string[]; apiRestricted: boolean | null; ipRestricted: boolean | null };
      }>(admin, 'POST', '/v1/providers/credentials', {
        provider: 'google-maps',
        name: 'google',
        secret: googleKey,
      });
      const key = await apiCall<{ id: string; token: string }>(admin, 'POST', '/v1/keys', {
        name: 'default',
        credentials: { 'google-maps': cred.id },
        canMintSessions: true,
      });
      if (caps.day || caps.month) await apiCall(admin, 'PUT', '/v1/caps/org', caps);

      const result = {
        orgId: setup.orgId,
        configPath: path,
        credentialId: cred.id,
        keyCheck: cred.check ?? null,
        virtualKey: { id: key.id, token: key.token },
        ownerToken: setup.ownerToken,
        proxyUrl,
      };
      if (o.json) {
        io.stdout(`${JSON.stringify(result)}\n`);
      } else {
        io.stdout(
          [
            `Org ${setup.orgId} is ready. An admin token is saved to ${path} (mode 0600).`,
            '',
            'Owner token (shown once, not saved; keep it in a password manager):',
            `  ${setup.ownerToken}`,
            '',
            'Your virtual key (shown once, store it now):',
            `  ${key.token}`,
            '',
            'Use it instead of the Google key, with the proxy as the base URL:',
            `  ${proxyUrl}/google-maps/maps/api/geocode/json?address=Sofia&key=${key.token}`,
            `  ${proxyUrl}/google-places/v1/places:searchText   (X-Goog-Api-Key: ${key.token})`,
            '',
            ...(cred.check?.warnings.length
              ? ['Key check:', ...cred.check.warnings.map((w) => `  ! ${w}`), '']
              : []),
            restrictionSteps(o.egressIp ?? []),
            '',
            'Remove BRAKE_SETUP_TOKEN from the API environment now.',
            '',
          ].join('\n'),
        );
      }
      done(EXIT.ok);
    });
}
