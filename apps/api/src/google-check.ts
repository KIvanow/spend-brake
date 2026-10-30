/**
 * Best-effort check that a Google key is restricted, run when the key is added. It calls a free
 * Google API the proxy never needs (the Generative Language model list) with the key:
 *
 * - `API_KEY_SERVICE_BLOCKED`: the key has API restrictions. Good.
 * - `API_KEY_IP_ADDRESS_BLOCKED`: the key is restricted to other IPs (e.g. the proxy's). Good.
 * - 200 or `SERVICE_DISABLED`: the key can call APIs beyond Maps, i.e. it has no API
 *   restrictions. Warn.
 * - `API_KEY_INVALID`: the key is wrong. Warn.
 *
 * Nothing is billed: the probe endpoint is free and Maps APIs are never called.
 */
export interface KeyCheck {
  apiRestricted: boolean | null;
  ipRestricted: boolean | null;
  valid: boolean | null;
  warnings: string[];
}

const PROBE = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';

export async function checkGoogleKey(
  key: string,
  fetchFn: typeof fetch = fetch,
  /** The addresses the proxy calls Google from, when the operator configured them. */
  egressIps: readonly string[] = [],
): Promise<KeyCheck> {
  const check: KeyCheck = { apiRestricted: null, ipRestricted: null, valid: null, warnings: [] };
  let status: number;
  let reasons: string[];
  try {
    const res = await fetchFn(PROBE, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(5_000),
    });
    status = res.status;
    const body = (await res.json().catch(() => ({}))) as {
      error?: { details?: { reason?: string }[] };
    };
    reasons = (body.error?.details ?? []).map((d) => d.reason ?? '').filter(Boolean);
  } catch {
    check.warnings.push('Could not reach Google to check the key restrictions.');
    return check;
  }
  if (reasons.includes('API_KEY_INVALID')) {
    check.valid = false;
    check.warnings.push('Google says this API key is not valid.');
    return check;
  }
  check.valid = true;
  if (reasons.includes('API_KEY_SERVICE_BLOCKED')) check.apiRestricted = true;
  if (reasons.includes('API_KEY_IP_ADDRESS_BLOCKED')) check.ipRestricted = true;
  if (status === 200 || reasons.includes('SERVICE_DISABLED')) {
    check.apiRestricted = false;
    check.warnings.push(
      'This key has no API restrictions: restrict it to Places API (New), Geocoding API and Routes API.',
    );
  }
  if (check.ipRestricted !== true) {
    check.warnings.push(
      egressIps.length
        ? `Restrict the key to IP address${egressIps.length > 1 ? 'es' : ''} ${egressIps.join(', ')} (where Spend Brake calls Google from), so a leaked copy of the key cannot be used anywhere else.`
        : "Restrict the key to the proxy's egress IPs so the proxy is the only path to spend (brake init prints the steps).",
    );
  }
  return check;
}
