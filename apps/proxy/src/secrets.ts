import type { Registry } from '@spend-brake/budget';
import {
  type Envelope,
  type KeyWrapper,
  credentialContext,
  decryptSecret,
} from '@spend-brake/shared';
import { TtlCache } from './cache.js';

/** Resolves a stored provider credential to its secret. Secrets never leave the proxy process. */
export interface SecretStore {
  get(orgId: string, provider: string, credentialId: string): Promise<string>;
}

/**
 * Reads the envelope-encrypted credential the admin API wrote through to Valkey and decrypts it
 * with the master key (local or KMS). The proxy never needs Postgres.
 */
export class EnvelopeSecretStore implements SecretStore {
  constructor(
    private readonly registry: Registry,
    private readonly wrapper: KeyWrapper,
  ) {}

  async get(orgId: string, provider: string, credentialId: string): Promise<string> {
    const c = await this.registry.getCredential(orgId, credentialId);
    if (!c || c.orgId !== orgId || c.provider !== provider) {
      throw new Error(`unknown credential ${credentialId}`);
    }
    return decryptSecret(this.wrapper, c.envelope as Envelope, credentialContext(orgId, c.id));
  }
}

/** Dev store from BRAKE_DEV_SECRETS, used when no master key is configured. */
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
