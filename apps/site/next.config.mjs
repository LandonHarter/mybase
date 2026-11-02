import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // @mybase/shared ships TypeScript source.
  transpilePackages: ["@mybase/shared"],
};

export default withMDX(config);
