# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
# Cezar GUI — multi-stage build for the Next.js cockpit (`@cezar/gui`).
# Targets a long-running Node container (Dokploy / generic Docker host).
# Set CEZAR_INPROCESS_CRON=true at runtime so the in-process scheduler fires
# the /api/cron/* routes — see MIGRATION.md for the full env-var matrix.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20-bookworm-slim

# ── deps: install workspace dependencies once, cached on lockfile change ─────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/gui/package.json packages/gui/package.json
COPY packages/runner/package.json packages/runner/package.json

RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    yarn install --immutable

# ── builder: compile @cezar/core then `next build` the GUI ───────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

RUN corepack enable

# Yarn 4 with `nodeLinker: node-modules` hoists deps to the root and only
# creates per-workspace `node_modules/` when hoisting conflicts force it.
# Copying the deps stage wholesale picks up the root + any per-package dirs
# without guessing which exist; the .dockerignore strips node_modules from
# the local context so the second COPY can't clobber them.
COPY --from=deps /app ./
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# @cezar/core must be built before `next build`, since the GUI imports its
# compiled `dist/` (it's listed in `serverExternalPackages`).
RUN yarn workspace @cezar/core build \
 && yarn workspace @cezar/gui build

# ── runner: minimal image with the standalone server ────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs nextjs

# `output: 'standalone'` produces a self-contained tree under
# `packages/gui/.next/standalone/` that mirrors the monorepo layout and
# bundles a minimal `node_modules` traced from the GUI's actual imports.
COPY --from=builder --chown=nextjs:nodejs /app/packages/gui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/gui/.next/static ./packages/gui/.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "packages/gui/server.js"]
