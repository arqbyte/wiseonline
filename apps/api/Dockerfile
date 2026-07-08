# syntax=docker/dockerfile:1.7

# =============================================================================
# apps/api/Dockerfile — NestJS API
#
# Build context MUST be the repo root (this is a pnpm workspace; the single
# root pnpm-lock.yaml + pnpm-workspace.yaml are required to resolve deps):
#
#   docker build -f apps/api/Dockerfile -t wiseonline-api .
#
# Stages:
#   base       - Node + pnpm (via Corepack), nothing workspace-specific yet
#   manifests  - only the package.json/lockfile files needed to resolve the
#                workspace graph -> lets `pnpm install` stay cached across
#                source-only changes
#   deps       - full (dev+prod) install, scoped to the api project and its
#                workspace dependencies only via `--filter api...`
#   build      - compiles `nest build` -> apps/api/dist
#   prod-deps  - production-only install, same scoping as `deps`
#   runtime    - alpine, non-root, only prod node_modules + compiled dist end
#                up in the final image (no src/test/migrations/etc.)
#
# Known size caveat (not fixable purely in this Dockerfile — see below):
# better-auth declares an *optional* peer dependency on `next` (for an
# integration this app doesn't use). Because this workspace's apps/web is a
# real Next.js app sharing the one root lockfile, pnpm's peer resolution
# picks up apps/web's next@16 to satisfy that optional peer for better-auth's
# resolved variant, so `node_modules/.pnpm` ends up with a next.js + SWC
# native-binary copy (~300MB) even though nothing in apps/api ever
# `require('next')`s it — confirmed absent from apps/api/node_modules' own
# symlinks, so it's dead weight, not a functional dependency. Both
# `--filter api...` installs and `pnpm deploy --prod` materialize it (it's
# baked into the shared pnpm-lock.yaml's resolved graph, not a copy-strategy
# issue), so this can only be fixed upstream (e.g. re-evaluating whether
# better-auth's optional next peer needs to resolve at all in this
# workspace) — flagged for the team rather than worked around here.
# =============================================================================

ARG NODE_VERSION=22-alpine
# Keep in sync with the root package.json "packageManager" field.
ARG PNPM_VERSION=11.10.0

# -----------------------------------------------------------------------------
# base
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
# Pin the content-addressable store to a known path so the BuildKit cache
# mount below (id=pnpm-store) actually lands on it in every stage.
RUN pnpm config set store-dir /pnpm-store
WORKDIR /usr/src/app

# -----------------------------------------------------------------------------
# manifests — smallest possible set of files pnpm needs to resolve the
# workspace graph, so editing src/** doesn't bust the install cache.
# -----------------------------------------------------------------------------
FROM base AS manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

# -----------------------------------------------------------------------------
# deps — full install (needed to run `nest build`), scoped to api + its
# workspace dependencies via `--filter api...`. apps/web's own dependencies
# are never resolved/downloaded for this image.
# -----------------------------------------------------------------------------
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter api...

# -----------------------------------------------------------------------------
# build
# -----------------------------------------------------------------------------
FROM deps AS build
COPY apps/api ./apps/api
RUN pnpm --filter api build

# -----------------------------------------------------------------------------
# prod-deps — production-only install, same scoping as `deps`.
# -----------------------------------------------------------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --filter api...

# -----------------------------------------------------------------------------
# runtime
#
# pnpm workspaces link deps via a per-package node_modules of symlinks that
# point back into the workspace-root node_modules/.pnpm content-addressable
# store, so both directories are copied and the relative apps/api/ layout is
# preserved (rather than flattened) to keep those symlinks resolvable.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /usr/src/app

RUN addgroup -S nodejs && adduser -S nestjs -G nodejs

COPY --from=prod-deps --chown=nestjs:nodejs /usr/src/app/node_modules ./node_modules
COPY --from=prod-deps --chown=nestjs:nodejs /usr/src/app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=nestjs:nodejs /usr/src/app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=nestjs:nodejs /usr/src/app/apps/api/dist ./apps/api/dist

USER nestjs
WORKDIR /usr/src/app/apps/api

ENV PORT=4000
EXPOSE 4000

# `/health` is a readiness check (round-trips the DB via Drizzle); good
# enough for a container-level HEALTHCHECK too. Uses Node's built-in fetch
# (no curl/wget in this alpine image) to avoid installing extra packages.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
