/**
 * Fail-fast "must be a non-blank string" read of `process.env`. Shared by
 * anything that has to validate env vars outside Nest's `ConfigModule` (e.g.
 * auth.ts, built as a module-level singleton before Nest's DI graph exists)
 * — module-level side effects here run at `require()` time, so a Nest
 * TestingModule that imports AppModule (and therefore AuthModule/auth.ts)
 * without these vars set will fail at import, not at DI resolution.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is not set. Copy apps/api/.env.example to apps/api/.env ` +
        'and configure it.',
    );
  }
  return value;
}
