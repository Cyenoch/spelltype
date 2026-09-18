# Runtime image for one immutable spelltype release. The build context is a
# protected snapshot produced by `bun scripts/release.mjs stage`, never the
# repository checkout:
#
#   app/           dist output (release.json, server/index.js, client/)
#   drizzle/       SQL migrations, applied automatically at boot by the DB module
#   package.json   lockfiles only — production dependencies are installed
#   bun.lock       inside the pinned Bun image so the container always runs
#                  binaries/WASM built for its own platform
#
# Secrets are never baked: every credential reaches the container at runtime
# through compose file secrets (see compose.yaml / compose.release.yaml).
# The release identity is pinned by app/release.json AND the compiled
# __SPELLTYPE_RELEASE_ID__ macro; SERVER_ROLE selects the api or game
# runtime from the same image.
# syntax=docker/dockerfile:1
ARG BUN_IMAGE=oven/bun:1.4.2-slim
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /dependencies
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --production --frozen-lockfile --ignore-scripts

FROM ${BUN_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY app/ ./dist/
COPY drizzle/ ./drizzle/
COPY --from=dependencies /dependencies/node_modules ./node_modules
USER bun
EXPOSE 3000 3001
CMD ["bun", "dist/server/index.js"]
