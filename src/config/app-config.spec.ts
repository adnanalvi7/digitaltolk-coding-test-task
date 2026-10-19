import { InvalidConfigError, loadConfig } from './app-config';

const minimal = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(minimal);
    expect(config.app).toMatchObject({ env: 'development', port: 3000, bodyLimitBytes: 1_048_576 });
    expect(config.throttle).toEqual({
      windowMs: 60_000,
      authLimit: 5,
      apiLimit: 120,
      exportLimit: 600,
      authFailureLimit: 30,
    });
    expect(config.export.public).toBe(false);
    expect(config.cdn.purgeUrl).toBeUndefined();
  });

  it('parses booleans, numbers and lists', () => {
    const config = loadConfig({
      ...minimal,
      PORT: '8080',
      EXPORT_PUBLIC: 'true',
      TRUST_PROXY: '1',
      CORS_ORIGINS: 'https://a.example, https://b.example,,',
    });
    expect(config.app.port).toBe(8080);
    expect(config.export.public).toBe(true);
    expect(config.app.trustProxy).toBe(true);
    expect(config.app.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('treats empty variables as unset (Compose passes VAR= for unset optionals)', () => {
    const config = loadConfig({ ...minimal, CDN_PURGE_URL: '', ADMIN_EMAIL: '', PORT: '' });
    expect(config.cdn.purgeUrl).toBeUndefined();
    expect(config.auth.adminEmail).toBeUndefined();
    expect(config.app.port).toBe(3000);
  });

  it('fails fast listing every invalid variable', () => {
    expect(() => loadConfig({ PORT: 'abc', EXPORT_PUBLIC: 'yes' })).toThrow(InvalidConfigError);
    try {
      loadConfig({ PORT: 'abc' });
    } catch (error) {
      const issues = (error as InvalidConfigError).issues.join('\n');
      expect(issues).toMatch(/DATABASE_URL/);
      expect(issues).toMatch(/REDIS_URL/);
      expect(issues).toMatch(/PORT/);
    }
  });

  it('rejects a default token TTL above the maximum', () => {
    expect(() =>
      loadConfig({
        ...minimal,
        AUTH_TOKEN_DEFAULT_TTL_SECONDS: '100',
        AUTH_TOKEN_MAX_TTL_SECONDS: '50',
      }),
    ).toThrow(/must not exceed/);
  });

  it('rejects a short admin password', () => {
    expect(() => loadConfig({ ...minimal, ADMIN_PASSWORD: 'short' })).toThrow(InvalidConfigError);
  });
});
