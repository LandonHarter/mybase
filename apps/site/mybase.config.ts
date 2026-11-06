import { defineConfig } from "@mybase-dev/sdk/config";

// `mybase deploy` from apps/site. The image builds from the repo root (see Dockerfile).
export default defineConfig({
  project: "usemybase",
  hosting: {
    sites: {
      web: {
        port: 3000,
        healthPath: "/",
        context: "../..",
        dockerfile: "apps/site/Dockerfile",
        domains: ["usemybase.dev", "www.usemybase.dev"],
      },
    },
  },
});
