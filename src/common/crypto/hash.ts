import { createHash } from 'node:crypto';

/** SHA-256 as lowercase hex (token storage, rate-limit trackers). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const DEFAULT_DIGEST_CHARS = 16;

/**
 * Short, URL-safe, non-cryptographic-purpose fingerprint (cache keys, ETags).
 * SHA-1 is fine here: collisions only cost a cache miss, never a security issue.
 */
export function shortDigest(value: string, chars = DEFAULT_DIGEST_CHARS): string {
  return createHash('sha1').update(value, 'utf8').digest('base64url').slice(0, chars);
}
