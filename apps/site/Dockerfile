# docs site + landing page, hosted on mybase (`mybase deploy` from apps/site).
# Built from the repo root (mybase.config.ts sets context: "../.."): sync-docs.ts reads docs/,
# packages/sdk/docs, and apps/api/src/docs.ts, and bun.lock covers the whole workspace.
FROM node:22-alpine AS build
COPY --from=oven/bun:1.3-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src

# Manifests first so the dependency layer is cached across source changes.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/sandbox-worker/package.json apps/sandbox-worker/
COPY apps/hosting-worker/package.json apps/hosting-worker/
COPY apps/site/package.json apps/site/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p apps/site/public && bun run --cwd apps/site build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /src/apps/site/.next/standalone ./
COPY --from=build --chown=app:app /src/apps/site/.next/static ./apps/site/.next/static
COPY --from=build --chown=app:app /src/apps/site/public ./apps/site/public
USER app
EXPOSE 3000
CMD ["node", "apps/site/server.js"]
