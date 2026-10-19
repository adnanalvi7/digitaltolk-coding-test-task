import { Argon2PasswordHasher } from './password-hasher';

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('hashes with argon2id and verifies', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(hasher.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong')).resolves.toBe(false);
  });

  it('treats a corrupt hash as a failed verification', async () => {
    await expect(hasher.verify('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('performs a dummy verification for timing equalisation', async () => {
    await expect(hasher.verifyAgainstDummy('anything')).resolves.toBeUndefined();
    await expect(hasher.verifyAgainstDummy('again (cached dummy)')).resolves.toBeUndefined();
  });
});
