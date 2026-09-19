# syntax=docker/dockerfile:1
# The one immutable spelltype application image, built from this repository
# checkout. A single image carries the app (dist/server/index.js), migration
# entry (dist/server/migrate.js), maintenance entry (dist/server/maintenance.js)
# and built client (dist/client/). Deploys pin an exact image ID, so the code
# that migrates the database is always the code that then serves it.
#
# BUILD_ID is informational only. It is compiled in as the
# __SPELLTYPE_BUILD_ID__ macro and reported by /api/status so an operator can
# prove which build a container runs; it never authorizes or routes anything.
#
# Secrets are never baked: every credential reaches the container at runtime
# through compose file secrets (see compose.yaml / deploy/compose.env.example).
ARG BUN_IMAGE=oven/bun:1.4.2-slim

# --- build: full toolchain (vite, typescript) plus sources -> dist/ ----------
FROM ${BUN_IMAGE} AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --ignore-scripts
COPY drizzle.config.ts index.html tsconfig.json vite.config.ts vite.frontend.ts ./
COPY drizzle ./drizzle
COPY public ./public
COPY scripts/build.mjs ./scripts/build.mjs
COPY shared ./shared
COPY server ./server
COPY src ./src
ARG BUILD_ID
ENV SPELLTYPE_BUILD_ID=${BUILD_ID}
# scripts/build.mjs removes dist/ on failure, so a failed build can never be
# committed as a deployment candidate.
RUN bun run build

# --- dependencies: production node_modules only ------------------------------
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /dependencies
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --production --frozen-lockfile --ignore-scripts

# --- runtime ------------------------------------------------------------------
FROM ${BUN_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY drizzle/ ./drizzle/
COPY --from=dependencies /dependencies/node_modules ./node_modules
USER bun
EXPOSE 3000
CMD ["bun", "dist/server/index.js"]
