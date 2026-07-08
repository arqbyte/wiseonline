// Drizzle ORM schema definitions.
//
// This file is intentionally empty for now (card 1.1 — Postgres + Drizzle
// foundation). It is the single source of truth `drizzle-kit generate`
// diffs against to produce SQL migrations in ../../migrations.
//
// What lands here next:
//   - Card 1.2 ("Better Auth core mounted in NestJS") runs
//     `@better-auth/cli generate` to emit the Better-Auth-managed tables
//     (user, session, account, verification, organization, member,
//     invitation, ...) into this file (or files re-exported from here).
//   - Later cards add application tables (assets, audit log, etc.),
//     including the `organization_id` + Row-Level Security policies
//     described in AUTHENTICATION_PRD.md §5 Layer 3 (card 1.10).
//
// Keep all table definitions reachable from this module so both
// drizzle-kit (via drizzle.config.ts `schema` path) and the runtime
// Drizzle client (src/db/drizzle.provider.ts) see the same schema.

export {};
