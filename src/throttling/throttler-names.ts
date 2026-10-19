/** Named rate-limit buckets. */
export const ThrottlerName = {
  /** Token issuance: per (IP, email) — brute force against one account. */
  Auth: 'auth',
  /** Failed authentications (bad tokens, bad passwords): per IP. */
  AuthFailure: 'auth-failure',
  /** General API budget: per *verified* token. */
  Api: 'api',
  /** Export budget: per verified token (per IP when the export is public). */
  Export: 'export',
} as const;

export type ThrottlerName = (typeof ThrottlerName)[keyof typeof ThrottlerName];
