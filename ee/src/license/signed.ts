import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';

// A signed document: the payload's exact bytes (base64url) and an Ed25519 signature over them.
// Signing bytes rather than re-serialized JSON means nothing about key order or whitespace can
// make a verifier accept something the signer did not sign.

const envelope = z.strictObject({
  format: z.string(),
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

export class SignatureError extends Error {
  constructor(
    readonly code: 'malformed' | 'bad_signature',
    message: string,
  ) {
    super(message);
  }
}

export function signDocument(format: string, payload: unknown, privateKeyPem: string): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, bytes, createPrivateKey(privateKeyPem));
  return `${JSON.stringify({
    format,
    payload: bytes.toString('base64url'),
    signature: signature.toString('base64url'),
  })}\n`;
}

/** The verified payload as parsed JSON; throws SignatureError when anything is off. */
export function verifyDocument(text: string, format: string, publicKeyPem: string): unknown {
  let doc: z.infer<typeof envelope>;
  try {
    doc = envelope.parse(JSON.parse(text));
  } catch {
    throw new SignatureError('malformed', 'Not a signed document.');
  }
  if (doc.format !== format) throw new SignatureError('malformed', `Expected a ${format} file.`);
  const bytes = Buffer.from(doc.payload, 'base64url');
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('verification key must be Ed25519');
  if (!verify(null, bytes, key, Buffer.from(doc.signature, 'base64url'))) {
    throw new SignatureError('bad_signature', 'The signature does not match.');
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new SignatureError('malformed', 'The signed payload is not JSON.');
  }
}
