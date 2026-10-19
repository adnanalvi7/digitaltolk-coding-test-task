import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config/app-config';

export const REDIS = Symbol('REDIS');

export const InjectRedis = (): ParameterDecorator => Inject(REDIS);

const MAX_RETRY_DELAY_MS = 2_000;
const RETRY_STEP_MS = 100;

export function createRedis(config: AppConfig['redis']): Redis {
  return new Redis(config.url, {
    keyPrefix: config.keyPrefix,
    // Connect on first command, so tooling that never touches Redis (e.g. the
    // OpenAPI export) does not need one.
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    retryStrategy: (attempt) => Math.min(attempt * RETRY_STEP_MS, MAX_RETRY_DELAY_MS),
  });
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

@Global()
@Module({})
export class RedisModule {
  static forRoot(config: AppConfig['redis']): DynamicModule {
    return {
      module: RedisModule,
      providers: [{ provide: REDIS, useFactory: (): Redis => createRedis(config) }, RedisLifecycle],
      exports: [REDIS],
    };
  }
}
