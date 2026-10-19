import { z } from 'zod';
import {
  BYTES_PER_MEBIBYTE as ONE_MEBIBYTE,
  MS_PER_SECOND,
  SECONDS_PER_DAY,
  SECONDS_PER_MINUTE,
} from '../common/units';

const MAX_TCP_PORT = 65_535;
const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** Every tunable default in one reviewable place. */
const DEFAULTS = {
  port: 3000,
  bodyLimitBytes: ONE_MEBIBYTE,
  dbPoolMax: 20,
  dbStatementTimeoutMs: 5_000, // 5 s
  dbIdleInTxTimeoutMs: 10_000, // 10 s
  tokenDefaultTtlSeconds: SECONDS_PER_DAY,
  tokenMaxTtlSeconds: 2_592_000, // 30 days
  lastUsedWriteIntervalSeconds: SECONDS_PER_MINUTE,
  tokenCacheMs: 5_000,
  workers: 1,
  maxWorkers: 64,
  throttleWindowMs: SECONDS_PER_MINUTE * MS_PER_SECOND,
  throttleAuthLimit: 5,
  throttleApiLimit: 120,
  throttleExportLimit: 600,
  throttleAuthFailureLimit: 30,
  // A cached export is only useful until the next write supersedes its
  // version; a short TTL stops dead versions from accumulating in Redis.
  exportCacheTtlSeconds: 300, // 5 minutes
  catalogReconcileIntervalMs: 5_000,
  exportSMaxAgeSeconds: SECONDS_PER_MINUTE,
  exportStaleWhileRevalidateSeconds: 30,
  exportBuildLockMs: 10_000, // 10 s
  exportLockWaitMs: 400,
  exportSideEffectDebounceMs: 250,
  exportMemoryCacheMb: 64,
} as const;

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const positiveInt = z.coerce.number().int().positive();

/**
 * Raw environment contract. Every variable the service reads is declared here,
 * validated once at startup, and then exposed only as the structured
 * {@link AppConfig}. Nothing else in the codebase touches `process.env`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(MAX_TCP_PORT).default(DEFAULTS.port),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanFromEnv.default('false'),
  CORS_ORIGINS: commaList.default(''),
  BODY_LIMIT_BYTES: positiveInt.default(DEFAULTS.bodyLimitBytes),
  // Unset = enabled outside production (Swagger UI is not exposed by default in prod).
  SWAGGER_ENABLED: booleanFromEnv.optional(),
  APP_WORKERS: z.coerce.number().int().min(1).max(DEFAULTS.maxWorkers).default(DEFAULTS.workers),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: positiveInt.default(DEFAULTS.dbPoolMax),
  DB_STATEMENT_TIMEOUT_MS: positiveInt.default(DEFAULTS.dbStatementTimeoutMs),
  DB_IDLE_IN_TX_TIMEOUT_MS: positiveInt.default(DEFAULTS.dbIdleInTxTimeoutMs),

  REDIS_URL: z.string().url(),
  REDIS_KEY_PREFIX: z.string().default('tms:'),

  AUTH_TOKEN_DEFAULT_TTL_SECONDS: positiveInt.default(DEFAULTS.tokenDefaultTtlSeconds),
  AUTH_TOKEN_MAX_TTL_SECONDS: positiveInt.default(DEFAULTS.tokenMaxTtlSeconds),
  AUTH_LAST_USED_WRITE_INTERVAL_SECONDS: positiveInt.default(DEFAULTS.lastUsedWriteIntervalSeconds),
  AUTH_TOKEN_CACHE_MS: z.coerce.number().int().min(0).default(DEFAULTS.tokenCacheMs),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(MIN_ADMIN_PASSWORD_LENGTH).optional(),

  THROTTLE_WINDOW_MS: positiveInt.default(DEFAULTS.throttleWindowMs),
  THROTTLE_AUTH_LIMIT: positiveInt.default(DEFAULTS.throttleAuthLimit),
  THROTTLE_API_LIMIT: positiveInt.default(DEFAULTS.throttleApiLimit),
  THROTTLE_EXPORT_LIMIT: positiveInt.default(DEFAULTS.throttleExportLimit),
  THROTTLE_AUTH_FAILURE_LIMIT: positiveInt.default(DEFAULTS.throttleAuthFailureLimit),

  EXPORT_PUBLIC: booleanFromEnv.default('false'),
  EXPORT_CACHE_TTL_SECONDS: positiveInt.default(DEFAULTS.exportCacheTtlSeconds),
  CATALOG_RECONCILE_INTERVAL_MS: positiveInt.default(DEFAULTS.catalogReconcileIntervalMs),
  EXPORT_S_MAXAGE_SECONDS: positiveInt.default(DEFAULTS.exportSMaxAgeSeconds),
  EXPORT_STALE_WHILE_REVALIDATE_SECONDS: positiveInt.default(
    DEFAULTS.exportStaleWhileRevalidateSeconds,
  ),
  EXPORT_WARM_ON_CHANGE: booleanFromEnv.default('false'),
  EXPORT_BUILD_LOCK_MS: positiveInt.default(DEFAULTS.exportBuildLockMs),
  EXPORT_LOCK_WAIT_MS: positiveInt.default(DEFAULTS.exportLockWaitMs),
  EXPORT_SIDE_EFFECT_DEBOUNCE_MS: positiveInt.default(DEFAULTS.exportSideEffectDebounceMs),
  EXPORT_MEMORY_CACHE_MB: positiveInt.default(DEFAULTS.exportMemoryCacheMb),

  CDN_PURGE_URL: z.string().url().optional(),
  CDN_PURGE_TOKEN: z.string().min(1).optional(),
  CDN_PUBLIC_BASE_URL: z.string().url().optional(),
});

export type RawEnv = z.input<typeof envSchema>;

export interface AppConfig {
  readonly app: {
    readonly env: 'development' | 'test' | 'production';
    readonly host: string;
    readonly port: number;
    readonly logLevel: string;
    readonly trustProxy: boolean;
    readonly corsOrigins: readonly string[];
    readonly bodyLimitBytes: number;
    readonly swaggerEnabled: boolean;
    /** Node cluster workers per container/host (the app is stateless). */
    readonly workers: number;
  };
  readonly db: {
    readonly url: string;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
    readonly idleInTransactionTimeoutMs: number;
  };
  readonly redis: {
    readonly url: string;
    readonly keyPrefix: string;
  };
  readonly auth: {
    readonly defaultTokenTtlSeconds: number;
    readonly maxTokenTtlSeconds: number;
    readonly lastUsedWriteIntervalSeconds: number;
    /** Per-instance cache of verified tokens; 0 disables it (immediate global revocation). */
    readonly tokenCacheMs: number;
    readonly adminEmail: string | undefined;
    readonly adminPassword: string | undefined;
  };
  readonly throttle: {
    readonly windowMs: number;
    readonly authLimit: number;
    readonly apiLimit: number;
    readonly exportLimit: number;
    /** Failed authentications (bad token or password) allowed per IP per window. */
    readonly authFailureLimit: number;
  };
  readonly export: {
    readonly public: boolean;
    readonly cacheTtlSeconds: number;
    readonly sMaxAgeSeconds: number;
    readonly staleWhileRevalidateSeconds: number;
    readonly warmOnChange: boolean;
    readonly buildLockMs: number;
    /** Max time a request waits for another instance's build before building itself. */
    readonly lockWaitMs: number;
    /** Bursts of writes collapse into one CDN purge / warm-up within this window. */
    readonly sideEffectDebounceMs: number;
    readonly memoryCacheBytes: number;
  };
  readonly catalog: {
    /** How often the Postgres catalog version is republished to Redis. */
    readonly reconcileIntervalMs: number;
  };
  readonly cdn: {
    readonly purgeUrl: string | undefined;
    readonly purgeToken: string | undefined;
    readonly publicBaseUrl: string | undefined;
  };
}

export class InvalidConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'InvalidConfigError';
  }
}

/** Parses and validates the environment, failing fast with every problem listed. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  // An empty variable (e.g. `CDN_PURGE_URL=` from Compose) means "unset".
  const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(defined);
  if (!parsed.success) {
    throw new InvalidConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  if (e.AUTH_TOKEN_DEFAULT_TTL_SECONDS > e.AUTH_TOKEN_MAX_TTL_SECONDS) {
    throw new InvalidConfigError([
      'AUTH_TOKEN_DEFAULT_TTL_SECONDS must not exceed AUTH_TOKEN_MAX_TTL_SECONDS',
    ]);
  }
  return {
    app: {
      env: e.NODE_ENV,
      host: e.HOST,
      port: e.PORT,
      logLevel: e.LOG_LEVEL,
      trustProxy: e.TRUST_PROXY,
      corsOrigins: e.CORS_ORIGINS,
      bodyLimitBytes: e.BODY_LIMIT_BYTES,
      swaggerEnabled: e.SWAGGER_ENABLED ?? e.NODE_ENV !== 'production',
      workers: e.APP_WORKERS,
    },
    db: {
      url: e.DATABASE_URL,
      poolMax: e.DB_POOL_MAX,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: e.DB_IDLE_IN_TX_TIMEOUT_MS,
    },
    redis: { url: e.REDIS_URL, keyPrefix: e.REDIS_KEY_PREFIX },
    auth: {
      defaultTokenTtlSeconds: e.AUTH_TOKEN_DEFAULT_TTL_SECONDS,
      maxTokenTtlSeconds: e.AUTH_TOKEN_MAX_TTL_SECONDS,
      lastUsedWriteIntervalSeconds: e.AUTH_LAST_USED_WRITE_INTERVAL_SECONDS,
      tokenCacheMs: e.AUTH_TOKEN_CACHE_MS,
      adminEmail: e.ADMIN_EMAIL,
      adminPassword: e.ADMIN_PASSWORD,
    },
    throttle: {
      windowMs: e.THROTTLE_WINDOW_MS,
      authLimit: e.THROTTLE_AUTH_LIMIT,
      apiLimit: e.THROTTLE_API_LIMIT,
      exportLimit: e.THROTTLE_EXPORT_LIMIT,
      authFailureLimit: e.THROTTLE_AUTH_FAILURE_LIMIT,
    },
    export: {
      public: e.EXPORT_PUBLIC,
      cacheTtlSeconds: e.EXPORT_CACHE_TTL_SECONDS,
      sMaxAgeSeconds: e.EXPORT_S_MAXAGE_SECONDS,
      staleWhileRevalidateSeconds: e.EXPORT_STALE_WHILE_REVALIDATE_SECONDS,
      warmOnChange: e.EXPORT_WARM_ON_CHANGE,
      buildLockMs: e.EXPORT_BUILD_LOCK_MS,
      lockWaitMs: e.EXPORT_LOCK_WAIT_MS,
      sideEffectDebounceMs: e.EXPORT_SIDE_EFFECT_DEBOUNCE_MS,
      memoryCacheBytes: e.EXPORT_MEMORY_CACHE_MB * ONE_MEBIBYTE,
    },
    catalog: { reconcileIntervalMs: e.CATALOG_RECONCILE_INTERVAL_MS },
    cdn: {
      purgeUrl: e.CDN_PURGE_URL,
      purgeToken: e.CDN_PURGE_TOKEN,
      publicBaseUrl: e.CDN_PUBLIC_BASE_URL,
    },
  };
}
