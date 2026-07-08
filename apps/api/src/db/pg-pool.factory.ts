import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

export interface CreatePgPoolOptions {
  /** `app_user` connection string (never `migrator` — see AUTHENTICATION_PRD.md §5 Layer 3). */
  connectionString: string;
  /** Mirrors `DATABASE_SSL=true`; off for the local loopback Docker container. */
  sslEnabled: boolean;
  /** Logger context so pool errors are attributable to their caller. */
  loggerContext: string;
}

/**
 * Hardened `pg.Pool` factory shared by every app_user connection in this
 * process: the Nest-DI-managed pool (drizzle.provider.ts) and Better Auth's
 * pool (auth/auth.ts). Better Auth's config is built at module-import time,
 * outside Nest's DI graph, so it can't inject `ConfigService` and needs its
 * own pool constructed the same way — duplicated hardening here would drift.
 */
export function createPgPool({
  connectionString,
  sslEnabled,
  loggerContext,
}: CreatePgPoolOptions): Pool {
  const logger = new Logger(loggerContext);

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
  // client and the pool self-heals (code-reviewer HIGH, card 1.1).
  pool.on('error', (err) => {
    logger.error(
      'Idle pg client error',
      err instanceof Error ? err.stack : err,
    );
  });

  return pool;
}
