import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Used only by drizzle-kit (`pnpm --filter api db:generate` /
// `db:migrate`), never by the running API. Connects as the `migrator`
// role, which owns the `public` schema and all DDL — see
// AUTHENTICATION_PRD.md §5 Layer 3 and docker/postgres/init/01-roles.sh.
// The running API instead uses DATABASE_URL (the `app_user` role) via
// apps/api/src/db/drizzle.module.ts.
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;

if (!migrationDatabaseUrl) {
  throw new Error(
    'MIGRATION_DATABASE_URL is not set. Copy apps/api/.env.example to ' +
      'apps/api/.env and configure it before running drizzle-kit.',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: migrationDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
