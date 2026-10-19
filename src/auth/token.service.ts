import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/app-config';
import { BoundedLru } from '../common/cache/bounded-lru';
import { Clock } from '../common/clock';
import { MS_PER_SECOND } from '../common/units';
import {
  DomainValidationError,
  InvalidCredentialsError,
  InvalidTokenError,
  ScopeNotGrantableError,
} from '../common/errors/errors';
import { PasswordHasher } from './password-hasher';
import type { AuthPrincipal } from './principal';
import { TokenRepository } from './repositories/token.repository';
import { UserRepository } from './repositories/user.repository';
import { generateToken, hashToken, hashesMatch, isWellFormedToken } from './token-crypto';
import { type TokenScope, isTokenScope } from './token-scope';

export interface IssueTokenCommand {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly scopes: readonly TokenScope[] | undefined;
  readonly ttlSeconds: number | undefined;
}

export interface IssuedToken {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  readonly scopes: readonly TokenScope[];
  readonly expiresAt: Date;
}

/** Upper bound on cached verified tokens per instance (memory bound). */
const TOKEN_CACHE_MAX_ENTRIES = 10_000;

interface VerifiedToken {
  readonly principal: AuthPrincipal;
  readonly expiresAt: number;
}

@Injectable()
export class TokenService {
  private readonly auth: AppConfig['auth'];
  private readonly verified: BoundedLru<string, VerifiedToken>;

  constructor(
    private readonly users: UserRepository,
    private readonly tokens: TokenRepository,
    private readonly passwords: PasswordHasher,
    private readonly clock: Clock,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.auth = config.get('auth', { infer: true });
    this.verified = new BoundedLru({
      maxWeight: TOKEN_CACHE_MAX_ENTRIES,
      ttlMs: this.auth.tokenCacheMs,
      now: () => clock.now().getTime(),
    });
  }

  /** Exchanges credentials for a new opaque token. The plaintext is returned exactly once. */
  async issue(command: IssueTokenCommand): Promise<IssuedToken> {
    const user = await this.users.findCredentialsByEmail(command.email);
    if (!user) {
      await this.passwords.verifyAgainstDummy(command.password);
      throw new InvalidCredentialsError();
    }
    if (!(await this.passwords.verify(user.passwordHash, command.password))) {
      throw new InvalidCredentialsError();
    }

    const grantable = user.scopes.filter(isTokenScope);
    const scopes = command.scopes ?? grantable;
    const notGrantable = scopes.filter((scope) => !grantable.includes(scope));
    if (notGrantable.length > 0) throw new ScopeNotGrantableError(notGrantable);

    const ttlSeconds = command.ttlSeconds ?? this.auth.defaultTokenTtlSeconds;
    if (ttlSeconds > this.auth.maxTokenTtlSeconds) {
      throw new DomainValidationError([
        {
          field: 'ttlSeconds',
          message: `ttlSeconds must not be greater than ${this.auth.maxTokenTtlSeconds}`,
        },
      ]);
    }

    const { plaintext, hash } = generateToken();
    const expiresAt = new Date(this.clock.now().getTime() + ttlSeconds * MS_PER_SECOND);
    const id = await this.tokens.insert({
      userId: user.id,
      name: command.name,
      tokenHash: hash,
      scopes,
      expiresAt,
    });
    return { id, token: plaintext, name: command.name, scopes, expiresAt };
  }

  /**
   * Resolves a bearer token to a principal, or throws {@link InvalidTokenError}.
   *
   * Verified tokens are cached per instance for AUTH_TOKEN_CACHE_MS (default
   * 5 s) to take a Postgres round trip off every request. Expiry is still
   * checked on each hit; revocation evicts locally at once and reaches other
   * instances within the cache TTL (set it to 0 for immediate global revocation).
   */
  async authenticate(plaintext: string): Promise<AuthPrincipal> {
    const cached = this.fromCache(plaintext);
    if (cached) return cached;
    if (!isWellFormedToken(plaintext)) throw new InvalidTokenError('malformed');
    const hash = hashToken(plaintext);
    const now = this.clock.now();

    const stored = await this.tokens.findByHash(hash);
    if (!stored || !hashesMatch(stored.tokenHash, hash)) throw new InvalidTokenError('unknown');
    if (stored.revokedAt !== null) throw new InvalidTokenError('revoked');
    if (stored.expiresAt.getTime() <= now.getTime()) throw new InvalidTokenError('expired');

    await this.recordUsage(stored.id, stored.lastUsedAt, now);
    const principal: AuthPrincipal = {
      tokenId: stored.id,
      tokenHash: hash,
      userId: stored.userId,
      scopes: new Set(stored.scopes.filter(isTokenScope)),
    };
    if (this.auth.tokenCacheMs > 0) {
      this.verified.set(hash, { principal, expiresAt: stored.expiresAt.getTime() });
    }
    return principal;
  }

  /**
   * The cached principal for a still-valid, recently verified token, without
   * any I/O; undefined on a miss. Lets callers skip work that only protects
   * the database lookup (e.g. the per-IP failure check).
   */
  fromCache(plaintext: string): AuthPrincipal | undefined {
    if (!isWellFormedToken(plaintext)) return undefined;
    const hash = hashToken(plaintext);
    const cached = this.verified.get(hash);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.clock.now().getTime()) {
      this.verified.delete(hash);
      return undefined; // re-verified against the database, which reports `expired`
    }
    return cached.principal;
  }

  async revoke(principal: AuthPrincipal): Promise<void> {
    await this.tokens.revoke(principal.tokenId, this.clock.now());
    this.verified.delete(principal.tokenHash);
  }

  /** Throttled write: at most one `last_used_at` update per token per interval. */
  private async recordUsage(tokenId: string, lastUsedAt: Date | null, now: Date): Promise<void> {
    const staleBefore = new Date(
      now.getTime() - this.auth.lastUsedWriteIntervalSeconds * MS_PER_SECOND,
    );
    if (lastUsedAt !== null && lastUsedAt.getTime() >= staleBefore.getTime()) return;
    await this.tokens.touchLastUsed(tokenId, now, staleBefore);
  }
}
