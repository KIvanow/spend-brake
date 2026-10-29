import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type KmsLike,
  KmsKeyWrapper,
  LocalKeyWrapper,
  credentialContext,
  decryptSecret,
  encryptSecret,
} from '../src/envelope.js';

const master = () => randomBytes(32).toString('base64');
const ctx = credentialContext('org1', 'cred1');

describe('envelope encryption', () => {
  it('round-trips a secret and never stores it in the clear', async () => {
    const w = new LocalKeyWrapper(master());
    const env = await encryptSecret(w, 'AIzaSyREAL', ctx);
    expect(JSON.stringify(env)).not.toContain('AIzaSyREAL');
    expect(await decryptSecret(w, env, ctx)).toBe('AIzaSyREAL');
  });

  it('uses a fresh data key and IV for every secret', async () => {
    const w = new LocalKeyWrapper(master());
    const a = await encryptSecret(w, 'same', ctx);
    const b = await encryptSecret(w, 'same', ctx);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it('rejects the wrong master key, a tampered ciphertext or another context', async () => {
    const w = new LocalKeyWrapper(master());
    const env = await encryptSecret(w, 'secret', ctx);
    await expect(decryptSecret(new LocalKeyWrapper(master()), env, ctx)).rejects.toThrow();
    const flipped = Buffer.from(env.ciphertext, 'base64');
    flipped[0]! ^= 1;
    await expect(
      decryptSecret(w, { ...env, ciphertext: flipped.toString('base64') }, ctx),
    ).rejects.toThrow();
    await expect(decryptSecret(w, env, credentialContext('org2', 'cred1'))).rejects.toThrow();
    await expect(decryptSecret(w, env, credentialContext('org1', 'cred2'))).rejects.toThrow();
  });

  it('rejects master keys of the wrong size', () => {
    expect(() => new LocalKeyWrapper(randomBytes(16).toString('base64'))).toThrow();
  });

  it('wraps data keys with KMS, passing the encryption context', async () => {
    const calls: Record<string, string>[] = [];
    const local = new LocalKeyWrapper(master());
    const fake: KmsLike = {
      async encrypt(i) {
        calls.push(i.EncryptionContext);
        return { CiphertextBlob: await local.wrap(Buffer.from(i.Plaintext), i.EncryptionContext) };
      },
      async decrypt(i) {
        calls.push(i.EncryptionContext);
        return {
          Plaintext: await local.unwrap(Buffer.from(i.CiphertextBlob), i.EncryptionContext),
        };
      },
    };
    const w = new KmsKeyWrapper(fake, 'alias/spend-brake');
    const env = await encryptSecret(w, 'kms-secret', ctx);
    expect(env).toMatchObject({ wrapper: 'kms', keyId: 'alias/spend-brake' });
    expect(await decryptSecret(w, env, ctx)).toBe('kms-secret');
    expect(calls).toEqual([ctx, ctx]);
    await expect(decryptSecret(local, env, ctx)).rejects.toThrow(/wrapped by kms/);
  });
});
