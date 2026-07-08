// Ensures AppModule's fail-fast env validation (DATABASE_URL) doesn't block
// e2e tests that never touch the DB. `pg.Pool` connects lazily — creating
// the DrizzleModule providers does not open a connection — so this
// placeholder never needs to resolve to a real database as long as a test
// doesn't actually run a query.
process.env.DATABASE_URL ??=
  'postgresql://app_user:app_user_dev_only@localhost:5432/wiseonline_test';

// Same rationale for Better Auth's standalone pool (src/auth/auth.ts):
// constructing it doesn't connect, and auth.e2e-spec.ts only exercises
// DB-free request paths (origin/CSRF checks, /api/auth/ok).
process.env.BETTER_AUTH_SECRET ??= 'e2e-test-secret-not-for-real-use-32chars';
process.env.BETTER_AUTH_URL ??= 'http://localhost:4000';
process.env.TRUSTED_ORIGINS ??= 'http://localhost:3000';
