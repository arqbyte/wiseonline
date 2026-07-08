import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { DRIZZLE, PG_POOL } from './drizzle.constants';
import { createPgPool } from './pg-pool.factory';
import * as schema from './schema';

export type DrizzleDb = NodePgDatabase<typeof schema>;

/**
 * Pooled `pg.Pool` for the API's runtime DB connection.
 *
 * Connects with DATABASE_URL — the `app_user` role (NOBYPASSRLS, owns no
 * tables; see AUTHENTICATION_PRD.md §5 Layer 3). Migrations run separately
 * as the `migrator` role via drizzle-kit + MIGRATION_DATABASE_URL
 * (drizzle.config.ts), never through this pool.
 *
 * `pg` (node-postgres) was chosen over other Postgres drivers because a
 * later card (1.10, tenant-scoped repositories + RLS) needs an explicit
 * per-request transaction that runs `SET LOCAL app.current_org = $orgId`
 * before any tenant query. `pg.Pool` gives direct control of
 * checkout-a-client / BEGIN / SET LOCAL / COMMIT-or-ROLLBACK /
 * release-to-pool, which is exactly the shape that transaction wrapper
 * needs (and the `SET LOCAL`-per-transaction discipline is load-bearing:
 * a session-level SET would leak the org setting across pooled
 * connections).
 */
export const pgPoolProvider: FactoryProvider<Pool> = {
  provide: PG_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Pool =>
    createPgPool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      // TLS: off for the local Docker container (loopback, no CA), enforced
      // in any non-local environment. Set DATABASE_SSL=true (managed
      // Postgres) to require TLS; the connection string may still carry its
      // own sslmode.
      sslEnabled: config.get<string>('DATABASE_SSL') === 'true',
      loggerContext: 'PgPool',
    }),
};

/** Drizzle query client built on top of the app_user pool. */
export const drizzleProvider: FactoryProvider<DrizzleDb> = {
  provide: DRIZZLE,
  inject: [PG_POOL],
  useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
};
