import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';

import { DbRoleAssertionService } from './db-role-assertion.service';
import { DrizzleHealthService } from './drizzle-health.service';
import { PG_POOL } from './drizzle.constants';
import { drizzleProvider, pgPoolProvider } from './drizzle.provider';

/**
 * Global DB module: exposes a pooled Drizzle client (app_user role, see
 * drizzle.provider.ts) plus DrizzleHealthService for a `/health` endpoint.
 * Global so any feature module can `@Inject(DRIZZLE)` without re-importing
 * this module everywhere.
 */
@Global()
@Module({
  providers: [
    pgPoolProvider,
    drizzleProvider,
    DrizzleHealthService,
    DbRoleAssertionService,
  ],
  exports: [pgPoolProvider, drizzleProvider, DrizzleHealthService],
})
export class DrizzleModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
