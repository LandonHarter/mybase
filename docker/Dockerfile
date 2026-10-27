# mybase control plane: the API, serving the pre-built dashboard. Build from the repo root:
#   docker build -f docker/Dockerfile -t mybase .
#
# The build stage outputs plain JS/CSS, so it runs once on the build machine's
# native platform. Only the small runtime stage is per-arch (amd64 + arm64),
# which avoids slow emulated builds.

# Set automatically by BuildKit. The legacy builder needs --build-arg BUILDPLATFORM=linux/amd64 (or arm64).
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build
WORKDIR /src

# Manifests first so the dependency layer is cached across source changes.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run --cwd apps/dashboard build \
 && bun build apps/api/src/index.ts --target bun --minify --outfile dist/api.js \
 && bun build packages/sdk/src/analytics-script.ts --target browser --format iife --minify --outfile dist/analytics.js

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=build /src/dist/api.js ./api.js
COPY --from=build /src/apps/dashboard/dist ./dashboard
COPY --from=build /src/dist/analytics.js ./analytics.js

ENV NODE_ENV=production \
    API_PORT=4000 \
    DASHBOARD_DIR=/app/dashboard \
    ANALYTICS_SCRIPT=/app/analytics.js \
    LOG_FORMAT=json

USER bun
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
CMD ["bun", "api.js"]
