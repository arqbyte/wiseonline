import { Global, Module } from '@nestjs/common';
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
 */
@Global()
@Module({})
export class AuthModule implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await authPool.end();
  }
}
