/**
 * Fail-fast env validation for @nestjs/config's ConfigModule.forRoot
 * `validate` hook. Runs synchronously at boot; throwing here stops the
 * Nest application from starting instead of failing later on the first DB
 * call with a confusing error.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const databaseUrl = config.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. Copy apps/api/.env.example to ' +
        'apps/api/.env and configure it (the app_user connection string; ' +
        'see AUTHENTICATION_PRD.md §5 Layer 3).',
    );
  }

  return config;
}
