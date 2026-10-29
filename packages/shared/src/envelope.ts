import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Envelope encryption for provider credentials: every secret gets its own random data key
// (AES-256-GCM), and only the data key is wrapped by the master key (a local key from the
// environment, or AWS KMS). Rotating the master key re-wraps data keys; secrets stay untouched.

export interface Envelope {
  v: 1;
  /** Which wrapper wrapped the data key, and its key id (KMS key ARN/alias, or 'local'). */
  wrapper: 'local' | 'kms';
  keyId: string;
  /** base64 */
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface KeyWrapper {
  readonly kind: Envelope['wrapper'];
  readonly keyId: string;
  wrap(dataKey: Buffer, context: Record<string, string>): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: Record<string, string>): Promise<Buffer>;
}

/** Associated data binds a ciphertext to its org and credential, so rows cannot be swapped. */
const aad = (context: Record<string, string>) =>
  Buffer.from(
    Object.keys(context)
      .sort()
      .map((k) => `${k}=${context[k]}`)
      .join('&'),
  );

function seal(key: Buffer, plaintext: Buffer, context: Record<string, string>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function open(
  key: Buffer,
  parts: { iv: Buffer; tag: Buffer; ciphertext: Buffer },
  context: Record<string, string>,
): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(parts.tag);
  return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
}

/** Self-hosted: a 32-byte master key from the environment (base64). */
export class LocalKeyWrapper implements KeyWrapper {
  readonly kind = 'local' as const;
  readonly keyId = 'local';
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    this.key = Buffer.from(masterKeyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('master key must be 32 bytes (base64)');
  }

  wrap(dataKey: Buffer, context: Record<string, string>): Promise<Buffer> {
    const { iv, tag, ciphertext } = seal(this.key, dataKey, context);
    return Promise.resolve(Buffer.concat([iv, tag, ciphertext]));
  }

  unwrap(wrapped: Buffer, context: Record<string, string>): Promise<Buffer> {
    return Promise.resolve(
      open(
        this.key,
        {
          iv: wrapped.subarray(0, 12),
          tag: wrapped.subarray(12, 28),
          ciphertext: wrapped.subarray(28),
        },
        context,
      ),
    );
  }
}

/** The subset of the AWS KMS client this needs, so the SDK stays an app-level dependency. */
export interface KmsLike {
  encrypt(input: {
    KeyId: string;
    Plaintext: Uint8Array;
    EncryptionContext: Record<string, string>;
  }): Promise<{ CiphertextBlob?: Uint8Array }>;
  decrypt(input: {
    KeyId: string;
    CiphertextBlob: Uint8Array;
    EncryptionContext: Record<string, string>;
  }): Promise<{ Plaintext?: Uint8Array }>;
}

export class KmsKeyWrapper implements KeyWrapper {
  readonly kind = 'kms' as const;

  constructor(
    private readonly kms: KmsLike,
    readonly keyId: string,
  ) {}

  async wrap(dataKey: Buffer, context: Record<string, string>): Promise<Buffer> {
    const res = await this.kms.encrypt({
      KeyId: this.keyId,
      Plaintext: dataKey,
      EncryptionContext: context,
    });
    if (!res.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return Buffer.from(res.CiphertextBlob);
  }

  async unwrap(wrapped: Buffer, context: Record<string, string>): Promise<Buffer> {
    const res = await this.kms.decrypt({
      KeyId: this.keyId,
      CiphertextBlob: wrapped,
      EncryptionContext: context,
    });
    if (!res.Plaintext) throw new Error('KMS returned no plaintext');
    return Buffer.from(res.Plaintext);
  }
}

export async function encryptSecret(
  wrapper: KeyWrapper,
  secret: string,
  context: Record<string, string>,
): Promise<Envelope> {
  const dataKey = randomBytes(32);
  try {
    const { iv, tag, ciphertext } = seal(dataKey, Buffer.from(secret, 'utf8'), context);
    const wrappedKey = await wrapper.wrap(dataKey, context);
    return {
      v: 1,
      wrapper: wrapper.kind,
      keyId: wrapper.keyId,
      wrappedKey: wrappedKey.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    dataKey.fill(0);
  }
}

export async function decryptSecret(
  wrapper: KeyWrapper,
  envelope: Envelope,
  context: Record<string, string>,
): Promise<string> {
  if (envelope.v !== 1 || envelope.wrapper !== wrapper.kind) {
    throw new Error(`credential was wrapped by ${envelope.wrapper}, not ${wrapper.kind}`);
  }
  const dataKey = await wrapper.unwrap(Buffer.from(envelope.wrappedKey, 'base64'), context);
  try {
    return open(
      dataKey,
      {
        iv: Buffer.from(envelope.iv, 'base64'),
        tag: Buffer.from(envelope.tag, 'base64'),
        ciphertext: Buffer.from(envelope.ciphertext, 'base64'),
      },
      context,
    ).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}

/** Context every credential is sealed with. */
export const credentialContext = (orgId: string, credentialId: string) => ({
  purpose: 'provider-credential',
  orgId,
  credentialId,
});

/**
 * Build the master-key wrapper from the environment: `BRAKE_KMS_KEY_ID` (AWS KMS; the app must
 * have `@aws-sdk/client-kms` installed) or `BRAKE_MASTER_KEY` (32 bytes, base64). Returns null
 * when neither is set.
 */
export async function keyWrapperFromEnv(
  env: Record<string, string | undefined>,
): Promise<KeyWrapper | null> {
  if (env.BRAKE_KMS_KEY_ID) {
    const sdk = '@aws-sdk/client-kms';
    const { KMSClient, EncryptCommand, DecryptCommand } = (await import(sdk)) as {
      KMSClient: new (cfg: object) => { send(cmd: unknown): Promise<unknown> };
      EncryptCommand: new (input: object) => unknown;
      DecryptCommand: new (input: object) => unknown;
    };
    const client = new KMSClient({});
    const kms: KmsLike = {
      encrypt: (input) => client.send(new EncryptCommand(input)) as ReturnType<KmsLike['encrypt']>,
      decrypt: (input) => client.send(new DecryptCommand(input)) as ReturnType<KmsLike['decrypt']>,
    };
    return new KmsKeyWrapper(kms, env.BRAKE_KMS_KEY_ID);
  }
  if (env.BRAKE_MASTER_KEY) return new LocalKeyWrapper(env.BRAKE_MASTER_KEY);
  return null;
}

/** Context the billing-export service account is sealed with. */
export const billingExportContext = (orgId: string) => ({
  purpose: 'billing-export-service-account',
  orgId,
});
