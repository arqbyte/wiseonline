import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * Relies on the global DrizzleModule (imported in AppModule) for
 * DrizzleHealthService — no need to re-import it here.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
