#!/bin/sh
set -e

# Role passwords are interpolated into a single-quoted SQL string literal
# below. Reject an embedded single quote rather than let it break out of the
# literal (broken provisioning at best, injected SQL at worst).
for _pw_var in MIGRATOR_PASSWORD APP_USER_PASSWORD; do
  eval "_pw=\${$_pw_var}"
  case "$_pw" in
    *\'*)
      echo "ERROR: $_pw_var must not contain a single-quote character." >&2
      exit 1
      ;;
  esac
done

# Local-dev role bootstrap for the wiseonline Postgres container.
#
# Creates two roles per PRD (AUTHENTICATION_PRD.md) §5 Layer 3 — Postgres
# Row-Level Security, defense in depth:
#
#   migrator  - owns the `public` schema (and therefore every table it
#               creates in it). Runs all DDL/migrations
#               (`pnpm --filter api db:generate` / `db:migrate`).
#               Never used by the running API.
#
#   app_user  - LOGIN role with NOBYPASSRLS, used by the API at runtime.
#               Owns nothing. Gets SELECT/INSERT/UPDATE/DELETE on tables
#               `migrator` creates via ALTER DEFAULT PRIVILEGES, so RLS
#               policies added later (card 1.10) cannot be bypassed by the
#               application connection the way they could be by an owner
#               or a BYPASSRLS role.
#
# Runs once on first container init via docker-entrypoint-initdb.d, against
# the database named by $POSTGRES_DB, authenticated as $POSTGRES_USER (the
# bootstrap superuser). The DO blocks make re-running this file by hand
# (e.g. `docker compose exec postgres sh /docker-entrypoint-initdb.d/01-roles.sh`)
# idempotent instead of erroring on "role already exists".
#
# Passwords come from MIGRATOR_PASSWORD / APP_USER_PASSWORD (see
# docker-compose.yml + .env.example). Local dev defaults only — never reuse
# these outside a throwaway local machine.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'migrator') THEN
      CREATE ROLE migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD}';
    ELSE
      ALTER ROLE migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD}';
    END IF;
  END
  \$\$;

  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user LOGIN NOBYPASSRLS PASSWORD '${APP_USER_PASSWORD}';
    ELSE
      ALTER ROLE app_user LOGIN NOBYPASSRLS PASSWORD '${APP_USER_PASSWORD}';
    END IF;
  END
  \$\$;

  -- migrator owns the schema, and therefore everything it creates in it.
  ALTER SCHEMA public OWNER TO migrator;

  -- migrator runs all DDL, including creating drizzle-kit's dedicated
  -- `drizzle` schema for its __drizzle_migrations bookkeeping table (the
  -- migrator issues `CREATE SCHEMA IF NOT EXISTS ...`, which Postgres
  -- privilege-checks before the IF-NOT-EXISTS short-circuit). This grant is
  -- scoped to the migration role only; app_user never gets it, so the
  -- runtime connection still cannot create schemas or tables.
  GRANT CREATE ON DATABASE "$POSTGRES_DB" TO migrator;

  -- Explicitly deny CREATE on public to PUBLIC (and therefore app_user).
  -- PG16 already drops this by default, but stating it makes the "app_user
  -- can never create/own a table" guarantee version-independent instead of
  -- reliant on the base image's default (defense in depth for RLS).
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;

  -- app_user may connect and see the schema, but owns nothing in it.
  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO app_user;
  GRANT USAGE ON SCHEMA public TO app_user;

  -- Backstop timeouts on the runtime role: cap any single statement, and
  -- reap a transaction left idle (matters once card 1.10 wraps each request
  -- in BEGIN; SET LOCAL app.current_org; ... so a leaked open transaction
  -- can't pin a pooled connection indefinitely).
  ALTER ROLE app_user SET statement_timeout = '30s';
  ALTER ROLE app_user SET idle_in_transaction_session_timeout = '15s';

  -- Any table/sequence migrator creates from now on is automatically
  -- readable/writable by app_user without app_user ever owning it, so a
  -- later `ALTER TABLE ... FORCE ROW LEVEL SECURITY` (card 1.10) applies
  -- to the app connection and cannot be bypassed by ownership.
  ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
EOSQL
