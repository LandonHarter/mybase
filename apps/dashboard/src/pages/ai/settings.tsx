import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AiSettings, UpdateAiSettingsRequest } from "@mybase-dev/sdk/ai";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { DangerZone } from "@/components/service-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorMessage, invalidate } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";
import { usd } from "./parts";

const mono = (t: string) => <code className="font-mono text-[0.85em]">{t}</code>;

export function AiSettingsTab({ project, settings, onSaved }: { project: string; settings: AiSettings; onSaved: () => void }) {
  const [off, setOff] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  async function save(field: string, input: UpdateAiSettingsRequest) {
    setPending(field);
    try {
      await api.updateAiSettings(project, input);
      toast.success("Saved");
      invalidate(`ai-settings:${project}`);
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    } finally {
      setPending(null);
    }
  }
  const submit = (field: string, build: (f: FormData) => UpdateAiSettingsRequest) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void save(field, build(new FormData(e.currentTarget)));
  };
  const saveButton = (field: string) => (
    <Button type="submit" variant="outline" size="sm" disabled={pending === field}>
      {pending === field ? "Saving…" : "Save"}
    </Button>
  );

  async function turnOff() {
    await api.disableService(project, "ai");
    await refreshProjects();
    toast.success(`Turned off the AI gateway for ${project}`);
    navigate({ page: "project", name: project });
  }

  return (
    <>
      <Row
        id="budget"
        title="Monthly budget"
        hint={
          <>
            Spent this month (UTC): {usd(settings.monthToDateUsd)}. An {mono("ai.budget_threshold")} audit event fires once at the alert level; alerts can notify you.
          </>
        }
      >
        <form
          className="grid gap-3"
          onSubmit={submit("budget", (f) => ({
            budgetUsd: String(f.get("budget") ?? "").trim() === "" ? null : Number(f.get("budget")),
            budgetSoftPct: Number(f.get("soft")),
            budgetHard: f.get("hard") === "on",
          }))}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">$</span>
            <Input name="budget" type="number" min={0} step="any" defaultValue={settings.budgetUsd ?? ""} placeholder="No budget" className="w-32" aria-label="Budget in USD" />
            <span className="text-muted-foreground">alert at</span>
            <Input name="soft" type="number" min={1} max={100} defaultValue={settings.budgetSoftPct} className="w-20" aria-label="Alert percentage" />
            <span className="text-muted-foreground">%</span>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="hard" defaultChecked={settings.budgetHard} className="size-4 accent-primary" />
            Refuse calls (429) once it's spent
          </label>
          <div>{saveButton("budget")}</div>
        </form>
      </Row>

      <Row
        id="capture"
        title="Content capture"
        hint="Store each call's prompt and response (encrypted with MYBASE_SECRETS_KEY) to read in the logs. Off by default: they're your users' data."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={settings.captureContent}
            onCheckedChange={(v) => void save("capture", { captureContent: v })}
            aria-label="Content capture"
            disabled={pending === "capture"}
          />
          <span>{settings.captureContent ? "On" : "Off"}</span>
          <form className="flex items-center gap-2" onSubmit={submit("content-retention", (f) => ({ contentRetentionDays: Number(f.get("days")) }))}>
            <span className="text-muted-foreground">keep for</span>
            <Input name="days" type="number" min={1} max={90} defaultValue={settings.contentRetentionDays} className="w-20" aria-label="Content retention days" />
            <span className="text-muted-foreground">days</span>
            {saveButton("content-retention")}
          </form>
        </div>
      </Row>

      <Row id="retention" title="Log retention" hint="How long call metadata stays in the log. Usage charts keep hourly totals for 400 days.">
        <form className="flex items-center gap-2" onSubmit={submit("log-retention", (f) => ({ logRetentionDays: Number(f.get("days")) }))}>
          <Input name="days" type="number" min={1} max={365} defaultValue={settings.logRetentionDays} className="w-24" aria-label="Log retention days" />
          <span className="text-muted-foreground">days</span>
          {saveButton("log-retention")}
        </form>
      </Row>

      <Row
        id="allowed"
        title="Allowed models"
        hint={
          <>
            Model ids or globs apps may call, one per line ({mono("openai/*")}, {mono("fast")}). Empty: any model.
          </>
        }
      >
        <form
          className="grid gap-2"
          onSubmit={submit("allowed", (f) => {
            const list = String(f.get("models") ?? "")
              .split(/[\n,]/)
              .map((s) => s.trim())
              .filter(Boolean);
            return { allowedModels: list.length ? list : null };
          })}
        >
          <Textarea name="models" rows={3} defaultValue={settings.allowedModels?.join("\n") ?? ""} placeholder="Any model" className="font-mono" aria-label="Allowed models" />
          <div>{saveButton("allowed")}</div>
        </form>
      </Row>

      <Row
        id="ratelimit"
        title="Rate limit"
        hint="A rule from Rate limits, checked before each call. Per end user counts the user id apps send (mybase.user or OpenAI's user field)."
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={submit("ratelimit", (f) => ({ ratelimitRule: String(f.get("rule") ?? "").trim() || null, ratelimitBy: f.get("by") === "user" ? "user" : "token" }))}
        >
          <Input name="rule" defaultValue={settings.ratelimitRule ?? ""} placeholder="No limit" className="w-44 font-mono" aria-label="Rate limit rule" />
          <Select name="by" defaultValue={settings.ratelimitBy} aria-label="Count per" wrapperClassName="w-40">
            <option value="token">per API key</option>
            <option value="user">per end user</option>
          </Select>
          {saveButton("ratelimit")}
        </form>
      </Row>

      <Row id="keys-env" title="Keys environment" hint="The secrets env provider keys are read from.">
        <form className="flex items-center gap-2" onSubmit={submit("keys-env", (f) => ({ keysEnv: String(f.get("env") ?? "").trim() }))}>
          <Input name="env" defaultValue={settings.keysEnv} required className="w-40 font-mono" aria-label="Keys environment" />
          {saveButton("keys-env")}
        </form>
      </Row>

      <DangerZone
        title="Delete AI gateway data and turn off"
        action={
          <Button variant="danger-outline" onClick={() => setOff(true)}>
            Turn off the AI gateway…
          </Button>
        }
      >
        {SERVICE_PAGES.ai.turnOff}
      </DangerZone>
      <ConfirmDialog
        open={off}
        onOpenChange={setOff}
        title={`Turn off the AI gateway for ${project}`}
        description={SERVICE_PAGES.ai.turnOff}
        confirm="Turn off the AI gateway"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}
