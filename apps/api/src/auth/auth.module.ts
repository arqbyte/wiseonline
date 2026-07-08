import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';

import { authPool } from './auth';

/**
 * Lifecycle-only module: `auth.ts`'s `betterAuth()` instance and its pool
 * are built at import time (Better Auth's own convention), outside Nest's
 * DI graph, so nothing normally closes `authPool` on shutdown the way
 * DrizzleModule closes its own pool. Registering it here hooks it into the
 * same `app.enableShutdownHooks()` / `app.close()` lifecycle instead of
 * leaking the connection (visible as Jest's "did not exit" open-handle
 * warning in the auth e2e/integration suites).
 *
 * Importing this module transitively imports auth.ts, whose module-level
 * code throws immediately at `require()`/import time if DATABASE_URL,
 * BETTER_AUTH_SECRET, BETTER_AUTH_URL, or TRUSTED_ORIGINS aren't set —
 * before Nest's DI container even starts. A future unit test written the
 * conventional way (`Test.createTestingModule({ imports: [AppModule] })`)
 * will crash the whole Jest worker at that import rather than fail inside a
 * normal DI-resolution error; set those four env vars (see
 * test/jest-e2e.setup.ts for the pattern) before importing AppModule.
 */
@Module({})
export class AuthModule implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await authPool.end();
  }
}
