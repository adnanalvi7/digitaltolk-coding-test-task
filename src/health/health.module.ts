import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DependencyHealthIndicators, HealthController } from './health.controller';

@Module({
  imports: [TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
  providers: [DependencyHealthIndicators],
})
export class HealthModule {}
