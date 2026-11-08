import { useState } from "react";
import type { DatabaseAccess, Project } from "@mybase/shared";
import { CodeBlock } from "@/components/code-block";
import { ConnectMethod, ConnectSheet } from "@/components/service-layout";
import { InlineCode, Mono } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { LinesSkeleton } from "@/components/states";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/load";
import { href } from "@/lib/router";

type Where = "hosted" | "server" | "remote";
type Format = "uri" | "psql" | "env" | "prisma" | "drizzle";
type RouteId = DatabaseAccess["routes"][number]["route"];

const ROUTE_LABELS: Record<string, string> = {
  internal: "Hosting network",
  localhost: "This server",
  lan: "LAN",
  tailscale: "Tailscale",
  public: "Internet",
  proxy: "WebSocket",
};

/** The route an app in `where` should use, from the routes that are available. */
function routeFor(where: Where, access: DatabaseAccess): RouteId {
  const on = (r: RouteId) => access.routes.some((x) => x.route === r && x.on);
  if (where === "hosted" && on("internal")) return "internal";
  if (where === "server") return on("lan") ? "lan" : on("localhost") ? "localhost" : "proxy";
  return on("public") ? "public" : on("tailscale") ? "tailscale" : "proxy";
}

function url(project: Project, access: DatabaseAccess, route: RouteId) {
  const db = project.database;
  if (route === "proxy") return null;
  const r = access.routes.find((x) => x.route === route);
  const host = r?.host || db.host;
  const port = r?.port || db.port;
  const tls = route === "public" && access.public.tlsActive;
  return `postgresql://${db.user}:<password>@${host}:${port}/${db.name}${tls ? "?sslmode=require" : route === "internal" ? "?sslmode=disable" : ""}`;
}

function snippet(format: Format, value: string) {
  switch (format) {
    case "uri":
      return value;
    case "psql":
      return `psql "${value}"`;
    case "env":
      return `DATABASE_URL=${value}`;
    case "prisma":
      return `// schema.prisma\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\n// .env\nDATABASE_URL="${value}"`;
    case "drizzle":
      return `import { drizzle } from "drizzle-orm/node-postgres";\n\n// DATABASE_URL=${value}\nexport const db = drizzle(process.env.DATABASE_URL!);`;
  }
}

/**
 * The connection-string builder (DB17): where the app runs → the route to use, then the format.
 * The password was shown once at creation, so `<password>` is a placeholder (CodeBlock marks it).
 */
export function ConnectionBuilder({ project }: { project: Project }) {
  const access = useLoad(`db-access:${project.name}`, () => api.databaseAccess(project.name), { maxAge: 60_000 });
  const [where, setWhere] = useState<Where>("server");
  const [picked, setPicked] = useState<RouteId | null>(null);
  const [format, setFormat] = useState<Format>("uri");
  if (access.state.status === "loading") return <LinesSkeleton label="Loading routes" />;
  if (access.state.status === "error") return <p className="text-muted-foreground">Couldn't load the routes: {access.state.message}</p>;
  const a = access.state.data;
  const route = picked ?? routeFor(where, a);
  const value = url(project, a, route);
  const available = a.routes.filter((r) => r.on);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <span className="font-medium">Where will your app run?</span>
        <SegmentedControl
          label="Where your app runs"
          value={where}
          onChange={(w) => {
            setWhere(w);
            setPicked(null);
          }}
          options={[
            { value: "hosted", label: "A site hosted here" },
            { value: "server", label: "This server or LAN" },
            { value: "remote", label: "Remote / serverless" },
          ]}
        />
      </div>
      <div className="grid gap-1.5">
        <span className="font-medium">Route</span>
        <SegmentedControl label="Route" size="xs" className="w-fit flex-wrap" value={route} onChange={(r) => setPicked(r)} options={available.map((r) => ({ value: r.route, label: ROUTE_LABELS[r.route] ?? r.route, title: r.note }))} />
      </div>
      {value ? (
        <>
          <SegmentedControl label="Format" size="xs" className="w-fit" value={format} onChange={setFormat} options={(["uri", "psql", "env", "prisma", "drizzle"] as const).map((f) => ({ value: f, label: f === "uri" ? "URI" : f === "env" ? ".env" : f[0]!.toUpperCase() + f.slice(1) }))} />
          <CodeBlock code={snippet(format, value)} lang={format === "uri" || format === "env" ? "env" : format === "psql" ? "bash" : "ts"} wrap={format === "uri"} />
        </>
      ) : (
        <div className="grid gap-2">
          <p className="text-muted-foreground">
            Over WebSocket, for hosts that can't open TCP (Vercel, Cloudflare). Use <InlineCode>@neondatabase/serverless</InlineCode> with this proxy and <InlineCode>ssl: false</InlineCode>, or run{" "}
            <InlineCode>mybase db proxy</InlineCode> locally.
          </p>
          <CodeBlock code={`import { neonConfig, Pool } from "@neondatabase/serverless";\n\nneonConfig.wsProxy = () => "${a.wsUrl.replace(/^wss?:\/\//, "")}";\nneonConfig.useSecureWebSocket = ${a.wsUrl.startsWith("wss")};\nneonConfig.pipelineConnect = false;\n\n// DATABASE_URL=postgresql://${project.database.user}:<password>@${project.database.host}:${project.database.port}/${project.database.name}\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });`} lang="ts" />
        </div>
      )}
      <p className="text-muted-foreground">
        The password was shown once, when the project was created. Don't paste it around:{" "}
        {project.services.includes("secrets") ? (
          <>
            store it with <InlineCode>mybase secrets link -p {project.name} -e prod --database</InlineCode> (rotates it and resolves the right route for each reader).
          </>
        ) : (
          <>
            <a className="underline underline-offset-2" href={href({ page: "secrets", name: project.name, env: null })}>
              turn on secrets
            </a>{" "}
            and link it, which rotates the password and keeps it encrypted.
          </>
        )}
      </p>
    </div>
  );
}

/** The Connect button on every database view (DB17). */
export function DatabaseConnect({ project }: { project: Project }) {
  return (
    <ConnectSheet title={`Connect to ${project.displayName || project.name}'s database`} description={<>Postgres database <Mono>{project.database.name}</Mono>, role <Mono>{project.database.user}</Mono>.</>}>
      <ConnectMethod title="Connection string">
        <ConnectionBuilder project={project} />
      </ConnectMethod>
    </ConnectSheet>
  );
}
