import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const root = resolve(import.meta.dirname, "../..");
const raw = "https://raw.githubusercontent.com/LandonHarter/mybase/master";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // @mybase/shared ships TypeScript source.
  transpilePackages: ["@mybase/shared"],
  // Self-contained server for the Docker image (Dockerfile). Traced from the repo root, so the
  // workspace packages it imports are included: the server lands at .next/standalone/apps/site.
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  // Short URLs for files served from the repo: `curl -fsSL https://usemybase.dev/install.sh | sh`.
  // Temporary redirects (curl -L follows them), so the target can change later.
  async redirects() {
    return [
      { source: "/install.sh", destination: `${raw}/scripts/install.sh`, permanent: false },
      { source: "/install", destination: `${raw}/scripts/install.sh`, permanent: false },
      { source: "/compose.yml", destination: `${raw}/docker/compose.yml`, permanent: false },
    ];
  },
};

export default withMDX(config);
