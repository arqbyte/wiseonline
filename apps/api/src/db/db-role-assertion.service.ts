import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';

import { PG_POOL } from './drizzle.constants';

interface RoleRow {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  owned_tables: number;
}

/**
 * Fail-fast assertion that the runtime DB connection is the least-privilege
 * `app_user` role the RLS model depends on (AUTHENTICATION_PRD.md §5 Layer 3).
 *
 * This card exists to establish that the API can never bypass the Row-Level
 * Security added in card 1.10 — but nothing else stops an operator from
 * pointing DATABASE_URL at the `migrator` or a superuser role to "fix a
 * permissions error", which would silently defeat every tenant-isolation
 * policy with a green /health. This runs one query at boot and refuses to
 * start if the connection can bypass RLS.
 *
 *   - SUPERUSER or BYPASSRLS  → fatal: RLS is bypassed regardless of FORCE.
 *   - owns tables in `public` → warn: FORCE ROW LEVEL SECURITY still applies
 *     to owners, but the runtime role is not supposed to own anything.
 *
 * Skipped when NODE_ENV=test (unit/e2e suites boot AppModule without a real
 * DB); the DB-integration suite exercises the real role directly.
 */
@Injectable()
export class DbRoleAssertionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DbRoleAssertionService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      this.logger.debug('Skipping DB role assertion in test environment');
      return;
    }

    const { rows } = await this.pool.query<RoleRow>(`
      SELECT
        current_user,
        r.rolsuper,
        r.rolbypassrls,
        (SELECT count(*)::int FROM pg_tables
           WHERE schemaname = 'public' AND tableowner = current_user) AS owned_tables
      FROM pg_roles r
      WHERE r.rolname = current_user
    `);

    const role = rows[0];
    if (!role) {
      throw new Error(
        `Could not resolve the current DB role for the runtime connection`,
      );
    }

    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Runtime DB role "${role.current_user}" is ${
          role.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'
        } — it can bypass Row-Level Security, defeating tenant isolation ` +
          `(PRD §5 L3). Point DATABASE_URL at the app_user role (LOGIN ` +
          `NOBYPASSRLS, owns nothing).`,
      );
    }

    if (role.owned_tables > 0) {
      this.logger.warn(
        `Runtime DB role "${role.current_user}" owns ${role.owned_tables} ` +
          `table(s) in schema public. The runtime role is expected to own ` +
          `nothing; ensure migrations run as the migrator role.`,
      );
    }

    this.logger.log(
      `DB role assertion passed: connected as "${role.current_user}" ` +
        `(NOBYPASSRLS, owns ${role.owned_tables} tables)`,
    );
  }
}
