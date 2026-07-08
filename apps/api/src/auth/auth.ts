import 'dotenv/config';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

import { createPgPool } from '../db/pg-pool.factory';
import * as schema from '../db/schema';

/**
 * Fail-fast env read for this module. Better Auth itself only *warns* and
 * falls back (ephemeral dev secret / baseURL derived from request headers)
 * when these are missing — acceptable nowhere we ship, since the PRD v1.2
 * deployment gate assumes a fully configured auth stack from card 1.2 on.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is not set. Copy apps/api/.env.example to apps/api/.env ` +
        'and configure it.',
    );
  }
  return value;
}

/**
 * Better Auth is a plain module-level singleton (its own convention, and
 * what `@better-auth/cli generate` statically imports) — it can't be built
 * inside Nest's DI graph like the rest of src/db, so it gets its own
 * `pg.Pool` via the same hardened factory instead of the Nest-managed one in
 * drizzle.provider.ts. Both connect as `app_user` (see AUTHENTICATION_PRD.md
 * §5 Layer 3); this is a second pool to the same role, not a privilege
 * escalation.
 */
// Exported so AuthModule (a lifecycle-only Nest module — see auth.module.ts)
// can close it on shutdown; nothing outside this file should query through
// it directly.
export const authPool = createPgPool({
  connectionString: requireEnv('DATABASE_URL'),
  sslEnabled: process.env.DATABASE_SSL === 'true',
  loggerContext: 'BetterAuthPgPool',
});

const authDb = drizzle(authPool, { schema });

// Read (and fail fast on) BETTER_AUTH_SECRET/BETTER_AUTH_URL here rather
// than letting Better Auth silently fall back — see requireEnv's doc above.
// Better Auth still reads these two by their well-known names itself; not
// passed explicitly as `secret`/`baseURL` below.
requireEnv('BETTER_AUTH_SECRET');
requireEnv('BETTER_AUTH_URL');

/**
 * Comma-separated web origins allowed to use auth cookies cross-request
 * (PRD §2.2). Required — an empty/missing value would trust nothing but
 * BETTER_AUTH_URL itself, silently breaking the web app rather than failing
 * at boot.
 */
const trustedOrigins = requireEnv('TRUSTED_ORIGINS')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const auth = betterAuth({
  database: drizzleAdapter(authDb, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    // Mitigates early timing/spoofing vectors (AUTHENTICATION_SPEC_1.md §2);
    // password hashing is scrypt, Better Auth's default — not overridden.
    requireEmailVerification: true,
  },
  trustedOrigins,
  advanced: {
    // Explicit, not just relying on the library default: CSRF/origin checks
    // must never be turned off (PRD §2.2, card 1.2 AC).
    disableCSRFCheck: false,
    disableOriginCheck: false,
  },
});
