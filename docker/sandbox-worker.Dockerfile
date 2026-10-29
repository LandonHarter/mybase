ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/sandbox-worker/package.json apps/sandbox-worker/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile
COPY apps/sandbox-worker/src apps/sandbox-worker/src
COPY packages/shared/src packages/shared/src
COPY packages/sdk/src packages/sdk/src
RUN bun build apps/sandbox-worker/src/index.ts --target bun --outfile worker.js

FROM docker:28-cli AS docker-cli
FROM oven/bun:1.3-alpine
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /src/worker.js /app/worker.js
ENV MYBASE_SANDBOX_WORKER_BIND=0.0.0.0 LOG_FORMAT=json
# Trusted worker needs Docker access. This socket never enters a guest.
WORKDIR /app
CMD ["bun", "worker.js"]
