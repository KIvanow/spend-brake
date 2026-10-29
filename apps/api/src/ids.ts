import { createHash, randomInt } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function random62(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += BASE62[randomInt(62)];
  return s;
}

export const newId = (prefix: string) => `${prefix}_${random62(14)}`;

/** Admin API token: `sbt_` + 32 base62 characters. Only its SHA-256 is stored. */
export const newApiToken = () => `sbt_${random62(32)}`;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
