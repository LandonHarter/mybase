import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Project } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";

// Same bounds as CAPTCHA_LIMITS in the SDK; the API checks them.
const DIFFICULTY = { min: 1_000, max: 1_000_000 };

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const formSnippet = (scriptUrl: string, project: string) => `<script defer src="${scriptUrl}" data-project="${project}"></script>

<form method="post" action="/signup" data-mybase-captcha>
  <input name="email" type="email" required>
  <span class="mybase-captcha-status"></span>
  <button>Sign up</button>
</form>
<!-- The form is sent with a hidden "mybase-captcha" field holding the token. -->`;

const serverSnippet = (apiUrl: string, project: string) => `import { createCaptchaClient } from "@mybase-dev/sdk/captcha";

const captcha = createCaptchaClient({ apiUrl: "${apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! });

const { success } = await captcha.verify(form.get("mybase-captcha"));
if (!success) return new Response("Please try again", { status: 400 });`;

const betterAuthSnippet = (apiUrl: string, project: string) => `import { captcha } from "better-auth/plugins";
import { mybaseCaptcha } from "@mybase-dev/sdk/better-auth";

plugins: [captcha(mybaseCaptcha({ apiUrl: "${apiUrl}", project: "${project}", secretKey: process.env.MYBASE_CAPTCHA_SECRET! }))]

// Client: solve, then send the token in the x-captcha-response header
const token = await window.mybase.captcha.solve();
await authClient.signUp.email({ email, password, name }, { headers: { "x-captcha-response": token } });`;

function Captcha({ project }: { project: Project }) {
  const name = project.name;
  const { state, refresh } = useLoad(`captcha:${name}`, () => api.captchaSettings(name));
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"off" | "rotate" | null>(null);
  const { min, max } = DIFFICULTY;

  const saveDifficulty = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const n = Number(new FormData(e.currentTarget).get("maxNumber"));
    try {
      await api.updateCaptcha(name, n);
      toast.success(`Challenges now take up to ${n.toLocaleString()} tries`);
      void refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  async function turnOff() {
    try {
      await api.disableService(name, "captcha");
      await refreshProjects();
      toast.success(`Turned off captcha for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off captcha: ${errorMessage(err)}`);
    }
  }

  const apiUrl = state.status === "ready" ? state.data.scriptUrl.replace(/\/captcha\.js$/, "") : "";

  return (
    <>
      <PageHeader
        title="Captcha"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="Proof-of-work bot checks: the browser does a moment of math, nobody solves a puzzle. No cookies, no third party."
      />
      {state.status === "loading" && <LoadingLines label="Loading captcha settings" lines={4} />}
      {state.status === "error" && <LoadError what="captcha settings" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" && (
        <>
          <section aria-labelledby="captcha-use" className="mb-10">
            <h2 id="captcha-use" className="mb-3 text-base font-semibold">
              Use it
            </h2>
            <Row title="On a form" hint="The script holds the submit until the check is done, then adds the token.">
              {code(formSnippet(state.data.scriptUrl, name))}
            </Row>
            <Row title="On your server" hint="Check the token once, with an API key that has captcha:write. A token works one time, for 5 minutes.">
              {code(serverSnippet(apiUrl, name))}
            </Row>
            <Row title="With Better Auth" hint="Its captcha plugin calls mybase instead of Cloudflare.">
              {code(betterAuthSnippet(apiUrl, name))}
            </Row>
          </section>
          <section aria-labelledby="captcha-settings" className="mb-10">
            <h2 id="captcha-settings" className="mb-3 text-base font-semibold">
              Settings
            </h2>
            <Row title="Secret" hint="For Better Auth (secretKey) or Turnstile-style siteverify calls. Server-side only.">
              <div className="grid gap-3">
                <CopyField id="captcha-secret" label="MYBASE_CAPTCHA_SECRET" value={state.data.secretKey} secret />
                <div>
                  <Button variant="outline" size="sm" onClick={() => setDialog("rotate")}>
                    Rotate secret
                  </Button>
                </div>
              </div>
            </Row>
            <Row title="Difficulty" hint={`Numbers the browser may try per challenge (${min.toLocaleString()}–${max.toLocaleString()}). Higher costs bots more and slow phones a bit longer.`}>
              <form onSubmit={saveDifficulty} className="flex flex-wrap items-center gap-2">
                <Input key={state.data.maxNumber} name="maxNumber" type="number" min={min} max={max} step={1000} defaultValue={state.data.maxNumber} className="w-36" aria-label="Difficulty" />
                <Button type="submit" variant="outline">
                  Save
                </Button>
                {error && (
                  <p role="alert" className="w-full text-destructive">
                    {error}
                  </p>
                )}
              </form>
            </Row>
          </section>
        </>
      )}
      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off captcha
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Forms that check the captcha refuse every submission until you remove the check.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off captcha
          </Button>
        </div>
      </section>
      <ConfirmDialog
        open={dialog === "rotate"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Rotate the captcha secret"
        description="The old secret stops working now: update MYBASE_CAPTCHA_SECRET wherever your server uses it."
        confirm="Rotate secret"
        pendingLabel="Rotating…"
        onConfirm={async () => {
          await api.rotateCaptchaSecret(name);
          toast.success("Rotated the captcha secret");
          void refresh();
        }}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off captcha for ${name}`}
        description={SERVICE_PAGES.captcha.turnOff}
        confirm="Turn off captcha"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

export function CaptchaPage({ name }: { name: string }) {
  return (
    <ProjectGate name={name} title="Captcha" backToProject>
      {(project) => {
        if (!project.services.includes("captcha")) {
          return (
            <ServiceOff project={project} id="captcha">
              Turn it on to check your forms for bots without puzzles or a third party: the browser proves a moment of work, and your server checks it once.
            </ServiceOff>
          );
        }
        return <Captcha project={project} />;
      }}
    </ProjectGate>
  );
}
