import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

// Hop-by-hop headers (RFC 9110 7.6.1) plus ones the proxy owns or replaces.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

const DROP_REQUEST = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  // Client credentials never reach the provider; the adapter injects the real one.
  'authorization',
  'cookie',
  'x-goog-api-key',
  'x-api-key',
  'x-subscription-token',
]);

export function outgoingHeaders(
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const n = name.toLowerCase();
    if (value === undefined || DROP_REQUEST.has(n) || n.startsWith('x-brake-')) continue;
    out[n] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function responseHeaders(
  upstream: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream)) {
    const n = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(n) || n.startsWith('x-brake-')) continue;
    out[n] = value;
  }
  return out;
}

/**
 * Build the upstream URL from a fixed adapter origin and the client's path. The path can never
 * change the host: it is appended after the origin and the result is checked (SSRF guard).
 */
export function upstreamUrl(base: string, path: string, query: URLSearchParams): URL {
  if (!path.startsWith('/')) throw new Error('path must start with /');
  const root = new URL(base);
  const url = new URL(`${root.origin}${path}`);
  if (url.origin !== root.origin) throw new Error('path escapes the upstream origin');
  url.search = query.toString();
  return url;
}

/** Decode a buffered response body for pricing; the client still gets the original bytes. */
export function decodeBody(raw: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return raw;
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(raw);
    case 'deflate':
      return inflateSync(raw);
    case 'br':
      return brotliDecompressSync(raw);
    default:
      throw new Error(`unsupported content-encoding ${encoding}`);
  }
}

/**
 * Parse a body as JSON whatever its content type says (providers treat media types
 * case-insensitively and some clients omit them): a body the classifier cannot see must never
 * price as smaller than it is. A UTF-8 byte-order mark is skipped.
 */
export function parseJson(buf: Buffer | undefined): unknown {
  if (!buf || buf.length === 0) return undefined;
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The request body as the classifier sees it: form-encoded bodies (Twilio) become an object
 * (repeated fields become arrays); anything else is parsed as JSON.
 */
export function parseBody(buf: Buffer | undefined, contentType: string | undefined): unknown {
  if (buf && /application\/x-www-form-urlencoded/i.test(contentType ?? '')) {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) {
      const prev = out[k];
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return out;
  }
  return parseJson(buf);
}
