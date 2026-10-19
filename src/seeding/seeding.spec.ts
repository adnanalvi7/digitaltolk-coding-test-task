import type { PasswordHasher } from '../auth/password-hasher';
import type { UserRepository } from '../auth/repositories/user.repository';
import { ALL_TOKEN_SCOPES } from '../auth/token-scope';
import { provisionAdmin } from './admin-provisioner';
import { createPrng, pick } from './prng';
import { keyName } from './seeder';
import { wordsFor } from './vocabulary';

const KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

describe('seeding helpers', () => {
  it('PRNG is deterministic per seed and stays in [0, 1)', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const draws = Array.from({ length: 1000 }, () => a());
    expect(draws).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(draws.every((n) => n >= 0 && n < 1)).toBe(true);
    expect(createPrng(43)()).not.toBe(draws[0]);
  });

  it('pick() selects from the list and rejects an empty list', () => {
    expect(['x', 'y']).toContain(pick(createPrng(1), ['x', 'y']));
    expect(() => pick(createPrng(1), [])).toThrow('non-empty');
  });

  it('generates unique keys that satisfy the API key rule', () => {
    const keys = Array.from({ length: 5000 }, (_, n) => keyName(n));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => KEY_PATTERN.test(key))).toBe(true);
  });

  it('falls back to English vocabulary for unknown locales', () => {
    expect(wordsFor('pt-BR')).toEqual(wordsFor('en'));
    expect(wordsFor('fr')).not.toEqual(wordsFor('en'));
  });
});

describe('provisionAdmin', () => {
  const users: jest.Mocked<UserRepository> = {
    findCredentialsByEmail: jest.fn(),
    upsert: jest.fn().mockResolvedValue('1'),
  };
  const passwords = {
    hash: jest.fn().mockResolvedValue('argon-hash'),
  } as unknown as PasswordHasher;

  it('does nothing without env-provided credentials', async () => {
    expect(
      await provisionAdmin(users, passwords, { email: undefined, password: 'x' }),
    ).toBeUndefined();
    expect(users.upsert).not.toHaveBeenCalled();
  });

  it('upserts the admin with a hashed password and every scope', async () => {
    await provisionAdmin(users, passwords, { email: 'a@b.co', password: 'pw-from-env-123' });
    expect(users.upsert).toHaveBeenCalledWith({
      email: 'a@b.co',
      passwordHash: 'argon-hash',
      scopes: ALL_TOKEN_SCOPES,
    });
  });
});
