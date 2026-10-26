// Builds the dashboard to static files in dist/, which the API serves in the Docker image.
import tailwind from "bun-plugin-tailwind";
import { createLogger } from "@mybase/shared/logger";

const log = createLogger("dashboard");
const outdir = new URL("./dist", import.meta.url).pathname;

const result = await Bun.build({
  entrypoints: [new URL("./src/index.html", import.meta.url).pathname],
  outdir,
  plugins: [tailwind],
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const message of result.logs) log.error("build failed", { message: String(message) });
  process.exit(1);
}

log.info("built", { outdir, files: result.outputs.length });
