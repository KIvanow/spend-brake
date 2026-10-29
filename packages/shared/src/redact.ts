// Secrets must never reach logs, traces or error bodies: provider keys, virtual keys and auth
// headers are replaced before anything is written.

export const REDACTED = '[redacted]';

/** Lower-cased header names that carry credentials. */
export const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-brake-key',
  'x-goog-api-key',
  'x-api-key',
  'api-key',
]);

/** Query parameters that carry credentials (compared case-insensitively). */
export const SECRET_PARAMS = new Set([
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'signature',
  'client_secret',
]);

const VIRTUAL_KEY = /sb_(live|test)_[A-Za-z0-9]+/g;

/** Redact secret query parameters in a URL or path; leaves everything else as it was. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url.replace(VIRTUAL_KEY, REDACTED);
  const params = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = decodeURIComponentSafe(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
      return SECRET_PARAMS.has(name) && eq !== -1 ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
    });
  return `${url.slice(0, q)}?${params.join('&')}`.replace(VIRTUAL_KEY, REDACTED);
}

export function redactHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[] | number | undefined> {
  const out: Record<string, string | string[] | number | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/** Remove anything shaped like a virtual key or a known secret from free text. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(VIRTUAL_KEY, REDACTED);
  for (const s of secrets) if (s) out = out.split(s).join(REDACTED);
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * pino/Fastify logger options that keep credentials out of every line: URLs lose secret query
 * parameters and credential headers are censored wherever they appear.
 */
export function redactingLoggerOptions(level: string) {
  return {
    level,
    serializers: {
      req: (req: { method: string; url: string; ip?: string }) => ({
        method: req.method,
        url: redactUrl(req.url),
        remoteAddress: req.ip ?? '',
      }),
    },
    redact: {
      paths: [...SECRET_HEADERS].flatMap((h) => [`req.headers["${h}"]`, `headers["${h}"]`]),
      censor: REDACTED,
    },
  };
}
