import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/app-config';
import type { Clock } from '../common/clock';
import {
  DomainValidationError,
  InvalidCredentialsError,
  InvalidTokenError,
  ScopeNotGrantableError,
} from '../common/errors/errors';
import type { PasswordHasher } from './password-hasher';
import type { StoredToken, TokenRepository } from './repositories/token.repository';
import type { UserRepository } from './repositories/user.repository';
import { generateToken, hashToken, hashesMatch, isWellFormedToken } from './token-crypto';
import { TokenService } from './token.service';
import { TokenScope } from './token-scope';

const NOW = new Date('2026-01-01T00:00:00Z');
const AUTH: AppConfig['auth'] = {
  defaultTokenTtlSeconds: 3600,
  maxTokenTtlSeconds: 7200,
  lastUsedWriteIntervalSeconds: 60,
  tokenCacheMs: 0,
  adminEmail: undefined,
  adminPassword: undefined,
};

function setup(overrides: Partial<AppConfig['auth']> = {}, clockNow: () => Date = () => NOW) {
  const users: jest.Mocked<UserRepository> = {
    findCredentialsByEmail: jest.fn(),
    upsert: jest.fn(),
  };
  const tokens: jest.Mocked<TokenRepository> = {
    insert: jest.fn().mockResolvedValue('11'),
    findByHash: jest.fn(),
    revoke: jest.fn(),
    touchLastUsed: jest.fn(),
  };
  const passwords: jest.Mocked<PasswordHasher> = {
    hash: jest.fn(),
    verify: jest.fn(),
    verifyAgainstDummy: jest.fn(),
  };
  const clock: Clock = { now: clockNow };
  const config = {
    get: () => ({ ...AUTH, ...overrides }),
  } as unknown as ConfigService<AppConfig, true>;
  const service = new TokenService(users, tokens, passwords, clock, config);
  return { service, users, tokens, passwords };
}

const issueCommand = {
  email: 'admin@example.com',
  password: 'correct horse',
  name: 'ci',
  scopes: undefined,
  ttlSeconds: undefined,
};

function stored(plaintext: string, overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    id: '5',
    userId: '1',
    tokenHash: hashToken(plaintext),
    scopes: [TokenScope.TranslationsRead, 'legacy:unknown'],
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe('token crypto', () => {
  it('generates 256-bit prefixed tokens and stores only a SHA-256 hex digest', () => {
    const { plaintext, hash } = generateToken();
    expect(isWellFormedToken(plaintext)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken(plaintext));
    expect(generateToken().plaintext).not.toBe(plaintext);
  });

  it('compares digests in constant time and handles length mismatch', () => {
    const digest = hashToken('x');
    expect(hashesMatch(digest, digest)).toBe(true);
    expect(hashesMatch(digest, hashToken('y'))).toBe(false);
    expect(hashesMatch(digest, 'abcd')).toBe(false);
  });
});

describe('TokenService.issue', () => {
  it('issues a token with all grantable scopes by default and the default TTL', async () => {
    const { service, users, passwords, tokens } = setup();
    users.findCredentialsByEmail.mockResolvedValue({
      id: '1',
      passwordHash: 'h',
      scopes: [TokenScope.TranslationsRead, TokenScope.ExportRead, 'not-a-scope'],
    });
    passwords.verify.mockResolvedValue(true);

    const issued = await service.issue(issueCommand);

    expect(issued.token).toMatch(/^tms_/);
    expect(issued.scopes).toEqual([TokenScope.TranslationsRead, TokenScope.ExportRead]);
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + 3600_000);
    const inserted = tokens.insert.mock.calls[0]?.[0];
    expect(inserted?.tokenHash).toBe(hashToken(issued.token));
    expect(JSON.stringify(inserted)).not.toContain(issued.token);
  });

  it('verifies against a dummy hash for unknown emails (no user enumeration)', async () => {
    const { service, users, passwords } = setup();
    users.findCredentialsByEmail.mockResolvedValue(undefined);
    await expect(service.issue(issueCommand)).rejects.toThrow(InvalidCredentialsError);
    expect(passwords.verifyAgainstDummy).toHaveBeenCalledWith('correct horse');
  });

  it('rejects a wrong password', async () => {
    const { service, users, passwords } = setup();
    users.findCredentialsByEmail.mockResolvedValue({ id: '1', passwordHash: 'h', scopes: [] });
    passwords.verify.mockResolvedValue(false);
    await expect(service.issue(issueCommand)).rejects.toThrow(InvalidCredentialsError);
  });

  it('refuses scopes the user cannot grant', async () => {
    const { service, users, passwords } = setup();
    users.findCredentialsByEmail.mockResolvedValue({
      id: '1',
      passwordHash: 'h',
      scopes: [TokenScope.TranslationsRead],
    });
    passwords.verify.mockResolvedValue(true);
    await expect(
      service.issue({ ...issueCommand, scopes: [TokenScope.LocalesWrite] }),
    ).rejects.toThrow(ScopeNotGrantableError);
  });

  it('refuses a TTL above the configured maximum', async () => {
    const { service, users, passwords } = setup();
    users.findCredentialsByEmail.mockResolvedValue({ id: '1', passwordHash: 'h', scopes: [] });
    passwords.verify.mockResolvedValue(true);
    await expect(service.issue({ ...issueCommand, ttlSeconds: 7201 })).rejects.toThrow(
      DomainValidationError,
    );
  });
});

describe('TokenService.authenticate', () => {
  it('rejects malformed tokens without a database lookup', async () => {
    const { service, tokens } = setup();
    await expect(service.authenticate('not-a-token')).rejects.toThrow(InvalidTokenError);
    expect(tokens.findByHash).not.toHaveBeenCalled();
  });

  it('rejects unknown tokens', async () => {
    const { service, tokens } = setup();
    tokens.findByHash.mockResolvedValue(undefined);
    await expect(service.authenticate(generateToken().plaintext)).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it('rejects revoked and expired tokens', async () => {
    const { service, tokens } = setup();
    const { plaintext } = generateToken();
    tokens.findByHash.mockResolvedValueOnce(stored(plaintext, { revokedAt: NOW }));
    await expect(service.authenticate(plaintext)).rejects.toThrow(/revoked/);
    tokens.findByHash.mockResolvedValueOnce(stored(plaintext, { expiresAt: NOW }));
    await expect(service.authenticate(plaintext)).rejects.toThrow(/expired/);
  });

  it('returns a principal with only recognised scopes and records first use', async () => {
    const { service, tokens } = setup();
    const { plaintext } = generateToken();
    tokens.findByHash.mockResolvedValue(stored(plaintext));
    const principal = await service.authenticate(plaintext);
    expect(principal).toEqual({
      tokenId: '5',
      tokenHash: hashToken(plaintext),
      userId: '1',
      scopes: new Set([TokenScope.TranslationsRead]),
    });
    expect(tokens.touchLastUsed).toHaveBeenCalledTimes(1);
  });

  it('throttles last_used_at writes to one per interval', async () => {
    const { service, tokens } = setup();
    const { plaintext } = generateToken();
    tokens.findByHash.mockResolvedValue(
      stored(plaintext, { lastUsedAt: new Date(NOW.getTime() - 30_000) }),
    );
    await service.authenticate(plaintext);
    expect(tokens.touchLastUsed).not.toHaveBeenCalled();

    tokens.findByHash.mockResolvedValue(
      stored(plaintext, { lastUsedAt: new Date(NOW.getTime() - 61_000) }),
    );
    await service.authenticate(plaintext);
    expect(tokens.touchLastUsed).toHaveBeenCalledTimes(1);
  });

  it('revokes by token id at the current time', async () => {
    const { service, tokens } = setup();
    await service.revoke({ tokenId: '5', tokenHash: 'h', userId: '1', scopes: new Set() });
    expect(tokens.revoke).toHaveBeenCalledWith('5', NOW);
  });
});

describe('TokenService verified-token cache', () => {
  it('fromCache returns nothing for malformed or unseen tokens', () => {
    const { service } = setup({ tokenCacheMs: 5_000 });
    expect(service.fromCache('not-a-token')).toBeUndefined();
    expect(service.fromCache(generateToken().plaintext)).toBeUndefined();
  });

  it('serves repeat authentications from memory', async () => {
    const { service, tokens } = setup({ tokenCacheMs: 5_000 });
    const { plaintext } = generateToken();
    tokens.findByHash.mockResolvedValue(stored(plaintext));
    const first = await service.authenticate(plaintext);
    const second = await service.authenticate(plaintext);
    expect(second).toBe(first);
    expect(tokens.findByHash).toHaveBeenCalledTimes(1);
  });

  it('re-checks the database once the cache TTL has passed', async () => {
    let now = NOW.getTime();
    const { service, tokens } = setup({ tokenCacheMs: 1_000 }, () => new Date(now));
    const { plaintext } = generateToken();
    tokens.findByHash.mockResolvedValue(stored(plaintext));
    await service.authenticate(plaintext);
    now += 1_000;
    await service.authenticate(plaintext);
    expect(tokens.findByHash).toHaveBeenCalledTimes(2);
  });

  it('enforces token expiry on cache hits', async () => {
    let now = NOW.getTime();
    const { service, tokens } = setup({ tokenCacheMs: 60_000 }, () => new Date(now));
    const { plaintext } = generateToken();
    tokens.findByHash.mockResolvedValue(stored(plaintext)); // expires NOW + 60 s
    await service.authenticate(plaintext);
    now += 60_000;
    await expect(service.authenticate(plaintext)).rejects.toThrow(/expired/);
  });

  it('evicts a revoked token immediately on this instance', async () => {
    const { service, tokens } = setup({ tokenCacheMs: 5_000 });
    const { plaintext } = generateToken();
    tokens.findByHash.mockResolvedValue(stored(plaintext));
    const principal = await service.authenticate(plaintext);
    await service.revoke(principal);
    tokens.findByHash.mockResolvedValue(stored(plaintext, { revokedAt: NOW }));
    await expect(service.authenticate(plaintext)).rejects.toThrow(/revoked/);
  });
});
