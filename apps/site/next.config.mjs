import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const root = resolve(import.meta.dirname, "../..");

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
};

export default withMDX(config);
