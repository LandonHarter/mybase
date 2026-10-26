import type { CreateProjectRequest, Project } from "@mybase/shared";

// In-memory registry until the metadata store is decided (see CLAUDE.md).
const projects = new Map<string, Project>();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

const server = Bun.serve({
  port: Number(process.env.API_PORT ?? 4000),
  routes: {
    "/health": () => json({ ok: true }),
    "/projects": {
      GET: () => json([...projects.values()]),
      POST: async (req) => {
        const { name } = (await req.json()) as CreateProjectRequest;
        if (!name) return json({ error: "name is required" }, 400);
        if (projects.has(name)) return json({ error: `project "${name}" already exists` }, 409);
        // TODO: provision Postgres database + role and storage bucket.
        const project: Project = { name, createdAt: new Date().toISOString() };
        projects.set(name, project);
        return json(project, 201);
      },
      OPTIONS: () => new Response(null, { headers: cors }),
    },
  },
  fetch: () => json({ error: "not found" }, 404),
});

console.log(`mybase api listening on ${server.url}`);
