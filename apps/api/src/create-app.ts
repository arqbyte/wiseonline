import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import { json, urlencoded } from 'express';

import { AppModule } from './app.module';
import { auth } from './auth/auth';

/**
 * Builds the Nest app with Better Auth mounted, shared by main.ts and the
 * auth e2e/integration suites so tests exercise the exact HTTP wiring
 * production runs — a plain `Test.createTestingModule(...).createNestApplication()`
 * skips this file entirely and would never hit /api/auth/*.
 */
export async function createApp(): Promise<NestExpressApplication> {
  // Nest's automatic body-parser is disabled globally so it never touches
  // /api/auth/* — Better Auth's handler needs the raw, unconsumed request
  // stream. `json`/`urlencoded` below restore parsing for every other route.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Mounted directly on the underlying Express instance, before the global
  // body parsers below, so Express's route-matching order — not Nest's
  // module graph — gives Better Auth first refusal on its own subtree. This
  // ordering is safe against anything Nest itself registers later:
  // `NestFactory.create()` doesn't run `registerRouter`/`registerModules`
  // until `app.init()`/`app.listen()`, both of which happen after this
  // function returns, so every Nest controller/middleware is always
  // registered on Express *after* the two calls below.
  //
  // Express 5 requires the named-wildcard form (`*splat`, not bare `*`).
  //
  // Caution for future middleware meant to also cover /api/auth/* (e.g. the
  // rate limiting in kanban card 1.14, if implemented as Express/Nest
  // middleware rather than Better Auth's own `rateLimit` config): anything
  // registered with `app.use(...)`/`configure()` after this `.all()` call
  // will NOT run for requests matching /api/auth/*, since Express dispatches
  // the first matching handler and never falls through to later middleware.
  app
    .getHttpAdapter()
    .getInstance()
    .all('/api/auth/*splat', toNodeHandler(auth));

  app.use(json());
  app.use(urlencoded({ extended: true }));

  return app;
}
