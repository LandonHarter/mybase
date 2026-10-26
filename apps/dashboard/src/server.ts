// Framework is TBD; for now Bun serves and bundles a plain HTML + TS page.
import index from "./index.html";

const server = Bun.serve({
  port: Number(process.env.DASHBOARD_PORT ?? 4001),
  routes: { "/": index },
  development: true,
});

console.log(`mybase dashboard on ${server.url}`);
