import { Logger } from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { DRIZZLE, PG_POOL } from './drizzle.constants';
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
  useFactory: (config: ConfigService): Pool => {
    const logger = new Logger('PgPool');
    const connectionString = config.getOrThrow<string>('DATABASE_URL');

    // TLS: off for the local Docker container (loopback, no CA), enforced in
    // any non-local environment. Set DATABASE_SSL=true (managed Postgres) to
    // require TLS; the connection string may still carry its own sslmode.
    const sslEnabled = config.get<string>('DATABASE_SSL') === 'true';

    const pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      // Bound how long a checkout waits for a connection so a wedged DB
      // surfaces as a fast failure (e.g. a 503 from /health) instead of a
      // hung request (security-engineer H1).
      connectionTimeoutMillis: 3_000,
      // Server-side cap on any single statement — defence in depth on top of
      // the role-level statement_timeout set in the DB init script.
      statement_timeout: 30_000,
      ...(sslEnabled ? { ssl: { rejectUnauthorized: true } } : {}),
    });

    // node-postgres emits 'error' on an *idle* pooled client when the backend
    // dies (Postgres restart, failover, idle-socket kill). With no listener
    // Node raises an uncaught exception and the process exits — so the whole
    // API would crash on a routine DB blip. Log it instead; pg evicts the bad
    // client and the pool self-heals (code-reviewer HIGH).
    pool.on('error', (err) => {
      logger.error(
        'Idle pg client error',
        err instanceof Error ? err.stack : err,
      );
    });

    return pool;
  },
};

/** Drizzle query client built on top of the app_user pool. */
export const drizzleProvider: FactoryProvider<DrizzleDb> = {
  provide: DRIZZLE,
  inject: [PG_POOL],
  useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
};
