import { type AppConfig, loadConfig } from '../../src/config/app-config';

/** Overridable so CI can point at its service containers. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/translations_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

/**
 * Real application config for e2e runs. Rate limits are raised by default so
 * functional suites are not throttled; the throttling suite lowers them.
 */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_KEY_PREFIX: 'tms-test:',
    DB_POOL_MAX: '5',
    THROTTLE_AUTH_LIMIT: '1000',
    THROTTLE_API_LIMIT: '100000',
    THROTTLE_EXPORT_LIMIT: '100000',
    THROTTLE_AUTH_FAILURE_LIMIT: '100000',
    ...overrides,
  });
}
