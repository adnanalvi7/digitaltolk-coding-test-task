import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../common/crypto/hash';

const TOKEN_BYTES = 32;
/** Recognisable prefix so leaked tokens are caught by secret scanners. */
export const TOKEN_PREFIX = 'tms_';
const TOKEN_PATTERN = /^tms_[A-Za-z0-9_-]{43}$/;

export interface GeneratedToken {
  readonly plaintext: string;
  readonly hash: string;
}

export function hashToken(plaintext: string): string {
  return sha256Hex(plaintext);
}

/** 256 bits from the CSPRNG. Only the SHA-256 hash is persisted. */
export function generateToken(): GeneratedToken {
  const plaintext = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { plaintext, hash: hashToken(plaintext) };
}

/** Cheap syntactic pre-check that avoids a DB round trip for garbage input. */
export function isWellFormedToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Constant-time comparison of two equal-length hex digests. */
export function hashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
