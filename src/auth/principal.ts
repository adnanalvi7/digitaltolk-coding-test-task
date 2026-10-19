import type { TokenScope } from './token-scope';

/** The authenticated caller, attached to the request by the bearer guard. */
export interface AuthPrincipal {
  readonly tokenId: string;
  /** SHA-256 of the presented token (never the token itself); used to evict caches. */
  readonly tokenHash: string;
  readonly userId: string;
  readonly scopes: ReadonlySet<TokenScope>;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthPrincipal;
  }
}
