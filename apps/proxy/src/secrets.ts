import { TtlCache } from './cache.js';

/** Resolves a stored provider credential to its secret. Secrets never leave the proxy process. */
export interface SecretStore {
  get(orgId: string, provider: string, credentialId: string): Promise<string>;
}

/** Dev store from BRAKE_DEV_SECRETS. Phase 4 replaces it with envelope-encrypted credentials. */
export class StaticSecretStore implements SecretStore {
  constructor(private readonly secrets: Record<string, string>) {}

  get(_orgId: string, _provider: string, credentialId: string): Promise<string> {
    const secret = this.secrets[credentialId];
    if (secret === undefined)
      return Promise.reject(new Error(`unknown credential ${credentialId}`));
    return Promise.resolve(secret);
  }
}

/** Keeps decrypted secrets in memory for 5 minutes. */
export class CachingSecretStore implements SecretStore {
  private readonly cache = new TtlCache<string>(5 * 60_000, 5 * 60_000);

  constructor(private readonly inner: SecretStore) {}

  async get(orgId: string, provider: string, credentialId: string): Promise<string> {
    const { value } = await this.cache.get(`${orgId}|${provider}|${credentialId}`, () =>
      this.inner.get(orgId, provider, credentialId),
    );
    return value;
  }
}
