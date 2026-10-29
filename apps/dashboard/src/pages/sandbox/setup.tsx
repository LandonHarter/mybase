import { useState } from "react";
import { BookOpen, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { KeyDialog } from "@/components/api-tokens";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { navigate, type SandboxAction } from "@/lib/router";
import { cn } from "@/lib/utils";
import { codeClass, docLink, focus, type SandboxRoute } from "./shared";

export function Setup({ route }: { route: SandboxRoute }) {
  const [error, setError] = useState<string>();
  const action = (value?: SandboxAction) => navigate({ ...route, action: value }, { replace: true });
  const snippet = `import { createSandboxClient } from "@mybase-dev/sdk/sandbox";

const sandboxes = createSandboxClient({
  apiUrl: ${JSON.stringify(window.location.origin)},
  project: ${JSON.stringify(route.name)},
  apiKey: process.env.MYBASE_API_KEY!,
});

const box = await sandboxes.create({ key: crypto.randomUUID(), ttlSeconds: 180 });
try {
  const ready = await sandboxes.wait(box.id);
  if (ready.state !== "ready") throw new Error(ready.reason ?? ready.state);
  const run = await sandboxes.execute(box.id, {
    key: "hello", code: 'console.log("Hello from the sandbox")',
  });
  const result = await sandboxes.waitExecution(box.id, run.id);
  if (result.state !== "success") throw new Error(result.stderr || result.state);
  console.log(result.stdout);
} finally {
  await sandboxes.terminate(box.id);
}`;
  async function turnOff() {
    try {
      await api.disableService(route.name, "sandbox");
      await refreshProjects();
      toast.success("Turned off agent sandboxes");
      navigate({ page: "project", name: route.name });
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-dashed p-4 text-destructive">
          {error}
        </p>
      )}
      <section aria-labelledby="sandbox-connect" className="mb-8">
        <h2 id="sandbox-connect" className="mb-3 text-base font-semibold">
          Connect your app
        </h2>
        <Row title="API key" hint="Use sandbox:write scoped to this project. Keep keys and model credentials in your server, outside guest code.">
          <Button variant="outline" onClick={() => action("key")}>
            <KeyRound />
            Create API key
          </Button>
        </Row>
        <Row title="TypeScript SDK" hint="Install @mybase-dev/sdk. Your app owns the model, prompts, and agent loop.">
          <pre tabIndex={0} className={cn(codeClass, focus)}>
            {snippet}
          </pre>
        </Row>
        <Row title="Host setup" hint="Run once on the Linux Docker host, not your laptop if Docker runs elsewhere.">
          <CopyField id="sandbox-host-setup" label="Command" value={`mybase server sandbox --project ${route.name}`} />
        </Row>
        <Row title="Service guides" hint="Setup, isolation, resource controls, file exports, and browser connections.">
          <div className="flex flex-col items-start gap-3">
            {(
              [
                ["sandboxes", "Agent sandboxes", false],
                ["sandbox-dashboard", "Dashboard and run history", false],
                ["sandboxes", "SDK and browser automation", true],
              ] as const
            ).map(([slug, title, sdk]) => (
              <a
                key={`${slug}:${sdk}`}
                href={docLink(slug, sdk)}
                className={cn("flex items-center gap-2 rounded-sm underline-offset-4 hover:underline", focus)}
              >
                <BookOpen className="size-4" />
                {title}
              </a>
            ))}
          </div>
        </Row>
      </section>
      <section aria-labelledby="sandbox-disable">
        <h2 id="sandbox-disable" className="mb-3 text-base font-semibold">
          Turn off agent sandboxes
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Stops every guest and deletes sandbox artifacts and execution history for this project.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => action("off")}>
            Turn off agent sandboxes
          </Button>
        </div>
      </section>
      <KeyDialog
        open={route.action === "key"}
        onOpenChange={(open) => !open && action()}
        preset={{ name: `${route.name} sandboxes`, permissions: ["sandbox:write"], projects: [route.name] }}
      />
      <ConfirmDialog
        open={route.action === "off"}
        onOpenChange={(open) => !open && action()}
        title={`Turn off agent sandboxes for ${route.name}`}
        description={SERVICE_PAGES.sandbox.turnOff}
        confirm="Turn off agent sandboxes"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}
