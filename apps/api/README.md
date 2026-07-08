<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Database (Postgres + Drizzle)

Local Postgres runs via docker-compose (repo root) and is accessed through
[Drizzle ORM](https://orm.drizzle.team) using the `pg` (node-postgres) driver.

### Role model (PRD §5 Layer 3 — Postgres RLS defense in depth)

The bootstrap Postgres superuser (`POSTGRES_USER`, from the root `.env`)
creates two application roles on first container init
(`docker/postgres/init/01-roles.sh`):

| Role | Used by | Privileges |
| --- | --- | --- |
| `migrator` | `pnpm --filter api db:generate` / `db:migrate` only | Owns the `public` schema and every table it creates in it. Runs all DDL. |
| `app_user` | The running API (`DrizzleModule`) | `LOGIN NOBYPASSRLS`. Owns **nothing**. Gets `SELECT/INSERT/UPDATE/DELETE` on tables `migrator` creates, via `ALTER DEFAULT PRIVILEGES`. |

The API never connects as `migrator`, and the migration scripts never
connect as `app_user`. This split is required so that Row-Level Security
policies (added in a later card, "Tenant-scoped repositories + Postgres
RLS") can't be bypassed by the application's own connection — `NOBYPASSRLS`
plus no ownership means `FORCE ROW LEVEL SECURITY` policies apply to
`app_user` even though it's the role actually running tenant queries.

### Environment variables

Copy the example env files and fill in local-dev values (defaults already
line up with docker-compose's defaults):

```bash
cp .env.example .env                      # repo root — docker-compose (superuser + role passwords)
cp apps/api/.env.example apps/api/.env     # apps/api — DATABASE_URL / MIGRATION_DATABASE_URL
```

- `DATABASE_URL` — runtime connection string, `app_user` role. Read by
  `@nestjs/config`'s `ConfigModule` at Nest boot; the app **fails fast**
  (throws before listening) if this is missing.
- `MIGRATION_DATABASE_URL` — migration-only connection string, `migrator`
  role. Read by `apps/api/drizzle.config.ts` (drizzle-kit).

### Start Postgres

From the repo root:

```bash
docker compose up -d
docker compose ps          # wait for postgres to report "healthy"
```

This starts `postgres:16-alpine`, persists data in the named volume
`wiseonline_postgres_data`, and runs `docker/postgres/init/01-roles.sh` on
first init to create the `migrator` and `app_user` roles.

### Generate & run migrations

```bash
pnpm --filter api db:generate   # diff src/db/schema.ts -> SQL files in apps/api/migrations
pnpm --filter api db:migrate    # apply pending migrations, connects as `migrator`
```

`src/db/schema.ts` starts empty; Better-Auth-generated tables (card 1.2)
and application tables land there in later cards.

### DB client in the app

`src/db/drizzle.module.ts` is a global NestJS module exporting:

- `DRIZZLE` (injection token) — the pooled Drizzle client (`app_user`).
- `PG_POOL` (injection token) — the underlying `pg.Pool`, for the
  per-request transaction wrapper a later card adds (`SET LOCAL
  app.current_org = $orgId` for RLS).
- `DrizzleHealthService` — injectable; `ping()` runs `SELECT 1` (2s timeout)
  through the `app_user` client and returns `{ ok, latencyMs }`. Consumed by
  the `/health` controller (`GET /health` = readiness w/ DB round-trip →
  200/503; `GET /health/live` = liveness, no DB).
- `DbRoleAssertionService` — at boot (non-test), refuses to start if the
  runtime role is `SUPERUSER`/`BYPASSRLS` (which would defeat RLS).

### Health endpoints

| Route | Purpose | DB? |
| --- | --- | --- |
| `GET /health` | Readiness — 200 when DB reachable, 503 otherwise (no secret/stack leak) | yes |
| `GET /health/live` | Liveness — always 200 while the process is up | no |

## Authentication (Better Auth — card 1.2)

[Better Auth](https://better-auth.com) is mounted directly on the underlying
Express instance (`src/create-app.ts`), not through a Nest controller: Nest's
body-parser is disabled globally (`bodyParser: false`) and Better Auth's raw
node handler (`toNodeHandler`) is registered on `/api/auth/*splat` *before*
`express.json()`/`urlencoded()` are added back for every other route — Better
Auth needs the unconsumed request body, and Express's route-matching order
(not Nest's module graph) is what gives it first refusal on its own subtree.

`src/auth/auth.ts` builds the `betterAuth()` instance as a plain module-level
singleton (Better Auth's own convention, and what `auth generate` statically
imports) — it can't be built inside Nest's DI graph, so it has its own
`pg.Pool` (same hardened factory as `DrizzleModule`, `src/db/pg-pool.factory.ts`,
connecting as `app_user`). `src/auth/auth.module.ts` is DI-only plumbing that
closes that pool on `app.close()`/shutdown.

### Environment variables

Add to `apps/api/.env` (see `.env.example`):

- `BETTER_AUTH_SECRET` — encrypts sessions/tokens. Generate a real one with
  `openssl rand -base64 32`; the fail-fast check in `auth.ts` refuses to boot
  without it (Better Auth itself would otherwise silently fall back to an
  ephemeral dev secret).
- `BETTER_AUTH_URL` — this API's own origin.
- `TRUSTED_ORIGINS` — comma-separated web origins allowed to use auth cookies
  (PRD §2.2). CSRF/origin checks are never disabled (`advanced.disableCSRFCheck`
  / `disableOriginCheck` are explicitly `false`).

### Endpoints (this card)

Email/password only, with `requireEmailVerification: true` — the mailer that
actually sends verification emails is card 1.4, so for now an account stays
unverified (and therefore can't sign in) until its `email_verified` column is
flipped some other way (e.g. directly in the DB, as the integration test does).

| Route | Purpose |
| --- | --- |
| `GET /api/auth/ok` | Built-in Better Auth handshake — confirms the handler is mounted |
| `POST /api/auth/sign-up/email` | Create an account (unverified) |
| `POST /api/auth/sign-in/email` | Sign in — `403 EMAIL_NOT_VERIFIED` until verified |
| `POST /api/auth/sign-out` | Revoke the current session |

### Regenerating the schema

`src/db/schema.ts`'s `user`/`session`/`account`/`verification` tables are
generated, not hand-written:

```bash
pnpm --filter api auth:generate   # re-run after changing auth.ts config/plugins
pnpm --filter api db:generate     # then diff the result into a SQL migration
pnpm --filter api db:migrate      # and apply it
```

### Testing

```bash
pnpm --filter api test              # unit (DB mocked)
pnpm --filter api test:e2e          # e2e (DB-free; placeholder DATABASE_URL)
pnpm --filter api test:integration  # role isolation + /health + auth-core vs a REAL DB
```

`test:integration` needs a live Postgres — bring up docker-compose and export
`DATABASE_URL` (app_user), `MIGRATION_DATABASE_URL` (migrator), and — for the
auth-core suite — `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`.
CI runs it against the same compose stack (`.github/workflows/ci.yml`).

Better Auth ships ESM-only (`.mjs`); Jest's default CJS transform can't load
that, so all three Jest configs (`package.json`'s `jest` block, `test/jest-e2e.json`,
`test/jest-integration.json`) transform every `node_modules` package through
ts-jest (`transformIgnorePatterns: []`) instead of the default ignore-all-of-
node_modules behavior.

### Production hardening (before any non-local deploy)

The docker-compose stack is **local dev only**. Before deploying, in addition
to a managed Postgres with rotated per-role secrets from a secret manager:

- **TLS**: set `DATABASE_SSL=true` and use `sslmode=verify-full` connection
  strings (the pool enforces `rejectUnauthorized`).
- **Pin the Postgres image** by digest (`postgres:16-alpine@sha256:…`).
- **Resource limits** and a **backup-before-migrate** gate (drizzle-kit
  migrations are forward-only; `migrator` can `DROP`).

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
