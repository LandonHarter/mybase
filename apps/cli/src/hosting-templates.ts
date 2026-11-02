// Starter Dockerfiles for `mybase hosting init`. Each one builds on the dev machine (`mybase
// deploy`), listens on $PORT, and runs as a non-root user.

export const TEMPLATES = ["nextjs", "static", "node"] as const;
export type Template = (typeof TEMPLATES)[number];

// Installs with whichever lockfile the app has.
const install = `RUN if [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then corepack enable yarn && yarn install --frozen-lockfile; \\
    elif [ -f package-lock.json ]; then npm ci; \\
    elif [ -f bun.lock ]; then npm install -g bun && bun install --frozen-lockfile; \\
    else npm install; fi`;

const lockfiles = "COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* bun.lock* ./";

export const DOCKERFILES: Record<Template, string> = {
  // Needs `output: "standalone"` in next.config (the server bundle + only the node_modules it uses).
  nextjs: `# Next.js, built with output: "standalone" (set it in next.config).
FROM node:22-alpine AS deps
WORKDIR /app
${lockfiles}
${install}

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p public && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
CMD ["node", "server.js"]
`,
  // Vite, Astro, plain HTML…: build to dist/ (change OUT_DIR), served by Caddy with SPA fallback.
  static: `# Static site: \`npm run build\` writes OUT_DIR, Caddy serves it on :3000.
FROM node:22-alpine AS build
WORKDIR /app
${lockfiles}
${install}
COPY . .
RUN npm run build

FROM caddy:2.10.2-alpine
ARG OUT_DIR=dist
COPY --from=build /app/\${OUT_DIR} /srv
RUN printf '{\\n  admin off\\n  persist_config off\\n}\\n:3000 {\\n  root * /srv\\n  encode gzip\\n  try_files {path} {path}/ /index.html\\n  file_server\\n}\\n' > /etc/caddy/Caddyfile
ENV XDG_CONFIG_HOME=/tmp XDG_DATA_HOME=/tmp
USER nobody
EXPOSE 3000
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
`,
  // Any Bun or Node HTTP server started by `npm start` / `bun run start` that reads $PORT.
  node: `# Bun or Node server: \`bun run start\` must listen on $PORT.
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock* package-lock.json* ./
RUN bun install --production
COPY . .
ENV NODE_ENV=production PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
`,
};

export const DOCKERIGNORE = `node_modules
.git
.next
dist
.env
.env.*
!.env.example
npm-debug.log*
Dockerfile
.dockerignore
`;

export const configFile = (project: string, site: string) => `import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: ${JSON.stringify(project)},
  hosting: {
    // \`mybase deploy\` builds ./Dockerfile and runs it at https://${site}.<your domain>.
    sites: { ${JSON.stringify(site)}: { port: 3000 } },
  },
});
`;
