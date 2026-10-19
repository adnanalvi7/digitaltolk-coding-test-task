import { Controller, Get, Injectable } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import { Public } from '../auth/auth.decorators';
import { InjectDb } from '../database/database.tokens';
import type { Database } from '../database/kysely.factory';
import { InjectRedis } from '../redis/redis.module';
import { RateLimitPolicy } from '../throttling/rate-limit-policy';

@Injectable()
export class DependencyHealthIndicators {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @InjectDb() private readonly db: Database,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async database(): Promise<HealthIndicatorResult> {
    const check = this.indicators.check('database');
    try {
      await sql`SELECT 1`.execute(this.db);
      return check.up();
    } catch {
      return check.down({ message: 'unreachable' });
    }
  }

  async redisStore(): Promise<HealthIndicatorResult> {
    const check = this.indicators.check('redis');
    try {
      await this.redis.ping();
      return check.up();
    } catch {
      return check.down({ message: 'unreachable' });
    }
  }
}

@ApiTags('health')
@Public()
@RateLimitPolicy('none')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dependencies: DependencyHealthIndicators,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness: Postgres and Redis reachable (503 otherwise)' })
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.dependencies.database(),
      () => this.dependencies.redisStore(),
    ]);
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is up and serving requests' })
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
