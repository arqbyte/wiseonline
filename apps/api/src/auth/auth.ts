import 'dotenv/config';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

import { requireEnv } from '../config/require-env';
import { createPgPool } from '../db/pg-pool.factory';
import * as schema from '../db/schema';
import { parseTrustedOrigins } from './trusted-origins';

/**
 * Better Auth is a plain module-level singleton (its own convention, and
 * what `@better-auth/cli generate` statically imports) — it can't be built
 * inside Nest's DI graph like the rest of src/db, so it gets its own
 * `pg.Pool` via the same hardened factory instead of the Nest-managed one in
 * drizzle.provider.ts. Both connect as `app_user` (see AUTHENTICATION_PRD.md
 * §5 Layer 3); this is a second pool to the same role, not a privilege
 * escalation.
 *
 * Exported so AuthModule (a lifecycle-only Nest module — see auth.module.ts)
 * can close it on shutdown; nothing outside this file should query through
 * it directly.
 */
export const authPool = createPgPool({
  connectionString: requireEnv('DATABASE_URL'),
  sslEnabled: process.env.DATABASE_SSL === 'true',
  loggerContext: 'BetterAuthPgPool',
});

const authDb = drizzle(authPool, { schema });

// Read (and fail fast on) BETTER_AUTH_SECRET/BETTER_AUTH_URL here rather
// than letting Better Auth silently fall back to an ephemeral dev secret /
// header-derived baseURL — acceptable nowhere we ship, since the PRD v1.2
// deployment gate assumes a fully configured auth stack from card 1.2 on.
// Better Auth still reads these two by their well-known names itself; not
// passed explicitly as `secret`/`baseURL` below.
const authSecret = requireEnv('BETTER_AUTH_SECRET');
if (authSecret.length < 32) {
  throw new Error(
    'BETTER_AUTH_SECRET is shorter than 32 characters — generate a real ' +
      'one with `openssl rand -base64 32`. A weak secret can be brute-forced ' +
      'to forge sessions.',
  );
}
requireEnv('BETTER_AUTH_URL');

/**
 * Comma-separated web origins allowed to use auth cookies cross-request
 * (PRD §2.2). Required and validated — see trusted-origins.ts for why a
 * merely-non-blank check isn't enough.
 */
const trustedOrigins = parseTrustedOrigins(requireEnv('TRUSTED_ORIGINS'));

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
    // must never be turned off (PRD §2.2, card 1.2 AC). This is load-bearing,
    // not just defensive style — Better Auth's own default is to *skip*
    // origin checks whenever NODE_ENV=test (which Jest sets), so leaving
    // these undefined would have silently disabled the very check
    // auth.e2e-spec.ts is asserting is on.
    disableCSRFCheck: false,
    disableOriginCheck: false,
  },
});
