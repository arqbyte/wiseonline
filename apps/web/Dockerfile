# syntax=docker/dockerfile:1.7

# =============================================================================
# apps/web/Dockerfile — Next.js app
#
# Build context MUST be the repo root (pnpm workspace: needs the root
# pnpm-lock.yaml + pnpm-workspace.yaml to resolve deps):
#
#   docker build -f apps/web/Dockerfile -t wiseonline-web .
#
# Relies on `output: "standalone"` (apps/web/next.config.ts) which makes
# `next build` trace only the node_modules actually required at runtime
# (via @vercel/nft) into `.next/standalone`, instead of shipping the full
# workspace node_modules. Because this is a monorepo, that traced output is
# rooted at the workspace root (outputFileTracingRoot), producing:
#   .next/standalone/apps/web/server.js
#   .next/standalone/apps/web/node_modules   (symlinks, workspace-local deps)
#   .next/standalone/node_modules            (hoisted/shared deps)
# `.next/static` and `public/` are intentionally NOT included in standalone
# output (Next.js docs) and are copied in separately below.
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
RUN pnpm config set store-dir /pnpm-store
WORKDIR /usr/src/app

# -----------------------------------------------------------------------------
# manifests
# -----------------------------------------------------------------------------
FROM base AS manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

# -----------------------------------------------------------------------------
# deps — full install, scoped to web + its workspace deps via
# `--filter web...`. apps/api's dependencies are never resolved here.
# -----------------------------------------------------------------------------
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter web...

# -----------------------------------------------------------------------------
# build
# -----------------------------------------------------------------------------
FROM deps AS build
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

# -----------------------------------------------------------------------------
# runtime — only the traced standalone server + static assets + public/.
# No separate prod-deps stage needed here: `output: standalone` already did
# the dependency pruning via file tracing.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /usr/src/app

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=build --chown=nextjs:nodejs /usr/src/app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /usr/src/app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /usr/src/app/apps/web/public ./apps/web/public

USER nextjs
WORKDIR /usr/src/app/apps/web

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Next.js has no built-in health endpoint convention; `/` is a reasonable
# default (server up + can render/serve a route). Uses Node's built-in fetch
# (no curl/wget in this alpine image) to avoid installing extra packages.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
